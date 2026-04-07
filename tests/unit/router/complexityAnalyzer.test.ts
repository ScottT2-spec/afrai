import { describe, it, expect } from 'vitest';
import {
  analyzeComplexity,
  extractFeatures,
  estimateTokenCount,
  detectLanguage,
} from '../../../src/router/complexityAnalyzer.js';
import type { ChatMessage } from '../../../src/types/api.js';

const msg = (role: 'user' | 'assistant' | 'system', content: string): ChatMessage => ({
  role,
  content,
});

describe('estimateTokenCount', () => {
  it('returns at least 1 for empty string', () => {
    expect(estimateTokenCount('')).toBeGreaterThanOrEqual(1);
  });

  it('estimates roughly 1.3 tokens per word', () => {
    const text = 'hello world foo bar baz';
    const tokens = estimateTokenCount(text);
    // 5 words × 1.3 ≈ 7
    expect(tokens).toBeGreaterThanOrEqual(5);
    expect(tokens).toBeLessThanOrEqual(10);
  });
});

describe('detectLanguage', () => {
  it('returns "en" for English text', () => {
    expect(detectLanguage('Hello, how are you?')).toBe('en');
  });

  it('returns "ar" for Arabic text', () => {
    expect(detectLanguage('مرحبا كيف حالك')).toBe('ar');
  });

  it('returns "am" for Amharic/Ethiopic text', () => {
    expect(detectLanguage('ሰላም')).toBe('am');
  });

  it('returns "en" as default for Latin-script languages', () => {
    // Placeholder — real impl would distinguish Swahili, Yoruba, etc.
    expect(detectLanguage('Habari yako')).toBe('en');
  });
});

describe('extractFeatures', () => {
  it('detects code blocks', () => {
    const messages = [msg('user', 'Here is some code:\n```js\nconsole.log("hi")\n```')];
    const features = extractFeatures(messages);
    expect(features.hasCode).toBe(true);
  });

  it('detects inline code keywords', () => {
    const messages = [msg('user', 'Write a function that returns true')];
    const features = extractFeatures(messages);
    expect(features.hasCode).toBe(true);
  });

  it('detects math expressions', () => {
    const messages = [msg('user', 'Solve the integral of x^2 dx')];
    const features = extractFeatures(messages);
    expect(features.hasMath).toBe(true);
  });

  it('detects reasoning keywords', () => {
    const messages = [msg('user', 'Analyze the trade-offs between REST and GraphQL')];
    const features = extractFeatures(messages);
    expect(features.hasReasoningKeywords).toBe(true);
  });

  it('detects simple Q&A patterns', () => {
    const messages = [msg('user', 'What is the capital of France?')];
    const features = extractFeatures(messages);
    expect(features.isSimpleQA).toBe(true);
  });

  it('counts turns correctly', () => {
    const messages = [
      msg('system', 'You are helpful.'),
      msg('user', 'Hi'),
      msg('assistant', 'Hello!'),
      msg('user', 'How are you?'),
    ];
    const features = extractFeatures(messages);
    expect(features.turnCount).toBe(4);
  });

  it('estimates token count for all messages', () => {
    const messages = [
      msg('user', 'This is a short message'),
      msg('assistant', 'This is a response'),
    ];
    const features = extractFeatures(messages);
    expect(features.estimatedTokens).toBeGreaterThan(0);
  });
});

describe('analyzeComplexity', () => {
  it('scores a trivial question low', () => {
    const messages = [msg('user', 'What is 2+2?')];
    const { score } = analyzeComplexity(messages);
    expect(score).toBeLessThan(0.3);
  });

  it('scores a simple Q&A low', () => {
    const messages = [msg('user', 'What is the capital of France?')];
    const { score } = analyzeComplexity(messages);
    expect(score).toBeLessThan(0.2);
  });

  it('scores a coding question higher', () => {
    const messages = [
      msg('user', 'Write a function to sort an array using quicksort algorithm'),
    ];
    const { score } = analyzeComplexity(messages);
    expect(score).toBeGreaterThan(0.1);
  });

  it('scores a complex reasoning request high', () => {
    const messages = [
      msg(
        'user',
        'Analyze the trade-offs between microservices and monolithic architecture. ' +
          'Consider scalability, deployment complexity, team organization, and ' +
          'evaluate which approach is better for a startup with 5 engineers. ' +
          'Provide a comprehensive step-by-step analysis with pros and cons.'
      ),
    ];
    const { score } = analyzeComplexity(messages);
    expect(score).toBeGreaterThan(0.3);
  });

  it('scores a multi-turn conversation higher than single turn', () => {
    const single = [msg('user', 'Tell me about TypeScript')];
    const multi = [
      msg('user', 'Tell me about TypeScript'),
      msg('assistant', 'TypeScript is...'),
      msg('user', 'How does it compare to Flow?'),
      msg('assistant', 'Flow is...'),
      msg('user', 'What about the type system differences?'),
      msg('assistant', 'The key differences...'),
      msg('user', 'Explain generics in detail'),
    ];

    const { score: singleScore } = analyzeComplexity(single);
    const { score: multiScore } = analyzeComplexity(multi);
    expect(multiScore).toBeGreaterThan(singleScore);
  });

  it('always returns score between 0.0 and 1.0', () => {
    const cases = [
      [msg('user', 'Hi')],
      [msg('user', 'x')],
      [msg('user', 'A '.repeat(5000))],
      [
        msg(
          'user',
          'Analyze and evaluate the comprehensive step-by-step proof of the theorem ' +
            'using calculus and algebra with code ```python\ndef f(x): return x```'
        ),
      ],
    ];

    for (const messages of cases) {
      const { score } = analyzeComplexity(messages);
      expect(score).toBeGreaterThanOrEqual(0.0);
      expect(score).toBeLessThanOrEqual(1.0);
    }
  });

  it('returns extracted features alongside the score', () => {
    const messages = [msg('user', 'What is the capital of Kenya?')];
    const { score, features } = analyzeComplexity(messages);
    expect(features).toBeDefined();
    expect(typeof features.estimatedTokens).toBe('number');
    expect(typeof features.hasCode).toBe('boolean');
    expect(typeof features.hasMath).toBe('boolean');
    expect(typeof features.hasReasoningKeywords).toBe('boolean');
    expect(typeof features.isSimpleQA).toBe('boolean');
    expect(typeof features.turnCount).toBe('number');
    expect(typeof features.detectedLanguage).toBe('string');
  });
});
