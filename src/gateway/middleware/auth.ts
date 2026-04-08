import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ApiKeyService } from '../../services/apiKeyService.js';

/**
 * Creates an auth preHandler hook that validates API keys
 * and attaches TenantContext to the request.
 *
 * @param apiKeyService - Service for key validation
 * @param requiredScope - Scope this route requires (e.g. 'completions')
 */
export function createAuthMiddleware(
  apiKeyService: ApiKeyService,
  requiredScope?: string,
) {
  return async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Extract API key from X-API-Key header or Authorization: Bearer
    const apiKey = extractApiKey(request);

    if (!apiKey) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing API key. Provide via X-API-Key header or Authorization: Bearer <key>',
      });
      return;
    }

    // Validate format
    if (!apiKey.startsWith('afr_live_')) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key format',
      });
      return;
    }

    // Resolve tenant context
    const context = await apiKeyService.validateApiKey(apiKey);

    if (!context) {
      request.log.warn({ keyPrefix: apiKey.slice(0, 12) }, 'Failed auth attempt');
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or inactive API key',
      });
      return;
    }

    // Check scope
    if (requiredScope && !context.scopes.includes(requiredScope)) {
      reply.code(403).send({
        error: 'Forbidden',
        message: `API key does not have the required scope: ${requiredScope}`,
      });
      return;
    }

    // Attach tenant context to request
    request.tenantContext = context;
  };
}

/**
 * Extract API key from request headers.
 * Supports: X-API-Key and Authorization: Bearer
 */
function extractApiKey(request: FastifyRequest): string | null {
  // Check X-API-Key header first
  const xApiKey = request.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.length > 0) {
    return xApiKey;
  }

  // Fall back to Authorization: Bearer
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }

  return null;
}
