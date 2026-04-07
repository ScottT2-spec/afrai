import { z } from 'zod';
import type { ModelCapability } from './provider.js';
import type { TenantTier } from './tenant.js';
import type { CircuitBreakerStatus, ModelDefinition } from './provider.js';

/**
 * A single message in the conversation (OpenAI-compatible format).
 */
export const MessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ChatMessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Routing request — the input to the Smart Router.
 */
export const RoutingRequestSchema = z.object({
  /** Conversation messages to route */
  messages: z.array(ChatMessageSchema).min(1),
  /** Capabilities the selected model MUST support */
  requiredCapabilities: z
    .array(z.string())
    .optional()
    .default([]),
  /** Tenant tier (determines which models are eligible) */
  tenantTier: z.enum(['free', 'starter', 'growth', 'enterprise']),
  /** Optional routing hints */
  options: z
    .object({
      /** Weight given to latency in the ranking formula (0.0–1.0, default 0.0) */
      latencyWeight: z.number().min(0).max(1).optional().default(0),
      /** Force a specific model (bypasses routing logic) */
      forceModel: z.string().optional(),
      /** Maximum cost in USD the caller is willing to pay */
      maxCostUsd: z.number().positive().optional(),
      /** Circuit breaker states per provider */
      circuitBreakerStatus: z.record(z.string(), z.enum(['closed', 'open', 'half_open'])).optional(),
    })
    .optional()
    .default({}),
});
export type RoutingRequest = z.infer<typeof RoutingRequestSchema>;

/**
 * The routing decision returned by the Smart Router.
 */
export interface RoutingDecision {
  /** The primary model selected for the request */
  readonly selectedModel: ModelDefinition;
  /** Ordered fallback chain (first = next best, etc.) */
  readonly fallbackChain: readonly ModelDefinition[];
  /** Complexity score assigned to the request (0.0–1.0) */
  readonly complexityScore: number;
  /** Estimated cost for the primary model in USD */
  readonly estimatedCostUsd: number;
  /** Human-readable reasoning for the routing decision */
  readonly reasoning: string;
  /** Features extracted during complexity analysis */
  readonly features: ComplexityFeatures;
}

/**
 * Features extracted from the request during complexity analysis.
 */
export interface ComplexityFeatures {
  /** Estimated token count of all messages */
  readonly estimatedTokens: number;
  /** Whether code blocks were detected */
  readonly hasCode: boolean;
  /** Whether math expressions were detected */
  readonly hasMath: boolean;
  /** Whether reasoning-heavy keywords were detected */
  readonly hasReasoningKeywords: boolean;
  /** Whether the request looks like simple Q&A */
  readonly isSimpleQA: boolean;
  /** Number of conversation turns (messages) */
  readonly turnCount: number;
  /** Detected language (ISO 639-1 code, or 'unknown') */
  readonly detectedLanguage: string;
}
