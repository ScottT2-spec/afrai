/**
 * OTP Service — generates and verifies 6-digit codes.
 * 
 * Uses in-memory store with TTL. For production, swap to Redis.
 * Codes expire after 10 minutes. Max 5 attempts per code.
 */

import { randomInt } from 'crypto';

interface OtpEntry {
  code: string;
  email: string;
  name?: string;
  attempts: number;
  expiresAt: number;
  createdAt: number;
}

export class OtpService {
  private store = new Map<string, OtpEntry>();
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs = 10 * 60 * 1000, maxAttempts = 5) {
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;

    // Cleanup expired entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /** Generate a 6-digit OTP for an email. Returns the code. */
  generate(email: string, name?: string): string {
    const normalizedEmail = email.toLowerCase().trim();
    const code = String(randomInt(100000, 999999));

    this.store.set(normalizedEmail, {
      code,
      email: normalizedEmail,
      name,
      attempts: 0,
      expiresAt: Date.now() + this.ttlMs,
      createdAt: Date.now(),
    });

    return code;
  }

  /** Verify an OTP code. Returns { valid, name } */
  verify(email: string, code: string): { valid: boolean; name: string | undefined; error?: string } {
    const normalizedEmail = email.toLowerCase().trim();
    const entry = this.store.get(normalizedEmail);

    if (!entry) {
      return { valid: false, name: undefined, error: 'No verification code found. Request a new one.' };
    }

    if (Date.now() > entry.expiresAt) {
      this.store.delete(normalizedEmail);
      return { valid: false, name: undefined, error: 'Code expired. Request a new one.' };
    }

    entry.attempts++;

    if (entry.attempts > this.maxAttempts) {
      this.store.delete(normalizedEmail);
      return { valid: false, name: undefined, error: 'Too many attempts. Request a new code.' };
    }

    if (entry.code !== code) {
      return { valid: false, name: undefined, error: 'Invalid code. Please try again.' };
    }

    // Valid — clean up
    const name = entry.name;
    this.store.delete(normalizedEmail);
    return { valid: true, name };
  }

  /** Check if we can send a new code (rate limiting: 1 per 60s) */
  canSend(email: string): { allowed: boolean; retryAfterSeconds?: number } {
    const normalizedEmail = email.toLowerCase().trim();
    const entry = this.store.get(normalizedEmail);

    if (!entry) return { allowed: true };

    const elapsed = Date.now() - entry.createdAt;
    if (elapsed < 60_000) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((60_000 - elapsed) / 1000),
      };
    }

    return { allowed: true };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}
