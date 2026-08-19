import { Injectable, Logger } from '@nestjs/common';
import { LlmClient, LlmCompleteOptions } from './llm-client.interface';

/**
 * The default binding, and the only client the test suite exercises.
 *
 * It returns canned-but-realistic JSON derived from the shortlist embedded in the prompt, which is
 * enough to prove the whole path end to end — parse, shortlist, rank, validate, degrade — without
 * a network call or an API key. `LLM_PROVIDER=anthropic` swaps in the real client.
 */
@Injectable()
export class StubLlmClient implements LlmClient {
  private readonly logger = new Logger(StubLlmClient.name);

  /** Test hook: lets a spec force the failure paths without a real provider. */
  public behaviour: 'ok' | 'throw' | 'timeout' | 'malformed' | 'hallucinate' = 'ok';

  async complete(prompt: string, options: LlmCompleteOptions): Promise<string> {
    switch (this.behaviour) {
      case 'throw':
        throw new Error('stub provider failure');
      case 'timeout':
        return new Promise<string>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      case 'malformed':
        return 'I think it is probably the first one?';
      case 'hallucinate':
        return JSON.stringify({
          billId: '00000000-0000-4000-8000-000000000000',
          confidence: 0.99,
          reasoning: 'A bill id that was never in the shortlist.',
        });
      default:
        break;
    }

    // The shortlist is rendered into the prompt as `- <billId> | balance <amount>` lines; the top
    // one is already the closest amount match, because the ordering is done in SQL.
    const first = /- ([0-9a-f-]{36}) \| balance ([-\d.]+)/i.exec(prompt);
    if (!first) {
      return JSON.stringify({ billId: null, confidence: 0, reasoning: 'No candidates to rank.' });
    }

    this.logger.debug('Stub LLM ranking the deterministic shortlist');
    return JSON.stringify({
      billId: first[1],
      confidence: 0.9,
      reasoning: `Balance ${first[2]} is the closest match to the amount parsed from the bank line.`,
    });
  }
}
