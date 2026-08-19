import { closeTestApp, createTestApp, TestContext } from './helpers/app';
import { countRows, resetDatabase } from './helpers/db';
import { asOrg, createPostedBill, MONEY_STRING, ORG_A, ORG_B } from './helpers/fixtures';
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

  it('answers 400 when the only number on the line is too large to be an amount', async () => {
    // Real statement lines carry 12-16 digit RRNs. Parsing one as money used to throw a TypeError
    // out of the request and surface as a 500.
    const response = await asOrg(context.baseUrl, ORG_A)
      .post('/reconciliation/suggest', { rawLine: 'GCASH TXN 12345678901234 PHP' })
      .expect(400);
    expect(response.body.code).toBe('UNPARSEABLE_LINE');
  });

  it.each([
    ['an amount beyond numeric(12,2)', 'TRANSFER PHP 99999999999.00 REF 12'],
    ['a grouped amount beyond numeric(12,2)', 'DEPOSIT 1,234,567,890,123.45 ref A1'],
    ['a 16-digit card-style reference', 'PAYMAYA 4111111111111111 SETTLED'],
  ])('never 500s and never parses an out-of-range amount for %s', async (_label, rawLine) => {
    const response = await asOrg(context.baseUrl, ORG_A).post('/reconciliation/suggest', {
      rawLine,
    });

    // Either the line yields no usable amount (400) or it yields one the ledger could hold (200) —
    // an oversized token is never carried into the response, and never becomes a 500.
    expect([200, 400]).toContain(response.status);
    if (response.status === 200) {
      expect(response.body.parsed.amount).toMatch(MONEY_STRING);
      // Whole part measured as a string — `numeric(12,2)` holds 10 digits, and no test may put
      // money through `Number`.
      expect(response.body.parsed.amount.split('.')[0].length).toBeLessThanOrEqual(10);
    } else {
      expect(response.body.code).toBe('UNPARSEABLE_LINE');
    }
  });

  it('ignores a long reference number and matches on the real amount', async () => {
    const response = await asOrg(context.baseUrl, ORG_A)
      .post('/reconciliation/suggest', { rawLine: 'GCASH RRN 12345678901234 PHP 60.00' })
      .expect(200);

    expect(response.body.parsed.amount).toBe('60.00');
    expect(response.body.candidates[0]).toMatchObject({ billId, balance: '60.00' });
  });
});
