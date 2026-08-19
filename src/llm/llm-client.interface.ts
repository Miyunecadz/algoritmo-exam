/** Injection token for the provider binding. */
export const LLM_CLIENT = 'LLM_CLIENT';

export interface LlmCompleteOptions {
  /** Aborts the call when the caller's timeout fires. Implementations must honour it. */
  signal: AbortSignal;
}

/**
 * The one seam between this application and any language model.
 *
 * Deliberately tiny: a prompt in, raw text out. Everything that matters — what the model is
 * allowed to see, whether its answer is believed, what happens when it is slow or wrong — lives in
 * `ReconciliationService`, not behind this interface.
 */
export interface LlmClient {
  complete(prompt: string, options: LlmCompleteOptions): Promise<string>;
}
