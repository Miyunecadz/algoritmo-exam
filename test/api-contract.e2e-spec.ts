import request from 'supertest';
import { closeTestApp, createTestApp, TestContext } from './helpers/app';
import { countRows, resetDatabase } from './helpers/db';
import { asOrg, createPostedBill, MONEY_STRING, ORG_A } from './helpers/fixtures';

/** State-machine, validation and tenant-context cases that guard the HTTP contract. */
describe('API contract', () => {
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

  describe('tenant context', () => {
    it('rejects a missing header with 400', async () => {
      const response = await request(context.baseUrl).get('/bills/x').expect(400);
      expect(response.body.code).toBe('MISSING_ORG_CONTEXT');
    });

    it('rejects a malformed header with 400', async () => {
      const response = await request(context.baseUrl)
        .get('/bills/44444444-4444-4444-4444-444444444444')
        .set('X-Org-Id', 'not-a-uuid')
        .expect(400);
      expect(response.body.code).toBe('INVALID_ORG_CONTEXT');
    });

    it('serves the health probe without a tenant context', async () => {
      await request(context.baseUrl).get('/health').expect(200, { status: 'ok' });
    });
  });

  describe('money validation', () => {
    it.each([
      ['a JSON number', 40.5],
      ['too many decimals', '40.555'],
      ['zero', '0'],
      ['negative', '-5.00'],
      ['empty', ''],
      ['not a number', 'abc'],
    ])('rejects %s', async (_label, amountDue) => {
      const response = await asOrg(context.baseUrl, ORG_A)
        .post('/bills', { amountDue })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(await countRows(context.dataSource, 'bills')).toBe(0);
    });

    it('rejects unknown fields', async () => {
      await asOrg(context.baseUrl, ORG_A)
        .post('/bills', { amountDue: '10.00', foo: 1 })
        .expect(400);
    });

    it('normalises an accepted amount to two decimals', async () => {
      const response = await asOrg(context.baseUrl, ORG_A)
        .post('/bills', { amountDue: '100' })
        .expect(201);
      expect(response.body.amountDue).toBe('100.00');
      expect(response.body.amountDue).toMatch(MONEY_STRING);
    });

    it('rejects a malformed path id with 400', async () => {
      await asOrg(context.baseUrl, ORG_A).get('/bills/abc').expect(400);
    });
  });

  describe('bill state machine', () => {
    it('rejects a second post with 409 and keeps one ledger entry', async () => {
      const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
      const response = await asOrg(context.baseUrl, ORG_A)
        .post(`/bills/${billId}/post`)
        .expect(409);
      expect(response.body.code).toBe('INVALID_BILL_STATE');
      expect(await countRows(context.dataSource, 'ledger_entries')).toBe(1);
    });

    it('rejects a payment on a DRAFT bill and writes nothing', async () => {
      const draft = await asOrg(context.baseUrl, ORG_A)
        .post('/bills', { amountDue: '100.00' })
        .expect(201);
      const response = await asOrg(context.baseUrl, ORG_A)
        .post('/payments', { billId: draft.body.id, amount: '10.00', externalRef: 'D-1' })
        .expect(409);

      expect(response.body.code).toBe('INVALID_BILL_STATE');
      expect(await countRows(context.dataSource, 'payments')).toBe(0);
      expect(await countRows(context.dataSource, 'ledger_entries')).toBe(0);
    });

    it('rejects a payment on a PAID bill', async () => {
      const client = asOrg(context.baseUrl, ORG_A);
      const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
      await client.post('/payments', { billId, amount: '100.00', externalRef: 'P-1' }).expect(201);

      await client.post('/payments', { billId, amount: '10.00', externalRef: 'P-2' }).expect(409);
    });

    it('voids a DRAFT bill and then rejects payments on it', async () => {
      const client = asOrg(context.baseUrl, ORG_A);
      const draft = await client.post('/bills', { amountDue: '100.00' }).expect(201);
      const voided = await client.post(`/bills/${draft.body.id}/void`).expect(200);
      expect(voided.body.status).toBe('VOID');

      await client
        .post('/payments', { billId: draft.body.id, amount: '10.00', externalRef: 'V-1' })
        .expect(409);
      await client.post(`/bills/${draft.body.id}/post`).expect(409);
    });

    it('refuses to void a POSTED bill that already has a payment', async () => {
      const client = asOrg(context.baseUrl, ORG_A);
      const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
      await client.post('/payments', { billId, amount: '10.00', externalRef: 'V-2' }).expect(201);

      const response = await client.post(`/bills/${billId}/void`).expect(409);
      expect(response.body.code).toBe('BILL_HAS_PAYMENTS');
    });

    it('voids a POSTED bill that has no payments', async () => {
      const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
      const response = await asOrg(context.baseUrl, ORG_A)
        .post(`/bills/${billId}/void`)
        .expect(200);
      expect(response.body.status).toBe('VOID');
      // Voiding does not rewrite history: the BILL_POSTED entry stays.
      expect(response.body.balance).toBe('100.00');
    });
  });

  describe('reversal', () => {
    it('returns 404 when reversing the same payment twice', async () => {
      const client = asOrg(context.baseUrl, ORG_A);
      const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
      const created = await client
        .post('/payments', { billId, amount: '40.00', externalRef: 'R-1' })
        .expect(201);

      await client.delete(`/payments/${created.body.payment.id}`).expect(200);
      const second = await client.delete(`/payments/${created.body.payment.id}`).expect(404);
      expect(second.body.code).toBe('NOT_FOUND');

      const [reversals] = await context.dataSource.query(
        `SELECT count(*)::text FROM ledger_entries WHERE type = 'PAYMENT_REVERSED'`,
      );
      expect(reversals.count).toBe('1');
    });
  });
});
