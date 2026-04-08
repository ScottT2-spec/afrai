/**
 * Abstract provider interface — every AI provider adapter implements this.
 * Unified interface: the rest of AfrAI never touches provider-specific APIs.
 */

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Model ID as known by the provider (e.g. 'llama-3.3-70b-versatile' for Groq) */
  model: string;
  /** Conversation messages */
  messages: CompletionMessage[];
  /** Max tokens to generate */
  maxTokens?: number;
  /** Temperature (0.0–2.0) */
  temperature?: number;
  /** Whether to stream the response */
  stream?: boolean;
  /** Request timeout in ms */
  timeoutMs?: number;
}

export interface CompletionResponse {
  /** The generated text */
  content: string;
  /** Model that actually served the request */
  model: string;
  /** Provider identifier */
  provider: string;
  /** Token usage */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Finish reason */
  finishReason: 'stop' | 'length' | 'content_filter' | 'error' | string;
  /** Latency of the provider call in ms */
  latencyMs: number;
}

export interface StreamChunk {
  /** Partial text token */
  text: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** Usage info (only on final chunk) */
  usage?: CompletionResponse['usage'];
}

/**
 * Abstract base class for all provider adapters.
 */
export abstract class BaseProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;

  /**
   * Send a completion request and get a full response.
   */
  abstract complete(request: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Send a streaming completion request.
   * Returns an async iterable of chunks.
   */
  abstract stream(request: CompletionRequest): AsyncIterable<StreamChunk>;

  /**
   * Check if the provider is reachable (lightweight health check).
   */
  abstract healthCheck(): Promise<boolean>;
}
