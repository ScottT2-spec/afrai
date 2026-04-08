import type { StreamChunk } from './base.js';

/** Provider-specific error with status code */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** OpenAI-compatible response format (used by Groq, SambaNova, etc.) */
export interface OpenAICompatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Parse an SSE stream from any OpenAI-compatible API.
 * Works with Groq, SambaNova, and any provider using the same format.
 */
export async function* parseSSEStream(
  response: Response,
  providerId: string,
): AsyncIterable<StreamChunk> {
  const body = response.body;
  if (!body) throw new ProviderError('No response body for stream', providerId, 0);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalInput = 0;
  let totalOutput = 0;

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
        if (jsonStr === '[DONE]') {
          yield {
            text: '',
            done: true,
            usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: totalInput + totalOutput },
          };
          return;
        }

        try {
          const chunk = JSON.parse(jsonStr) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };

          if (chunk.usage) {
            totalInput = chunk.usage.prompt_tokens ?? totalInput;
            totalOutput = chunk.usage.completion_tokens ?? totalOutput;
          }

          const delta = chunk.choices?.[0]?.delta?.content;
          const finished = chunk.choices?.[0]?.finish_reason;

          if (delta) {
            yield { text: delta, done: false };
          }

          if (finished) {
            yield {
              text: '',
              done: true,
              usage: { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: totalInput + totalOutput },
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
