export class ParsedLineDto {
  /** Parsed deterministically in code, never by the model. Money string. */
  amount!: string;
  reference!: string | null;
  date!: string | null;
}

export class MatchCandidateDto {
  billId!: string;
  amountDue!: string;
  balance!: string;
  /** Deterministic 0–1 closeness score computed in SQL terms, not by the model. */
  score!: number;
}

export class SuggestionDto {
  billId!: string;
  confidence!: number;
  reasoning!: string;
}

export class SuggestMatchResponseDto {
  parsed!: ParsedLineDto;
  candidates!: MatchCandidateDto[];
  /** Null whenever the model was unavailable, unparseable, or picked a bill outside the shortlist. */
  suggestion!: SuggestionDto | null;
  llmAvailable!: boolean;
  warning!: string | null;
}
