import { BaseProvider } from './base.js';
import type { CompletionRequest, CompletionResponse, StreamChunk } from './base.js';
import { ProviderError } from './utils.js';

/**
 * Google Gemini provider adapter.
 * Uses the native Gemini API (NOT OpenAI-compatible).
 *
 * Models: gemini-1.5-pro, gemini-1.5-flash
 *
 * Gemini uses a different format:
 *   - messages → contents[{role, parts[{text}]}]
 *   - system message → systemInstruction
 *   - roles: "user" and "model" (not "assistant")
 */
export class GoogleProvider extends BaseProvider {
  readonly id = 'google';
  readonly displayName = 'Google (Gemini)';

  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private readonly apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startMs = Date.now();
    const { systemInstruction, contents } = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${this.baseUrl}/models/${request.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined,
    });

    const latencyMs = Date.now() - startMs;

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new ProviderError(`Google Gemini API error ${response.status}: ${errorBody}`, this.id, response.status);
    }

    const data = await response.json() as GeminiResponse;
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text).join('') ?? '';

    return {
      content: text,
      model: request.model,
      provider: this.id,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
      },
      finishReason: this.mapFinishReason(candidate?.finishReason),
      latencyMs,
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const { systemInstruction, contents } = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${this.baseUrl}/models/${request.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new ProviderError(`Google Gemini streaming error ${response.status}: ${errorBody}`, this.id, response.status);
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
            const chunk = JSON.parse(jsonStr) as GeminiResponse;
            const text = chunk.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';

            if (chunk.usageMetadata) {
              inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
              outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
            }

            if (text) {
              yield { text, done: false };
            }

            const finishReason = chunk.candidates?.[0]?.finishReason;
            if (finishReason && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
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

      // Stream ended without explicit finish — emit final chunk
      yield {
        text: '',
        done: true,
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      };
    } finally {
      reader.releaseLock();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/models?key=${this.apiKey}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Convert OpenAI-format messages to Gemini format.
   * Gemini uses "model" instead of "assistant" and separates system instructions.
   */
  private convertMessages(messages: CompletionRequest['messages']) {
    const systemMsg = messages.find((m) => m.role === 'system');
    const systemInstruction = systemMsg
      ? { parts: [{ text: systemMsg.content }] }
      : undefined;

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    return { systemInstruction, contents };
  }

  /**
   * Map Gemini finish reasons to our unified format.
   */
  private mapFinishReason(reason?: string): string {
    switch (reason) {
      case 'STOP': return 'stop';
      case 'MAX_TOKENS': return 'length';
      case 'SAFETY': return 'content_filter';
      default: return 'stop';
    }
  }
}

// ─── Gemini-specific types ─────────────────────────────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts: Array<{ text: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
