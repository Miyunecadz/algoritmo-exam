import { closeTestApp, createTestApp, TestContext } from './helpers/app';
import { countRows, resetDatabase } from './helpers/db';
import { asOrg, createPostedBill, ORG_A } from './helpers/fixtures';

/**
 * Bonus scenario 4 — the two concurrency cases, which fail for different reasons:
 *
 *   Case A (same reference)      fails without the unique index on (org_id, external_ref).
 *   Case B (different references) fails without `SELECT … FOR UPDATE` on the bill — a lost update.
 *
 * Shipping only one leaves half the concurrency claim unproven.
 */
describe('Concurrency', () => {
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

  it('produces exactly one payment for two simultaneous identical ingests', async () => {
    const client = asOrg(context.baseUrl, ORG_A);

    // Looped: a single pass can pass by luck if the two requests happen not to overlap.
    for (let attempt = 0; attempt < 5; attempt++) {
      const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
      const externalRef = `RACE-${attempt}`;
      const body = { billId, amount: '40.00', externalRef };

      const [first, second] = await Promise.all([
        client.post('/payments', body),
        client.post('/payments', body),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 201]);
      expect(first.body.payment.id).toBe(second.body.payment.id);

      const [payments] = await context.dataSource.query(
        `SELECT count(*)::text FROM payments WHERE external_ref = $1`,
        [externalRef],
      );
      expect(payments.count).toBe('1');

      const [credits] = await context.dataSource.query(
        `SELECT count(*)::text FROM ledger_entries WHERE bill_id = $1 AND type = 'PAYMENT_RECEIVED'`,
        [billId],
      );
      expect(credits.count).toBe('1');

      const bill = await client.get(`/bills/${billId}`).expect(200);
      expect(bill.body.balance).toBe('60.00');
    }
  });

  it('replays rather than 409s when two simultaneous ingests each cover the bill', async () => {
    const client = asOrg(context.baseUrl, ORG_A);

    // The partial-payment race above leaves the bill POSTED, so it cannot see this failure mode:
    // here the winner flips the bill to PAID while the loser is still queued on the row lock, and
    // the loser must still be answered as a replay.
    for (let attempt = 0; attempt < 5; attempt++) {
      const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
      const externalRef = `RACE-FULL-${attempt}`;
      const body = { billId, amount: '100.00', externalRef };

      const [first, second] = await Promise.all([
        client.post('/payments', body),
        client.post('/payments', body),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 201]);
      expect(first.body.payment.id).toBe(second.body.payment.id);

      const [payments] = await context.dataSource.query(
        `SELECT count(*)::text FROM payments WHERE external_ref = $1`,
        [externalRef],
      );
      expect(payments.count).toBe('1');

      const bill = await client.get(`/bills/${billId}`).expect(200);
      expect(bill.body.balance).toBe('0.00');
      expect(bill.body.status).toBe('PAID');
    }
  });

  it('applies two simultaneous different payments without losing a status update', async () => {
    const client = asOrg(context.baseUrl, ORG_A);

    for (let attempt = 0; attempt < 3; attempt++) {
      const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');

      const [first, second] = await Promise.all([
        client.post('/payments', { billId, amount: '60.00', externalRef: `LOCK-${attempt}-X` }),
        client.post('/payments', { billId, amount: '40.00', externalRef: `LOCK-${attempt}-Y` }),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const bill = await client.get(`/bills/${billId}`).expect(200);
      expect(bill.body.balance).toBe('0.00');
      expect(bill.body.status).toBe('PAID');

      const [entries] = await context.dataSource.query(
        `SELECT count(*)::text FROM ledger_entries WHERE bill_id = $1`,
        [billId],
      );
      expect(entries.count).toBe('3');
    }
  });

  it('reverses once when two reversals of the same payment race', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
    const created = await client
      .post('/payments', { billId, amount: '40.00', externalRef: 'REVERSE-RACE' })
      .expect(201);

    const [first, second] = await Promise.all([
      client.delete(`/payments/${created.body.payment.id}`),
      client.delete(`/payments/${created.body.payment.id}`),
    ]);

    // The loser gets a clean 404, never a 500 from the partial unique index.
    expect([first.status, second.status].sort()).toEqual([200, 404]);

    const [reversals] = await context.dataSource.query(
      `SELECT count(*)::text FROM ledger_entries WHERE type = 'PAYMENT_REVERSED'`,
    );
    expect(reversals.count).toBe('1');

    const bill = await client.get(`/bills/${billId}`).expect(200);
    expect(bill.body.balance).toBe('100.00');
    expect(await countRows(context.dataSource, 'payments')).toBe(1);
  });

  it('posts a bill exactly once when two posts race', async () => {
    const client = asOrg(context.baseUrl, ORG_A);
    const draft = await client.post('/bills', { amountDue: '100.00' }).expect(201);
    const billId = draft.body.id as string;

    const [first, second] = await Promise.all([
      client.post(`/bills/${billId}/post`),
      client.post(`/bills/${billId}/post`),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const [postings] = await context.dataSource.query(
      `SELECT count(*)::text FROM ledger_entries WHERE bill_id = $1 AND type = 'BILL_POSTED'`,
      [billId],
    );
    expect(postings.count).toBe('1');
  });
});
