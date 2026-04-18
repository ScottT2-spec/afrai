/**
 * Auth Routes — self-service registration for AfrAI.
 *
 * POST /v1/auth/register — Create account (requires email verification first via OTP)
 *
 * The recommended flow is:
 * 1. POST /v1/auth/send-otp   → sends verification code to email
 * 2. POST /v1/auth/verify-otp → verifies code and creates account + returns API key
 *
 * This direct register endpoint is kept for API-first users who don't need a UI flow.
 * It still validates the email format strictly.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiKeyService } from '../../services/apiKeyService.js';

// Strict email validation — reject disposable/temporary email domains
const BLOCKED_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com', 'grr.la',
  'dispostable.com', 'mailnesia.com', '10minutemail.com', 'trashmail.com',
  'fakeinbox.com', 'mailcatch.com', 'temp-mail.org', 'getnada.com',
]);

const RegisterSchema = z.object({
  name: z.string().min(2).max(255),
  email: z.string().email().max(255).transform(v => v.toLowerCase().trim()),
}).refine(
  (data) => {
    const domain = data.email.split('@')[1];
    return domain ? !BLOCKED_DOMAINS.has(domain) : false;
  },
  { message: 'Please use a real email address. Disposable/temporary emails are not allowed.', path: ['email'] },
);

export interface AuthRouteOptions {
  apiKeyService: ApiKeyService;
}

export async function authRoutes(
  app: FastifyInstance,
  opts: AuthRouteOptions,
): Promise<void> {
  const { apiKeyService } = opts;

  app.post(
    '/v1/auth/register',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Create account and get API key',
        description:
          '**Recommended:** Use the OTP flow instead (`/v1/auth/send-otp` → `/v1/auth/verify-otp`) for verified accounts.\n\n' +
          'This endpoint creates an account directly. Returns an API key — **save it immediately, you will not see it again.**\n\n' +
          'Disposable/temporary email addresses are blocked.\n\n' +
          'Free tier includes:\n' +
          '- 60 requests per minute\n' +
          '- Access to all AI models\n' +
          '- Smart routing',
        body: {
          type: 'object',
          required: ['name', 'email'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 255, description: 'Your name', examples: ['John Mensah'] },
            email: { type: 'string', format: 'email', description: 'Your email address (no disposable emails)', examples: ['john@example.com'] },
          },
        },
        response: {
          201: {
            type: 'object',
            description: 'Account created successfully',
            properties: {
              tenant_id: { type: 'string', format: 'uuid' },
              api_key: { type: 'string', description: '⚠️ Save this — you will NOT see it again' },
              key_prefix: { type: 'string', description: 'Key prefix for identification' },
              tier: { type: 'string', enum: ['free'] },
              rate_limit_rpm: { type: 'integer' },
              message: { type: 'string' },
              verified: { type: 'boolean', description: 'Whether email is verified (use OTP flow for verified accounts)' },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } },
          },
          409: {
            type: 'object',
            description: 'Email already registered',
            properties: { error: { type: 'object', properties: { type: { type: 'string' }, message: { type: 'string' } } } },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        const fieldErrors = parsed.error.flatten().fieldErrors;
        const emailError = fieldErrors.email?.[0];
        return reply.code(400).send({
          error: {
            type: 'invalid_request_error',
            message: emailError || 'Invalid registration data.',
            details: fieldErrors,
          },
        });
      }

      const { name, email } = parsed.data;

      try {
        const result = await apiKeyService.createTenant(name, email, 'free');

        return reply.code(201).send({
          tenant_id: result.tenantId,
          api_key: result.rawKey,
          key_prefix: result.keyPrefix,
          tier: 'free',
          rate_limit_rpm: 60,
          verified: false,
          message:
            '⚠️ Save your API key now — you will NOT see it again.\n' +
            'Note: For a verified account, use the OTP flow (/v1/auth/send-otp → /v1/auth/verify-otp).\n' +
            'Authorization header: Bearer ' + result.rawKey,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Registration failed';

        const code = (err as any)?.code;
        if (code === '23505' || message.includes('unique') || message.includes('duplicate') || message.includes('already exists')) {
          return reply.code(409).send({
            error: {
              type: 'conflict',
              message: 'An account with this email already exists.',
            },
          });
        }

        request.log.error({ err }, 'Registration failed');
        return reply.code(500).send({
          error: {
            type: 'internal_error',
            message: 'Registration failed. Please try again.',
          },
        });
      }
    },
  );
}
