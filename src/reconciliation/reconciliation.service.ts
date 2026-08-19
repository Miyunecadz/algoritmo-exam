import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ErrorCode } from '../common/errors/error-code';
import { Money } from '../common/money/money';
import { LLM_CLIENT, LlmClient } from '../llm/llm-client.interface';
import {
  MatchCandidateDto,
  ParsedLineDto,
  SuggestMatchResponseDto,
  SuggestionDto,
} from './dto/suggest-response.dto';

/** Bills whose balance is further than this from the parsed amount are not even shown. */
const CANDIDATE_THRESHOLD = '100.00';
const CANDIDATE_LIMIT = 5;

/**
 * "Which bill does this bank line belong to?" — suggested, never applied.
 *
 * The product decision this module encodes: a cashier facing a page of unmatched GCash / bank lines
 * wants help *ranking* candidates, not an autonomous agent moving money. So the split is:
 *
 *   - the amount is parsed by a regex, in code — the model is never trusted with money;
 *   - the candidate shortlist comes from one deterministic SQL query, scoped to the caller's org;
 *   - the model only ranks that shortlist and writes the human-readable "why";
 *   - its answer is discarded unless the bill it names is in the shortlist we gave it;
 *   - and if it is slow, down, or incoherent, the cashier still gets the ranked shortlist.
 *
 * This service has NO write path. It holds a DataSource for read queries and an LlmClient, and it
 * never inserts a payment or a ledger entry — the cashier does that themselves via POST /payments.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 3000);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  async suggest(orgId: string, rawLine: string): Promise<SuggestMatchResponseDto> {
    const parsed = this.parseLine(rawLine);
    const candidates = await this.shortlist(orgId, parsed.amount);

    if (candidates.length === 0) {
      return {
        parsed,
        candidates: [],
        suggestion: null,
        llmAvailable: true,
        warning: 'NO_CANDIDATES',
      };
    }

    const ranked = await this.rank(parsed, candidates);
    return { parsed, candidates, ...ranked };
  }

  /**
   * Deterministic parse. This is the guardrail that matters most: the amount that drives the
   * shortlist comes from a regex over the raw line, so a model can never invent or shift it.
   */
  private parseLine(rawLine: string): ParsedLineDto {
    const amountMatch = /(?:^|[^\d.,])(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)(?!\d)/g;
    let amount: string | null = null;
    for (const match of rawLine.matchAll(amountMatch)) {
      const cleaned = match[1].replace(/,/g, '');
      // A token too large for `numeric(12,2)` is a reference number, an account number or an RRN —
      // never an amount on a utility bill. Skipping it here is what lets a real amount later in the
      // line still win.
      if (!Money.isPositiveMoneyString(cleaned)) continue;
      // A bare integer with no decimals is far more likely a reference or a date part than money,
      // unless nothing better turns up — prefer a value that actually has centavos.
      if (cleaned.includes('.')) {
        amount = cleaned;
        break;
      }
      amount ??= cleaned;
    }

    // `isPositiveMoneyString` and never `normalize` here: `normalize` THROWS on a non-money string,
    // and a bank line is full of them — a 14-digit RRN matches the amount regex above and would
    // turn an unparseable line into a 500 instead of the 400 this endpoint owes the cashier.
    if (amount === null || !Money.isPositiveMoneyString(amount)) {
      throw new BadRequestException({
        code: ErrorCode.UNPARSEABLE_LINE,
        message: 'Could not parse an amount from the supplied line',
      });
    }

    const referenceMatch = /(?:ref|reference|rrn|txn)[\s:#]*([A-Za-z0-9-]{3,64})/i.exec(rawLine);
    const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(rawLine);

    return {
      amount: Money.normalize(amount),
      reference: referenceMatch ? referenceMatch[1] : null,
      date: dateMatch ? dateMatch[1] : null,
    };
  }

  /**
   * One query, no N+1: the per-bill balance is computed by a LATERAL sub-select rather than by
   * looping over candidates. Scoped to the caller's org, so another tenant's bills can never
   * appear in a suggestion.
   */
  private async shortlist(orgId: string, amount: string): Promise<MatchCandidateDto[]> {
    const rows = await this.dataSource.query<
      { id: string; amount_due: string; balance: string; distance: string }[]
    >(
      `SELECT b.id,
              b.amount_due::text                                  AS amount_due,
              COALESCE(l.balance, 0)::numeric(12,2)::text         AS balance,
              ABS(COALESCE(l.balance, 0) - $2::numeric)::numeric(12,2)::text AS distance
         FROM bills b
         LEFT JOIN LATERAL (
           SELECT SUM(le.amount) AS balance
             FROM ledger_entries le
            WHERE le.bill_id = b.id AND le.org_id = b.org_id
         ) l ON TRUE
        WHERE b.org_id = $1
          AND b.status = 'POSTED'
          AND b.deleted_at IS NULL
          AND ABS(COALESCE(l.balance, 0) - $2::numeric) <= $3::numeric
        ORDER BY ABS(COALESCE(l.balance, 0) - $2::numeric) ASC, b.created_at ASC
        LIMIT $4`,
      [orgId, amount, CANDIDATE_THRESHOLD, CANDIDATE_LIMIT],
    );

    return rows.map((row) => ({
      billId: row.id,
      amountDue: row.amount_due,
      balance: row.balance,
      // Closeness in [0,1]: 1.0 for an exact balance match, decaying to 0 at the threshold.
      // Computed from exact minor units, so no float ever touches the amounts themselves.
      score: this.scoreFor(row.distance),
    }));
  }

  private scoreFor(distance: string): number {
    const distanceMinor = Money.toMinor(distance.startsWith('-') ? distance.slice(1) : distance);
    const thresholdMinor = Money.toMinor(CANDIDATE_THRESHOLD);
    if (distanceMinor >= thresholdMinor) return 0;
    const ratio = Number(distanceMinor) / Number(thresholdMinor);
    return Math.round((1 - ratio) * 100) / 100;
  }

  /**
   * Asks the model to rank the shortlist. Every failure mode ends in the same place: the cashier
   * still receives the deterministic candidates, and this endpoint never returns a 5xx because a
   * provider was unhappy.
   */
  private async rank(
    parsed: ParsedLineDto,
    candidates: MatchCandidateDto[],
  ): Promise<Pick<SuggestMatchResponseDto, 'suggestion' | 'llmAvailable' | 'warning'>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const raw = await this.llm.complete(this.buildPrompt(parsed, candidates), {
        signal: controller.signal,
      });
      const suggestion = this.validateSuggestion(raw, candidates);
      return suggestion
        ? { suggestion, llmAvailable: true, warning: null }
        : { suggestion: null, llmAvailable: true, warning: 'SUGGESTION_REJECTED' };
    } catch (error) {
      // Timeout, provider outage, malformed transport — all identical from the cashier's seat.
      this.logger.warn(
        `LLM ranking unavailable, falling back to the deterministic shortlist: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { suggestion: null, llmAvailable: false, warning: 'LLM_UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }
  }

  private buildPrompt(parsed: ParsedLineDto, candidates: MatchCandidateDto[]): string {
    const lines = candidates
      .map((candidate) => `- ${candidate.billId} | balance ${candidate.balance}`)
      .join('\n');

    return [
      'You are helping a billing cashier match one incoming bank payment to an open bill.',
      '',
      `Payment amount (already parsed, treat as authoritative): ${parsed.amount}`,
      `Reference found on the line: ${parsed.reference ?? 'none'}`,
      `Date found on the line: ${parsed.date ?? 'none'}`,
      '',
      'Candidate bills (already filtered and ordered by closeness):',
      lines,
      '',
      'Pick the single best candidate, or none if none is convincing.',
      'Do not compute or restate any amounts other than the ones given above.',
      'Reply with JSON only: {"billId": string|null, "confidence": number, "reasoning": string}',
    ].join('\n');
  }

  /**
   * The model's answer is not believed until it is checked. In particular the suggested `billId`
   * must be one we put in the shortlist — a hallucinated id shown to a cashier as a match is
   * precisely the harm this feature must not cause.
   */
  validateSuggestion(raw: string, candidates: MatchCandidateDto[]): SuggestionDto | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.extractJson(raw));
    } catch {
      this.logger.warn('LLM response was not valid JSON, dropping the suggestion');
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.billId !== 'string') return null;
    if (!candidates.some((candidate) => candidate.billId === record.billId)) {
      this.logger.warn('LLM suggested a bill outside the shortlist, dropping the suggestion');
      return null;
    }

    const confidence =
      typeof record.confidence === 'number' && record.confidence >= 0 && record.confidence <= 1
        ? record.confidence
        : 0;
    const reasoning = typeof record.reasoning === 'string' ? record.reasoning.slice(0, 500) : '';

    return { billId: record.billId, confidence, reasoning };
  }

  /** Tolerates a model that wraps its JSON in prose or a code fence. */
  private extractJson(raw: string): string {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const candidate = fenced ? fenced[1] : raw;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate.trim();
  }
}
