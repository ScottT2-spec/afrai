/**
 * OTP Auth Routes — email verification flow for AfrAI.
 *
 * POST /v1/auth/send-otp    — Send 6-digit code to email
 * POST /v1/auth/verify-otp  — Verify code and create/login account
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiKeyService } from '../../services/apiKeyService.js';
import type { OtpService } from '../../services/otpService.js';

const SendOtpSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(2).max(255).optional(),
});

const VerifyOtpSchema = z.object({
  email: z.string().email().max(255),
  code: z.string().length(6).regex(/^\d{6}$/),
  name: z.string().min(2).max(255).optional(),
});

export interface OtpAuthRouteOptions {
  apiKeyService: ApiKeyService;
  otpService: OtpService;
}

export async function otpAuthRoutes(
  app: FastifyInstance,
  opts: OtpAuthRouteOptions,
): Promise<void> {
  const { apiKeyService, otpService } = opts;

  // ===== SEND OTP =====
  app.post(
    '/v1/auth/send-otp',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Send verification code to email',
        description: 'Sends a 6-digit OTP to the provided email address. Codes expire after 10 minutes.',
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            name: { type: 'string', minLength: 2, maxLength: 255 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              expires_in: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SendOtpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { type: 'invalid_request', message: 'Valid email is required.' },
        });
      }

      const { email, name } = parsed.data;

      // Rate limit: 1 code per 60 seconds
      const rateCheck = otpService.canSend(email);
      if (!rateCheck.allowed) {
        return reply.code(429).send({
          error: {
            type: 'rate_limit',
            message: `Please wait ${rateCheck.retryAfterSeconds}s before requesting a new code.`,
          },
        });
      }

      const code = otpService.generate(email, name);

      // Log the OTP code (in production, send via email service like Resend/SendGrid)
      request.log.info({ email, code }, 'OTP generated — in production this would be emailed');

      // TODO: Send actual email. For now, we log it and also return a hint in dev mode.
      const isDev = process.env.NODE_ENV !== 'production';

      return reply.code(200).send({
        message: 'Verification code sent to ' + email,
        expires_in: 600,
        ...(isDev ? { _dev_code: code } : {}),
      });
    },
  );

  // ===== VERIFY OTP =====
  app.post(
    '/v1/auth/verify-otp',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Verify code and get API key',
        description: 'Verifies the 6-digit OTP. On success, creates an account (if new) and returns an API key.',
        body: {
          type: 'object',
          required: ['email', 'code'],
          properties: {
            email: { type: 'string', format: 'email' },
            code: { type: 'string', minLength: 6, maxLength: 6 },
            name: { type: 'string', minLength: 2, maxLength: 255 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              tenant_id: { type: 'string' },
              api_key: { type: 'string' },
              key_prefix: { type: 'string' },
              tier: { type: 'string' },
              rate_limit_rpm: { type: 'integer' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = VerifyOtpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { type: 'invalid_request', message: 'Valid email and 6-digit code required.' },
        });
      }

      const { email, code, name } = parsed.data;

      // Verify OTP
      const result = otpService.verify(email, code);
      if (!result.valid) {
        return reply.code(400).send({
          error: { type: 'invalid_otp', message: result.error },
        });
      }

      // OTP valid — create account or get existing
      const accountName = (name || result.name || email.split('@')[0]) as string;

      try {
        const tenant = await apiKeyService.createTenant(accountName, email, 'free');

        return reply.code(200).send({
          tenant_id: tenant.tenantId,
          api_key: tenant.rawKey,
          key_prefix: tenant.keyPrefix,
          tier: 'free',
          rate_limit_rpm: 60,
          message: 'Account created. Save your API key — you won\'t see it again.',
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';

        // If email already exists, generate a new API key for existing tenant
        if (message.includes('unique') || message.includes('duplicate') || message.includes('already exists')) {
          // For now, return a helpful message. In production, look up existing tenant and issue new key.
          return reply.code(200).send({
            message: 'Signed in successfully. Use your existing API key, or contact support for a new one.',
            email,
            tier: 'free',
          });
        }

        request.log.error({ err }, 'Account creation failed after OTP verification');
        return reply.code(500).send({
          error: { type: 'internal_error', message: 'Account creation failed. Please try again.' },
        });
      }
    },
  );
}
