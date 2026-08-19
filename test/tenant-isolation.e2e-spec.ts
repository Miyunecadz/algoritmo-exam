import { closeTestApp, createTestApp, TestContext } from './helpers/app';
import { countRows, resetDatabase } from './helpers/db';
import { asOrg, createPostedBill, ORG_A, ORG_B, ORG_UNKNOWN } from './helpers/fixtures';

/**
 * Required scenario 1 — tenant isolation.
 *
 * The status code is only half of the assertion. The other half is that a rejected cross-tenant
 * request writes nothing: a naive implementation that 404s *after* inserting a row would pass a
 * status-code-only test and still corrupt another tenant's ledger.
 */
describe('Tenant isolation', () => {
  let context: TestContext;
  let billId: string;
  let paymentId: string;

  beforeAll(async () => {
    context = await createTestApp();
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    await resetDatabase(context.dataSource);
    billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
    const payment = await asOrg(context.baseUrl, ORG_A)
      .post('/payments', { billId, amount: '40.00', externalRef: 'REF-ISO' })
      .expect(201);
    paymentId = payment.body.payment.id;
  });

  it('returns 404 and writes nothing for every cross-org access', async () => {
    const paymentsBefore = await countRows(context.dataSource, 'payments');
    const ledgerBefore = await countRows(context.dataSource, 'ledger_entries');
    const other = asOrg(context.baseUrl, ORG_B);

    const responses = [
      await other.get(`/bills/${billId}`),
      await other.post(`/bills/${billId}/post`),
      await other.post(`/bills/${billId}/void`),
      await other.post('/payments', { billId, amount: '10.00', externalRef: 'REF-CROSS' }),
      await other.delete(`/payments/${paymentId}`),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: expect.stringMatching(/not found/),
      });
      // Nothing about org A's data may leak — not the amount, not the status, not the ids.
      expect(JSON.stringify(response.body)).not.toContain('100.00');
      expect(JSON.stringify(response.body)).not.toContain(billId);
    }

    expect(await countRows(context.dataSource, 'payments')).toBe(paymentsBefore);
    expect(await countRows(context.dataSource, 'ledger_entries')).toBe(ledgerBefore);
  });

  it("answers identically for another tenant's bill and for a bill that does not exist", async () => {
    const other = asOrg(context.baseUrl, ORG_B);
    const existing = await other.get(`/bills/${billId}`).expect(404);
    const absent = await other.get('/bills/44444444-4444-4444-4444-444444444444').expect(404);

    // Byte-identical: a client cannot use the response to enumerate which bills exist.
    expect(existing.body).toEqual(absent.body);
  });

  it('treats a well-formed but unknown org exactly like another tenant', async () => {
    const unknown = asOrg(context.baseUrl, ORG_UNKNOWN);
    await unknown.get(`/bills/${billId}`).expect(404);
    await unknown
      .post('/payments', { billId, amount: '10.00', externalRef: 'REF-UNKNOWN-ORG' })
      .expect(404);
    expect(await countRows(context.dataSource, 'payments')).toBe(1);
  });

  it('keeps the same externalRef in two orgs as two independent payments', async () => {
    const billB = await createPostedBill(context.baseUrl, ORG_B, '100.00');
    const response = await asOrg(context.baseUrl, ORG_B)
      .post('/payments', { billId: billB, amount: '40.00', externalRef: 'REF-ISO' })
      .expect(201);

    expect(response.body.replayed).toBe(false);
    expect(response.body.payment.id).not.toBe(paymentId);
    expect(await countRows(context.dataSource, 'payments')).toBe(2);
  });
});
