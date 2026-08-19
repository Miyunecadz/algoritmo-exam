import { closeTestApp, createTestApp, TestContext } from './helpers/app';
import { countRows, resetDatabase } from './helpers/db';
import { asOrg, createPostedBill, ORG_A } from './helpers/fixtures';

/**
 * Required scenario 2 — replaying an `externalRef` must never double-credit the bill.
 */
describe('Idempotent ingestion', () => {
  let context: TestContext;
  let billId: string;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    await resetDatabase(context.dataSource);
    billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
  });

  it('creates once and replays thereafter', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const body = { billId, amount: '40.00', externalRef: 'REF-1' };

    const first = await client.post('/payments', body).expect(201);
    const second = await client.post('/payments', body).expect(200);

    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    expect(second.body.payment.id).toBe(first.body.payment.id);
    expect(second.body.warnings).toEqual([]);

    expect(await countRows(context.dataSource, 'payments')).toBe(1);
    const [credits] = await context.dataSource.query(
      `SELECT count(*)::text FROM ledger_entries WHERE type = 'PAYMENT_RECEIVED'`,
    );
    expect(credits.count).toBe('1');

    // "60.00" not "20.00" — the double-credit failure mode.
    const bill = await client.get(`/bills/${billId}`).expect(200);
    expect(bill.body.balance).toBe('60.00');
    expect(bill.body.amountPaid).toBe('40.00');
  });

  it('surfaces a mismatched replay amount as a warning without changing anything', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const first = await client
      .post('/payments', { billId, amount: '40.00', externalRef: 'REF-2' })
      .expect(201);

    const replay = await client
      .post('/payments', { billId, amount: '55.00', externalRef: 'REF-2' })
      .expect(200);

    expect(replay.body.replayed).toBe(true);
    expect(replay.body.warnings).toEqual(['AMOUNT_MISMATCH_ON_REPLAY']);
    // The stored payment wins; the submitted amount is never applied.
    expect(replay.body.payment.amount).toBe('40.00');
    expect(replay.body.payment.id).toBe(first.body.payment.id);
    expect(replay.body.bill.balance).toBe('60.00');
    expect(await countRows(context.dataSource, 'payments')).toBe(1);
  });

  it('flags a replay that names a different bill', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const otherBill = await createPostedBill(context.baseUrl, ORG_A, '80.00');
    const created = await client
      .post('/payments', { billId, amount: '40.00', externalRef: 'REF-4' })
      .expect(201);

    const replay = await client
      .post('/payments', { billId: otherBill, amount: '40.00', externalRef: 'REF-4' })
      .expect(200);

    expect(replay.body.warnings).toEqual(['BILL_MISMATCH_ON_REPLAY']);
    expect(replay.body.payment.id).toBe(created.body.payment.id);
    expect(replay.body.bill.id).toBe(billId);
    expect(await countRows(context.dataSource, 'payments')).toBe(1);
  });

  it('replays a payment that already covered the bill, rather than 409-ing on PAID', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const body = { billId, amount: '100.00', externalRef: 'REF-FULL' };

    const first = await client.post('/payments', body).expect(201);
    expect(first.body.bill.status).toBe('PAID');

    // The commonest processor retry of all: the webhook for the payment that closed the bill. The
    // bill is no longer POSTED, but a known reference is a replay, never a state error.
    const replay = await client.post('/payments', body).expect(200);

    expect(replay.body.replayed).toBe(true);
    expect(replay.body.payment.id).toBe(first.body.payment.id);
    expect(replay.body.warnings).toEqual([]);
    expect(replay.body.bill.status).toBe('PAID');
    expect(replay.body.bill.balance).toBe('0.00');
    expect(replay.body.bill.amountPaid).toBe('100.00');

    expect(await countRows(context.dataSource, 'payments')).toBe(1);
    const [credits] = await context.dataSource.query(
      `SELECT count(*)::text FROM ledger_entries WHERE type = 'PAYMENT_RECEIVED'`,
    );
    expect(credits.count).toBe('1');
  });

  it('replays a reference recorded before the bill was voided', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const draft = await client.post('/bills', { amountDue: '50.00' }).expect(201);
    const otherBill = draft.body.id as string;
    await client.post(`/bills/${otherBill}/post`).expect(200);

    const created = await client
      .post('/payments', { billId: otherBill, amount: '10.00', externalRef: 'REF-VOIDED' })
      .expect(201);
    await client.delete(`/payments/${created.body.payment.id}`).expect(200);
    await client.post(`/bills/${otherBill}/void`).expect(200);

    const replay = await client
      .post('/payments', { billId: otherBill, amount: '10.00', externalRef: 'REF-VOIDED' })
      .expect(200);

    expect(replay.body.replayed).toBe(true);
    expect(replay.body.payment.id).toBe(created.body.payment.id);
    expect(replay.body.bill.status).toBe('VOID');
    expect(await countRows(context.dataSource, 'payments')).toBe(1);
  });

  it('reports every disagreement when a replay names both the wrong amount and the wrong bill', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const otherBill = await createPostedBill(context.baseUrl, ORG_A, '80.00');
    const created = await client
      .post('/payments', { billId, amount: '40.00', externalRef: 'REF-BOTH' })
      .expect(201);

    const replay = await client
      .post('/payments', { billId: otherBill, amount: '55.00', externalRef: 'REF-BOTH' })
      .expect(200);

    expect(replay.body.warnings).toEqual([
      'AMOUNT_MISMATCH_ON_REPLAY',
      'BILL_MISMATCH_ON_REPLAY',
    ]);
    expect(replay.body.payment.id).toBe(created.body.payment.id);
    expect(replay.body.bill.id).toBe(billId);
    expect(await countRows(context.dataSource, 'payments')).toBe(1);
  });

  it('does not re-credit a reference that was already reversed', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const created = await client
      .post('/payments', { billId, amount: '40.00', externalRef: 'REF-3' })
      .expect(201);

    await client.delete(`/payments/${created.body.payment.id}`).expect(200);

    // The sharpest case in the suite: the unique index is unconditional and the replay re-read
    // includes soft-deleted rows, so the reversed payment is returned rather than re-credited.
    const replay = await client
      .post('/payments', { billId, amount: '40.00', externalRef: 'REF-3' })
      .expect(200);

    expect(replay.body.replayed).toBe(true);
    expect(replay.body.payment.id).toBe(created.body.payment.id);
    expect(replay.body.payment.reversedAt).not.toBeNull();
    expect(replay.body.bill.balance).toBe('100.00');
    expect(replay.body.bill.status).toBe('POSTED');
    expect(await countRows(context.dataSource, 'payments')).toBe(1);
  });
});
