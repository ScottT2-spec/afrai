import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { TenantContext } from '../../types/tenant.js';

/**
 * Augment Fastify request with tenant context.
 */
declare module 'fastify' {
  interface FastifyRequest {
    tenantContext: TenantContext | null;
  }
}

/**
 * Plugin that decorates every request with a tenantContext property.
 * The auth middleware populates it after key validation.
 */
async function tenantContextPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.decorateRequest('tenantContext', null);
}

export default fp(tenantContextPlugin, {
  name: 'tenant-context',
  fastify: '5.x',
});
