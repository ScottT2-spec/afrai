/**
 * OTP Auth Routes — email verification flow for AfrAI.
 *
 * POST /v1/auth/send-otp    — Send 6-digit code to email
 * POST /v1/auth/verify-otp  — Verify code and create/login account
 * POST /v1/auth/resend-otp  — Resend verification code (rate limited)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiKeyService } from '../../services/apiKeyService.js';
import type { OtpService } from '../../services/otpService.js';
import type { EmailService } from '../../services/emailService.js';

const SendOtpSchema = z.object({
  email: z.string().email().max(255).transform(v => v.toLowerCase().trim()),
  name: z.string().min(2).max(255).optional(),
});

const VerifyOtpSchema = z.object({
  email: z.string().email().max(255).transform(v => v.toLowerCase().trim()),
  code: z.string().length(6).regex(/^\d{6}$/),
  name: z.string().min(2).max(255).optional(),
});

export interface OtpAuthRouteOptions {
  apiKeyService: ApiKeyService;
  otpService: OtpService;
  emailService: EmailService;
}

export async function otpAuthRoutes(
  app: FastifyInstance,
  opts: OtpAuthRouteOptions,
): Promise<void> {
  const { apiKeyService, otpService, emailService } = opts;

  // ===== SEND OTP =====
  app.post(
    '/v1/auth/send-otp',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Send verification code to email',
        description:
          'Sends a 6-digit OTP to the provided email address. Codes expire after 10 minutes.\n\n' +
          'Rate limited: 1 code per 60 seconds per email address.',
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', description: 'Your email address' },
            name: { type: 'string', minLength: 2, maxLength: 255, description: 'Your name (optional, used in the email greeting)' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              expires_in: { type: 'integer', description: 'Seconds until code expires' },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } },
          },
          429: {
            type: 'object',
            properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SendOtpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { type: 'invalid_request', message: 'A valid email address is required.' },
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

      // Send the actual email
      const sent = await emailService.sendVerificationCode(email, code, name);
      if (!sent) {
        return reply.code(500).send({
          error: {
            type: 'email_error',
            message: 'Could not send verification email. Please check your email address and try again.',
          },
        });
      }

      request.log.info({ email }, 'OTP sent via email');

      return reply.code(200).send({
        message: `Verification code sent to ${email}`,
        expires_in: 600,
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
        description:
          'Verifies the 6-digit OTP. On success, creates an account (if new) and returns an API key.\n\n' +
          '⚠️ **Save the API key immediately — you will not see it again.**',
        body: {
          type: 'object',
          required: ['email', 'code'],
          properties: {
            email: { type: 'string', format: 'email' },
            code: { type: 'string', minLength: 6, maxLength: 6, description: '6-digit verification code' },
            name: { type: 'string', minLength: 2, maxLength: 255, description: 'Your name (required for new accounts)' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              tenant_id: { type: 'string' },
              api_key: { type: 'string', description: '⚠️ Save this — you will NOT see it again' },
              key_prefix: { type: 'string' },
              tier: { type: 'string' },
              rate_limit_rpm: { type: 'integer' },
              message: { type: 'string' },
              new_account: { type: 'boolean' },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } },
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

      // OTP valid — create account or return existing
      const accountName = (name || result.name || email.split('@')[0]) as string;

      try {
        const tenant = await apiKeyService.createTenant(accountName, email, 'free');

        // Send welcome email (fire-and-forget)
        emailService.sendWelcomeEmail(email, accountName, tenant.keyPrefix).catch(() => {});

        return reply.code(200).send({
          tenant_id: tenant.tenantId,
          api_key: tenant.rawKey,
          key_prefix: tenant.keyPrefix,
          tier: 'free',
          rate_limit_rpm: 60,
          message: '✅ Account created! Save your API key — you won\'t see it again.',
          new_account: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';

        if (message.includes('unique') || message.includes('duplicate') || message.includes('already exists')) {
          // Existing account — issue a new API key
          try {
            const existingTenant = await apiKeyService.findTenantByEmail(email);
            if (existingTenant) {
              const rotated = await apiKeyService.rotateApiKey(existingTenant.id);
              return reply.code(200).send({
                tenant_id: existingTenant.id,
                api_key: rotated.rawKey,
                key_prefix: rotated.keyPrefix,
                tier: 'free',
                rate_limit_rpm: 60,
                message: '✅ Signed in! Here\'s a new API key. Your old keys still work.',
                new_account: false,
              });
            }
          } catch {
            // Fall through to generic response
          }

          return reply.code(200).send({
            message: 'Email verified. Use your existing API key, or contact support for a new one.',
            email,
            tier: 'free',
            new_account: false,
          });
        }

        request.log.error({ err }, 'Account creation failed after OTP verification');
        return reply.code(500).send({
          error: { type: 'internal_error', message: 'Account creation failed. Please try again.' },
        });
      }
    },
  );

  // ===== RESEND OTP =====
  app.post(
    '/v1/auth/resend-otp',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Resend verification code',
        description: 'Resend a new 6-digit code to the same email. Rate limited: 1 per 60 seconds.',
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            name: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: { message: { type: 'string' }, expires_in: { type: 'integer' } },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SendOtpSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { type: 'invalid_request', message: 'Valid email required.' },
        });
      }

      const { email, name } = parsed.data;

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
      const sent = await emailService.sendVerificationCode(email, code, name);

      if (!sent) {
        return reply.code(500).send({
          error: { type: 'email_error', message: 'Failed to send email. Try again.' },
        });
      }

      return reply.code(200).send({
        message: 'New verification code sent!',
        expires_in: 600,
      });
    },
  );
}
