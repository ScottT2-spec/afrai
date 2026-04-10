/**
 * Payment Routes — MoMo payment endpoints for AfrAI.
 *
 * POST /v1/payments/topup          — Initiate a MoMo top-up
 * GET  /v1/payments/:id/status     — Check payment status
 * POST /v1/payments/:id/poll       — Poll until payment resolves
 * GET  /v1/wallet/balance          — Get wallet balance
 * GET  /v1/wallet/history          — Get payment history
 * GET  /v1/payments/tiers          — List available credit tiers
 * POST /v1/payments/momo/callback  — MTN callback webhook
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { ApiKeyService } from '../../services/apiKeyService.js';
import type { MomoPaymentService } from '../../payments/momoPayment.js';
import type { RequestToPayResult } from '../../payments/momoTypes.js';

// ── Request Schemas ─────────────────────────────────────────────

const TopUpSchema = z.object({
  /** Amount in GHS */
  amount: z.number().positive(),
  /** MTN MoMo phone number */
  phone_number: z.string().min(9).max(15),
});

const PaymentIdParams = z.object({
  id: z.string().uuid(),
});

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

// ── Route Options ───────────────────────────────────────────────

export interface PaymentRouteOptions {
  apiKeyService: ApiKeyService;
  momoPaymentService: MomoPaymentService;
  /** Secret token to validate MTN callbacks (optional but recommended) */
  callbackSecret?: string;
}

// ── Routes ──────────────────────────────────────────────────────

export async function paymentRoutes(
  app: FastifyInstance,
  opts: PaymentRouteOptions,
): Promise<void> {
  const { apiKeyService, momoPaymentService } = opts;
  const authHook = createAuthMiddleware(apiKeyService, 'payments');

  // ── GET /v1/payments/tiers ──────────────────────────────────
  // Public — no auth needed (so devs can see pricing)
  app.get('/v1/payments/tiers', async (_request, reply) => {
    const tiers = momoPaymentService.getCreditTiers();

    return reply.code(200).send({
      currency: 'GHS',
      payment_method: 'MTN Mobile Money',
      tiers: tiers.map((t) => ({
        amount_ghs: t.amountLocal,
        credits_usd: t.creditsUsd,
        label: t.label,
        estimated_calls: {
          cheap_model: t.estimatedCalls.cheapModel,
          mid_model: t.estimatedCalls.midModel,
          premium_model: t.estimatedCalls.premiumModel,
        },
      })),
    });
  });

  // ── POST /v1/payments/topup ─────────────────────────────────
  app.post(
    '/v1/payments/topup',
    { preHandler: authHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = TopUpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            type: 'invalid_request_error',
            message: 'Invalid top-up request.',
            details: parsed.error.flatten().fieldErrors,
          },
        });
      }

      const tenant = request.tenantContext;
      if (!tenant) {
        return reply.code(401).send({
          error: { type: 'authentication_error', message: 'Tenant context not resolved.' },
        });
      }

      try {
        const result = await momoPaymentService.initiateTopUp({
          amount: parsed.data.amount,
          phoneNumber: parsed.data.phone_number,
          tenantId: tenant.id,
        });

        return reply.code(202).send({
          payment_id: result.paymentId,
          momo_reference_id: result.momoReferenceId,
          amount_ghs: result.amountLocal,
          credits_usd: result.creditsUsd,
          currency: result.currency,
          status: 'pending',
          message: result.message,
          status_url: `/v1/payments/${result.momoReferenceId}/status`,
          poll_url: `/v1/payments/${result.momoReferenceId}/poll`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Payment initiation failed';

        // Distinguish validation errors from API errors
        if (message.includes('Minimum') || message.includes('Maximum') ||
            message.includes('Only MTN') || message.includes('Invalid')) {
          return reply.code(400).send({
            error: { type: 'validation_error', message },
          });
        }

        request.log.error({ err }, 'MoMo payment initiation failed');
        return reply.code(502).send({
          error: {
            type: 'payment_error',
            message: 'Failed to initiate MoMo payment. Please try again.',
          },
        });
      }
    },
  );

  // ── GET /v1/payments/:id/status ─────────────────────────────
  app.get(
    '/v1/payments/:id/status',
    { preHandler: authHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = PaymentIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({
          error: { type: 'invalid_request_error', message: 'Invalid payment ID.' },
        });
      }

      try {
        const result = await momoPaymentService.checkAndProcessPayment(params.data.id);

        return reply.code(200).send({
          momo_reference_id: params.data.id,
          status: result.status,
          credits_usd: result.creditsUsd,
          failure_reason: result.failureReason,
          financial_transaction_id: result.financialTransactionId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Status check failed';

        if (message.includes('not found')) {
          return reply.code(404).send({
            error: { type: 'not_found', message },
          });
        }

        request.log.error({ err }, 'Payment status check failed');
        return reply.code(500).send({
          error: { type: 'internal_error', message: 'Failed to check payment status.' },
        });
      }
    },
  );

  // ── POST /v1/payments/:id/poll ──────────────────────────────
  // Long-poll: waits up to ~60s for payment to resolve
  app.post(
    '/v1/payments/:id/poll',
    { preHandler: authHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = PaymentIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({
          error: { type: 'invalid_request_error', message: 'Invalid payment ID.' },
        });
      }

      try {
        const result = await momoPaymentService.pollUntilResolved(
          params.data.id,
          20,   // max attempts
          3000, // 3s interval → ~60s max wait
        );

        return reply.code(200).send({
          momo_reference_id: params.data.id,
          status: result.status,
          credits_usd: result.creditsUsd,
          failure_reason: result.failureReason,
          financial_transaction_id: result.financialTransactionId,
        });
      } catch (err) {
        request.log.error({ err }, 'Payment polling failed');
        return reply.code(500).send({
          error: { type: 'internal_error', message: 'Failed to poll payment status.' },
        });
      }
    },
  );

  // ── GET /v1/wallet/balance ──────────────────────────────────
  app.get(
    '/v1/wallet/balance',
    { preHandler: authHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenant = request.tenantContext;
      if (!tenant) {
        return reply.code(401).send({
          error: { type: 'authentication_error', message: 'Tenant context not resolved.' },
        });
      }

      const balance = await momoPaymentService.getWalletBalance(tenant.id);

      if (!balance) {
        return reply.code(200).send({
          tenant_id: tenant.id,
          balance_usd: '0.00',
          total_purchased_usd: '0.00',
          total_spent_usd: '0.00',
        });
      }

      return reply.code(200).send({
        tenant_id: balance.tenantId,
        balance_usd: balance.balanceUsd,
        total_purchased_usd: balance.totalPurchasedUsd,
        total_spent_usd: balance.totalSpentUsd,
      });
    },
  );

  // ── GET /v1/wallet/history ──────────────────────────────────
  app.get(
    '/v1/wallet/history',
    { preHandler: authHook },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const tenant = request.tenantContext;
      if (!tenant) {
        return reply.code(401).send({
          error: { type: 'authentication_error', message: 'Tenant context not resolved.' },
        });
      }

      const query = HistoryQuery.safeParse(request.query);
      const limit = query.success ? query.data.limit : 20;

      const payments = await momoPaymentService.getPaymentHistory(tenant.id, limit);

      return reply.code(200).send({
        payments: payments.map((p) => ({
          id: p.id,
          momo_reference_id: p.momoReferenceId,
          phone_number: p.phoneNumber,
          amount_ghs: p.amountLocal,
          credits_usd: p.creditsUsd,
          currency: p.currency,
          status: p.status,
          failure_reason: p.failureReason,
          created_at: p.createdAt,
          updated_at: p.updatedAt,
        })),
      });
    },
  );

  // ── POST /v1/payments/momo/callback ─────────────────────────
  // MTN sends payment result here (no auth — validated by reference ID)
  app.post(
    '/v1/payments/momo/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = request.body as Record<string, unknown>;
        const referenceId = body?.referenceId as string;

        if (!referenceId) {
          return reply.code(400).send({ error: 'Missing referenceId' });
        }

        await momoPaymentService.handleCallback(
          referenceId,
          body as unknown as RequestToPayResult,
        );

        return reply.code(200).send({ received: true });
      } catch (err) {
        request.log.error({ err }, 'MoMo callback processing failed');
        // Always return 200 to MTN to avoid retries on our processing errors
        return reply.code(200).send({ received: true, processed: false });
      }
    },
  );
}
