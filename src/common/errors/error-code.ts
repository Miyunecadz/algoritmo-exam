/** Stable, machine-readable error codes. Clients branch on these, not on message text. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MISSING_ORG_CONTEXT: 'MISSING_ORG_CONTEXT',
  INVALID_ORG_CONTEXT: 'INVALID_ORG_CONTEXT',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_BILL_STATE: 'INVALID_BILL_STATE',
  BILL_HAS_PAYMENTS: 'BILL_HAS_PAYMENTS',
  UNPARSEABLE_LINE: 'UNPARSEABLE_LINE',
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
