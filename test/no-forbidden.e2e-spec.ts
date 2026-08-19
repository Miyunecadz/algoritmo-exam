import { closeTestApp, createTestApp, TestContext } from './helpers/app';
import { resetDatabase } from './helpers/db';
import { asOrg, createPostedBill, ORG_A, ORG_B } from './helpers/fixtures';

/**
 * Regression guard: "404, never 403" is a rule the suite enforces, not a convention a future
 * edit can quietly break. Every endpoint is driven with another tenant's resource id.
 */
describe('No endpoint ever answers 403', () => {
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

  it('returns 404 rather than 403 on every cross-tenant route', async () => {
    const billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
    const payment = await asOrg(context.baseUrl, ORG_A)
      .post('/payments', { billId, amount: '10.00', externalRef: 'REF-GUARD' })
      .expect(201);

    const intruder = asOrg(context.baseUrl, ORG_B);
    const responses = [
      await intruder.get(`/bills/${billId}`),
      await intruder.post(`/bills/${billId}/post`),
      await intruder.post(`/bills/${billId}/void`),
      await intruder.post('/payments', { billId, amount: '10.00', externalRef: 'REF-GUARD-2' }),
      await intruder.delete(`/payments/${payment.body.payment.id}`),
    ];

    for (const response of responses) {
      expect(response.status).not.toBe(403);
      expect(response.status).toBe(404);
    }
  });
});
