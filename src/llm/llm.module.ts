import { Module } from '@nestjs/common';
import { AnthropicLlmClient } from './anthropic-llm.client';
import { LLM_CLIENT } from './llm-client.interface';
import { StubLlmClient } from './stub-llm.client';

/**
 * Provider selection happens once, here. The stub is the default so that a clone of this repo runs
 * the full feature — including its tests — with no API key and no network access.
 */
@Module({
  providers: [
    StubLlmClient,
    AnthropicLlmClient,
    {
      provide: LLM_CLIENT,
      inject: [StubLlmClient, AnthropicLlmClient],
      useFactory: (stub: StubLlmClient, anthropic: AnthropicLlmClient) =>
        process.env.LLM_PROVIDER === 'anthropic' ? anthropic : stub,
    },
  ],
  exports: [LLM_CLIENT, StubLlmClient],
})
export class LlmModule {}
