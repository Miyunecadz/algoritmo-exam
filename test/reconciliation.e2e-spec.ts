import { closeTestApp, createTestApp, TestContext } from './helpers/app';
import { countRows, resetDatabase } from './helpers/db';
import { asOrg, createPostedBill, ORG_A, ORG_B } from './helpers/fixtures';
import { StubLlmClient } from '../src/llm/stub-llm.client';

/**
 * These specs cover the guardrails around the AI slice: the endpoint never writes, never 5xxs
 * because a provider misbehaved, and never shows a cashier a bill the shortlist did not contain.
 */
describe('AI reconciliation suggestions', () => {
  let context: TestContext;
  let stub: StubLlmClient;
  let billId: string;

  const bankLine = 'GCASH TRANSFER PHP 60.00 REF 8891 2026-08-14';

  beforeAll(async () => {
    context = await createTestApp();
    stub = context.app.get(StubLlmClient);
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    await resetDatabase(context.dataSource);
    stub.behaviour = 'ok';
    billId = await createPostedBill(context.baseUrl, ORG_A, '100.00');
    await asOrg(context.baseUrl, ORG_A)
      .post('/payments', { billId, amount: '40.00', externalRef: 'REC-1' })
      .expect(201);
  });

  const expectNoWrites = async (fn: () => Promise<unknown>): Promise<void> => {
    const payments = await countRows(context.dataSource, 'payments');
    const ledger = await countRows(context.dataSource, 'ledger_entries');
    await fn();
    expect(await countRows(context.dataSource, 'payments')).toBe(payments);
    expect(await countRows(context.dataSource, 'ledger_entries')).toBe(ledger);
  };

  it('parses the line deterministically and suggests a shortlisted bill', async () => {
    await expectNoWrites(async () => {
      const response = await asOrg(context.baseUrl, ORG_A)
        .post('/reconciliation/suggest', { rawLine: bankLine })
        .expect(200);

      expect(response.body.parsed).toEqual({
        amount: '60.00',
        reference: '8891',
        date: '2026-08-14',
      });
      expect(response.body.candidates[0]).toMatchObject({ billId, balance: '60.00' });
      expect(response.body.suggestion.billId).toBe(billId);
      expect(response.body.llmAvailable).toBe(true);
      expect(response.body.warning).toBeNull();
    });
  });

  it.each(['throw', 'timeout'] as const)(
    'still answers 200 with the deterministic shortlist when the provider %ss',
    async (behaviour) => {
      stub.behaviour = behaviour;
      await expectNoWrites(async () => {
        const response = await asOrg(context.baseUrl, ORG_A)
          .post('/reconciliation/suggest', { rawLine: bankLine })
          .expect(200);

        expect(response.body.candidates).toHaveLength(1);
        expect(response.body.suggestion).toBeNull();
        expect(response.body.llmAvailable).toBe(false);
        expect(response.body.warning).toBe('LLM_UNAVAILABLE');
      });
    },
  );

  it('drops a malformed model response', async () => {
    stub.behaviour = 'malformed';
    const response = await asOrg(context.baseUrl, ORG_A)
      .post('/reconciliation/suggest', { rawLine: bankLine })
      .expect(200);

    expect(response.body.suggestion).toBeNull();
    expect(response.body.warning).toBe('SUGGESTION_REJECTED');
    expect(response.body.candidates).toHaveLength(1);
  });

  it('drops a suggestion naming a bill outside the shortlist', async () => {
    stub.behaviour = 'hallucinate';
    await expectNoWrites(async () => {
      const response = await asOrg(context.baseUrl, ORG_A)
        .post('/reconciliation/suggest', { rawLine: bankLine })
        .expect(200);

      expect(response.body.suggestion).toBeNull();
      expect(response.body.warning).toBe('SUGGESTION_REJECTED');
      expect(response.body.candidates[0].billId).toBe(billId);
    });
  });

  it("never surfaces another tenant's bills as candidates", async () => {
    const response = await asOrg(context.baseUrl, ORG_B)
      .post('/reconciliation/suggest', { rawLine: bankLine })
      .expect(200);

    expect(response.body.candidates).toHaveLength(0);
    expect(response.body.warning).toBe('NO_CANDIDATES');
  });

  it('rejects a line with no parseable amount', async () => {
    const response = await asOrg(context.baseUrl, ORG_A)
      .post('/reconciliation/suggest', { rawLine: 'no money on this line' })
      .expect(400);
    expect(response.body.code).toBe('UNPARSEABLE_LINE');
  });

  it('rejects a line whose amount is larger than the money column allows', async () => {
    const response = await asOrg(context.baseUrl, ORG_A)
      .post('/reconciliation/suggest', { rawLine: 'GCASH TRANSFER PHP 99999999999.00 REF 8891' })
      .expect(400);
    expect(response.body.code).toBe('UNPARSEABLE_LINE');
  });
});
