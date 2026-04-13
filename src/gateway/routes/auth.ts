/**
 * Auth Routes — self-service registration for AfrAI.
 *
 * POST /v1/auth/register — Create account and get API key
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ApiKeyService } from '../../services/apiKeyService.js';

const RegisterSchema = z.object({
  name: z.string().min(2).max(255),
  email: z.string().email().max(255),
});

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
          'Register a new developer account. Returns an API key — **save it immediately, you will not see it again.**\n\n' +
          'No password needed. Your API key is your authentication.\n\n' +
          'Free tier includes:\n' +
          '- 60 requests per minute\n' +
          '- Access to all AI models\n' +
          '- Smart routing',
        body: {
          type: 'object',
          required: ['name', 'email'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 255, description: 'Your name', examples: ['John Mensah'] },
            email: { type: 'string', format: 'email', description: 'Your email address', examples: ['john@example.com'] },
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
        return reply.code(400).send({
          error: {
            type: 'invalid_request_error',
            message: 'Invalid registration data.',
            details: parsed.error.flatten().fieldErrors,
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
          message: '⚠️ Save your API key now — you will NOT see it again. Use it in the Authorization header: Bearer ' + result.rawKey,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Registration failed';

        // Duplicate email
        if (message.includes('unique') || message.includes('duplicate') || message.includes('already exists')) {
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
