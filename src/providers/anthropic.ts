import { BaseProvider } from './base.js';
import type { CompletionRequest, CompletionResponse, StreamChunk } from './base.js';
import { ProviderError } from './utils.js';

/**
 * Anthropic/Claude provider adapter.
 * Uses the native Anthropic Messages API (NOT OpenAI-compatible).
 *
 * Models: claude-sonnet-4-20250514, claude-3-5-haiku-20241022, etc.
 */
export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic (Claude)';

  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly apiKey: string;
  private readonly apiVersion = '2023-06-01';

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startMs = Date.now();
    const { systemMessage, messages } = this.splitSystemMessage(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.7,
    };
    if (systemMessage) body.system = systemMessage;

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined,
    });

    const latencyMs = Date.now() - startMs;

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new ProviderError(`Anthropic API error ${response.status}: ${errorBody}`, this.id, response.status);
    }

    const data = await response.json() as AnthropicMessageResponse;
    const textBlock = data.content?.find(b => b.type === 'text');

    return {
      content: textBlock?.text ?? '',
      model: data.model,
      provider: this.id,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason ?? 'stop',
      latencyMs,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const { systemMessage, messages } = this.splitSystemMessage(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };
    if (systemMessage) body.system = systemMessage;

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new ProviderError(`Anthropic streaming error ${response.status}: ${errorBody}`, this.id, response.status);
    }

    const responseBody = response.body;
    if (!responseBody) throw new ProviderError('No response body for stream', this.id, 0);

    const reader = responseBody.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();

          try {
            const event = JSON.parse(jsonStr) as AnthropicStreamEvent;

            if (event.type === 'message_start' && event.message?.usage) {
              inputTokens = event.message.usage.input_tokens ?? 0;
            } else if (event.type === 'content_block_delta' && event.delta?.text) {
              yield { text: event.delta.text, done: false };
            } else if (event.type === 'message_delta' && event.usage) {
              outputTokens = event.usage.output_tokens ?? 0;
            } else if (event.type === 'message_stop') {
              yield {
                text: '',
                done: true,
                usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
              };
              return;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(10000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Anthropic requires system messages separated from the messages array.
   */
  private splitSystemMessage(messages: CompletionRequest['messages']) {
    const systemMessage = messages.find(m => m.role === 'system')?.content;
    const filtered = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    return { systemMessage, messages: filtered };
  }
}

// ─── Anthropic-specific types ───────────────────────────────────────

interface AnthropicMessageResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicStreamEvent {
  type: string;
  message?: { usage?: { input_tokens?: number } };
  delta?: { text?: string };
  usage?: { output_tokens?: number };
}
