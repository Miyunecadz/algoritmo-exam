import { Injectable, Logger } from '@nestjs/common';
import { LlmClient, LlmCompleteOptions } from './llm-client.interface';

/**
 * Real provider, bound only when `LLM_PROVIDER=anthropic`. Never on the test path.
 *
 * Uses `fetch` directly rather than the SDK to keep the dependency list at zero for this feature.
 * The key comes from the environment; `.env` is gitignored and only `.env.example` is committed.
 */
@Injectable()
export class AnthropicLlmClient implements LlmClient {
  private readonly logger = new Logger(AnthropicLlmClient.name);
  private readonly apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  private readonly model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';

  async complete(prompt: string, options: LlmCompleteOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: options.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      // The body may contain provider detail; log it, never return it to the caller.
      this.logger.warn(`Anthropic responded ${response.status}`);
      throw new Error(`Anthropic request failed with status ${response.status}`);
    }

    const body = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((part) => part.type === 'text')?.text;
    if (!text) throw new Error('Anthropic response contained no text content');
    return text;
  }
}
