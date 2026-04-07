import { z } from 'zod';

/**
 * Tenant tier levels — controls model access, rate limits, and SLA.
 *
 * - free:       Economy models only, 10K tokens/day
 * - starter:    Standard models, 100K tokens/day
 * - growth:     Premium models, 1M tokens/day, SLA
 * - enterprise: All models, unlimited, dedicated, BYOK, 99.99%
 */
export const TenantTierSchema = z.enum([
  'free',
  'starter',
  'growth',
  'enterprise',
]);
export type TenantTier = z.infer<typeof TenantTierSchema>;

/**
 * Minimal tenant context needed by the router.
 * Full tenant entity lives in the database layer — this is the
 * subset extracted from the authenticated API key context.
 */
export interface TenantContext {
  /** Tenant UUID */
  readonly id: string;
  /** Current subscription tier */
  readonly tier: TenantTier;
}
