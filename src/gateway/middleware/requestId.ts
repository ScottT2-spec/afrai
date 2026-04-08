import { randomBytes } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/** Base62 alphabet */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generate a short unique request ID: req_ + 16 base62 chars.
 */
function generateRequestId(): string {
  const bytes = randomBytes(16);
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += BASE62[bytes[i]! % 62];
  }
  return `req_${id}`;
}

/**
 * Augment Fastify request with requestId.
 */
declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

/**
 * Request ID middleware — generates a unique ID for every request
 * and sets it on both the request object and X-Request-Id response header.
 */
export async function requestIdMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Use client-provided ID if present, otherwise generate
  const existing = request.headers['x-request-id'];
  const id = typeof existing === 'string' && existing.length > 0
    ? existing
    : generateRequestId();

  request.requestId = id;
  void reply.header('X-Request-Id', id);
}
