import { BaseProvider } from './base.js';
import type { CompletionRequest, CompletionResponse, StreamChunk } from './base.js';
import { ProviderError, parseSSEStream } from './utils.js';
import type { OpenAICompatResponse } from './utils.js';

/**
 * OpenAI provider adapter.
 * Standard OpenAI Chat Completions API at api.openai.com.
 *
 * Models: gpt-4o, gpt-4o-mini
 */
export class OpenAIProvider extends BaseProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';

  private readonly baseUrl = 'https://api.openai.com/v1';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startMs = Date.now();

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
        stream: false,
      }),
      signal: request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined,
    });

    const latencyMs = Date.now() - startMs;

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new ProviderError(`OpenAI API error ${response.status}: ${errorBody}`, this.id, response.status);
    }

    const data = await response.json() as OpenAICompatResponse;
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content ?? '',
      model: data.model,
      provider: this.id,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: choice?.finish_reason ?? 'stop',
      latencyMs,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new ProviderError(`OpenAI streaming error ${response.status}: ${errorBody}`, this.id, response.status);
    }

    yield* parseSSEStream(response, this.id);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
