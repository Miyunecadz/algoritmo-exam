import { closeTestApp, createTestApp, TestContext } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { asOrg, MONEY_STRING, ORG_A } from './helpers/fixtures';

interface LedgerRow {
  id: string;
  type: string;
  amount: string;
  payment_id: string | null;
  created_at: string;
}

/**
 * Required scenario 3 — balance and status stay correct across post -> partial pay -> full pay ->
 * reverse, and the ledger nets out to the balance the API reports.
 */
describe('Ledger lifecycle and reconciliation', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    await resetDatabase(context.dataSource);
  });

  const ledgerRows = (billId: string): Promise<LedgerRow[]> =>
    context.dataSource.query(
      `SELECT id, type, amount::text AS amount, payment_id, created_at
         FROM ledger_entries WHERE bill_id = $1 ORDER BY created_at ASC, type ASC`,
      [billId],
    );

  it('tracks balance and status through the full lifecycle', async () => {
    const client = asOrg(context.baseUrl, ORG_A);

    const draft = await client.post('/bills', { amountDue: '100.00' }).expect(201);
    const billId = draft.body.id as string;
    expect(draft.body.status).toBe('DRAFT');
    expect(draft.body.balance).toBe('0.00');
    expect(draft.body.amountPaid).toBe('0.00');
    expect(await ledgerRows(billId)).toHaveLength(0);

    const posted = await client.post(`/bills/${billId}/post`).expect(200);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.balance).toBe('100.00');
    expect(await ledgerRows(billId)).toHaveLength(1);

    const partial = await client
      .post('/payments', { billId, amount: '40.00', externalRef: 'REF-A' })
      .expect(201);
    expect(partial.body.bill.status).toBe('POSTED');
    expect(partial.body.bill.balance).toBe('60.00');

    const full = await client
      .post('/payments', { billId, amount: '60.00', externalRef: 'REF-B' })
      .expect(201);
    expect(full.body.bill.status).toBe('PAID');
    expect(full.body.bill.balance).toBe('0.00');
    expect(full.body.bill.amountPaid).toBe('100.00');

    const creditRows = await ledgerRows(billId);
    const originalCredit = creditRows.find(
      (row) => row.type === 'PAYMENT_RECEIVED' && row.payment_id === full.body.payment.id,
    );
    expect(originalCredit).toBeDefined();

    const reversed = await client.delete(`/payments/${full.body.payment.id}`).expect(200);
    expect(reversed.body.bill.status).toBe('POSTED');
    expect(reversed.body.bill.balance).toBe('60.00');
    expect(reversed.body.bill.amountPaid).toBe('40.00');
    expect(reversed.body.payment.reversedAt).not.toBeNull();

    const rows = await ledgerRows(billId);
    expect(rows.map((row) => row.type)).toEqual([
      'BILL_POSTED',
      'PAYMENT_RECEIVED',
      'PAYMENT_RECEIVED',
      'PAYMENT_REVERSED',
    ]);

    // The reversal is a new row: the original credit is byte-for-byte untouched.
    const afterReversal = rows.find((row) => row.id === originalCredit!.id);
    expect(afterReversal).toEqual(originalCredit);

    // The ledger nets out to exactly the balance the API reports.
    const [sum] = await context.dataSource.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2)::text AS total
         FROM ledger_entries WHERE bill_id = $1`,
      [billId],
    );
    expect(sum.total).toBe('60.00');

    // The payment is soft-deleted, not gone.
    const [payment] = await context.dataSource.query(
      `SELECT deleted_at FROM payments WHERE id = $1`,
      [full.body.payment.id],
    );
    expect(payment.deleted_at).not.toBeNull();

    const finalBill = await client.get(`/bills/${billId}`).expect(200);
    for (const field of ['amountDue', 'balance', 'amountPaid'] as const) {
      expect(typeof finalBill.body[field]).toBe('string');
      expect(finalBill.body[field]).toMatch(MONEY_STRING);
    }
    expect(finalBill.body.balance).toBe('60.00');
    expect(finalBill.body.amountPaid).toBe('40.00');
  });

  it('reverses one of two payments without disturbing the other', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const draft = await client.post('/bills', { amountDue: '100.00' }).expect(201);
    const billId = draft.body.id as string;
    await client.post(`/bills/${billId}/post`).expect(200);

    const first = await client
      .post('/payments', { billId, amount: '40.00', externalRef: 'REF-X' })
      .expect(201);
    await client.post('/payments', { billId, amount: '30.00', externalRef: 'REF-Y' }).expect(201);

    const reversed = await client.delete(`/payments/${first.body.payment.id}`).expect(200);
    expect(reversed.body.bill.balance).toBe('70.00');
    expect(reversed.body.bill.status).toBe('POSTED');
    expect(reversed.body.bill.amountPaid).toBe('30.00');
  });

  it('allows overpayment and reports the credit as a negative balance', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const draft = await client.post('/bills', { amountDue: '100.00' }).expect(201);
    const billId = draft.body.id as string;
    await client.post(`/bills/${billId}/post`).expect(200);

    const overpaid = await client
      .post('/payments', { billId, amount: '150.00', externalRef: 'REF-OVER' })
      .expect(201);

    expect(overpaid.body.bill.status).toBe('PAID');
    expect(overpaid.body.bill.balance).toBe('-50.00');
    expect(overpaid.body.bill.balance).toMatch(MONEY_STRING);
  });

  it('keeps exact cents that a float would lose', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const draft = await client.post('/bills', { amountDue: '0.30' }).expect(201);
    const billId = draft.body.id as string;
    await client.post(`/bills/${billId}/post`).expect(200);

    await client.post('/payments', { billId, amount: '0.10', externalRef: 'C-1' }).expect(201);
    const paid = await client
      .post('/payments', { billId, amount: '0.20', externalRef: 'C-2' })
      .expect(201);

    // 0.1 + 0.2 === 0.30000000000000004 as doubles. Exact here, in Postgres numeric.
    expect(paid.body.bill.balance).toBe('0.00');
    expect(paid.body.bill.status).toBe('PAID');
  });
});
