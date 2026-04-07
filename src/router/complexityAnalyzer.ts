import type { ChatMessage } from '../types/api.js';
import type { ComplexityFeatures } from '../types/api.js';

/**
 * Patterns used to detect request features.
 * Compiled once at module load for performance.
 */
const CODE_BLOCK_PATTERN = /```[\s\S]*?```|`[^`]+`/g;
const INLINE_CODE_PATTERN = /\b(function|const|let|var|class|import|export|return|if|else|for|while|switch|try|catch|def|print|console\.log|=>|===|!==)\b/gi;
const MATH_PATTERN = /(\d+\s*[+\-*/^%]\s*\d+|∑|∫|√|∂|∇|lim|log|sin|cos|tan|matrix|equation|formula|derivative|integral|calculus|algebra|theorem|proof)/gi;
const REASONING_KEYWORDS = /\b(analyze|explain|compare|contrast|evaluate|critique|reason|argue|justify|synthesize|assess|implications|trade-?offs?|pros?\s+and\s+cons?|why|how\s+does|what\s+if|step[\s-]by[\s-]step|think\s+through|in[\s-]depth|comprehensive|detailed\s+analysis|consider)\b/gi;
const SIMPLE_QA_PATTERNS = /^(what\s+is|who\s+is|when\s+was|where\s+is|how\s+many|how\s+much|define|list|name|tell\s+me|what\s+are)\b/i;
const SHORT_RESPONSE_INDICATORS = /\b(yes\s+or\s+no|true\s+or\s+false|one\s+word|briefly|in\s+short)\b/i;

/**
 * Weights for each feature in the complexity scoring formula.
 * These are tuned for the v1 static router. The adaptive router (v2)
 * will learn these weights from outcome data.
 */
const WEIGHTS = {
  /** Base weight for estimated token count (normalized) */
  tokenLength: 0.25,
  /** Bonus for presence of code */
  code: 0.20,
  /** Bonus for presence of math expressions */
  math: 0.15,
  /** Bonus for reasoning-heavy language */
  reasoning: 0.20,
  /** Penalty (negative) for simple Q&A patterns */
  simpleQA: -0.15,
  /** Bonus for multi-turn depth */
  multiTurn: 0.15,
} as const;

/**
 * Roughly estimates token count from text.
 * Uses the ~4 characters per token heuristic (works for English).
 * More accurate tokenization would require tiktoken, but this is
 * sufficient for routing decisions.
 */
export function estimateTokenCount(text: string): number {
  // Average ~4 chars per token for English, ~2-3 for CJK/other
  // Using word-based: ~1.3 tokens per word on average
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.3));
}

/**
 * Placeholder for language detection.
 * In production, this would use fasttext or a similar lightweight model.
 * Returns ISO 639-1 code or 'unknown'.
 */
export function detectLanguage(text: string): string {
  // Simple heuristic: check for common non-ASCII scripts
  // This is a placeholder — real implementation uses fasttext (<1ms)
  const sample = text.slice(0, 500);

  // Arabic script
  if (/[\u0600-\u06FF]/.test(sample)) return 'ar';
  // CJK
  if (/[\u4E00-\u9FFF]/.test(sample)) return 'zh';
  // Devanagari
  if (/[\u0900-\u097F]/.test(sample)) return 'hi';
  // Cyrillic
  if (/[\u0400-\u04FF]/.test(sample)) return 'ru';
  // Ethiopic (Amharic)
  if (/[\u1200-\u137F]/.test(sample)) return 'am';

  // Default to English for Latin script
  // Real implementation would distinguish French, Swahili, Yoruba, etc.
  return 'en';
}

/**
 * Extracts features from a conversation for complexity scoring.
 *
 * Features extracted per the architecture spec:
 * - Token count estimation
 * - Code block / inline code detection
 * - Math expression detection
 * - Reasoning keyword detection
 * - Simple Q&A pattern detection
 * - Multi-turn depth (conversation length)
 * - Language detection (placeholder)
 */
export function extractFeatures(messages: readonly ChatMessage[]): ComplexityFeatures {
  // Combine all message content for analysis
  const allContent = messages.map((m) => m.content).join('\n');
  const userContent = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const estimatedTokens = estimateTokenCount(allContent);
  const hasCode =
    CODE_BLOCK_PATTERN.test(allContent) || INLINE_CODE_PATTERN.test(userContent);
  const hasMath = MATH_PATTERN.test(userContent);
  const hasReasoningKeywords = REASONING_KEYWORDS.test(userContent);
  const isSimpleQA =
    SIMPLE_QA_PATTERNS.test(lastUserMessage) ||
    SHORT_RESPONSE_INDICATORS.test(lastUserMessage);
  const turnCount = messages.length;
  const detectedLanguage = detectLanguage(userContent || allContent);

  // Reset regex lastIndex (global regexes are stateful)
  CODE_BLOCK_PATTERN.lastIndex = 0;
  INLINE_CODE_PATTERN.lastIndex = 0;
  MATH_PATTERN.lastIndex = 0;
  REASONING_KEYWORDS.lastIndex = 0;

  return {
    estimatedTokens,
    hasCode,
    hasMath,
    hasReasoningKeywords,
    isSimpleQA,
    turnCount,
    detectedLanguage,
  };
}

/**
 * Scores the complexity of a request on a 0.0–1.0 scale.
 *
 * Algorithm (from architecture spec):
 * 1. Extract features (token count, code, math, reasoning, Q&A, multi-turn)
 * 2. Weight each feature
 * 3. Normalize to 0.0 (trivial) → 1.0 (expert)
 *
 * @param messages - The conversation messages to analyze
 * @returns Object with the numeric score and extracted features
 */
export function analyzeComplexity(
  messages: readonly ChatMessage[]
): { score: number; features: ComplexityFeatures } {
  const features = extractFeatures(messages);

  // Token length score: normalize to 0–1 range
  // 0 tokens → 0.0, 2000+ tokens → 1.0 (linear scale, clamped)
  const tokenScore = Math.min(1.0, features.estimatedTokens / 2000);

  // Multi-turn score: 1 turn → 0.0, 10+ turns → 1.0
  const multiTurnScore = Math.min(1.0, Math.max(0, (features.turnCount - 1)) / 9);

  // Compute weighted sum
  let rawScore = 0;
  rawScore += WEIGHTS.tokenLength * tokenScore;
  rawScore += WEIGHTS.code * (features.hasCode ? 1.0 : 0.0);
  rawScore += WEIGHTS.math * (features.hasMath ? 1.0 : 0.0);
  rawScore += WEIGHTS.reasoning * (features.hasReasoningKeywords ? 1.0 : 0.0);
  rawScore += WEIGHTS.simpleQA * (features.isSimpleQA ? 1.0 : 0.0);
  rawScore += WEIGHTS.multiTurn * multiTurnScore;

  // Clamp to [0.0, 1.0]
  const score = Math.max(0.0, Math.min(1.0, rawScore));

  return { score: Math.round(score * 1000) / 1000, features };
}
