import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuthMiddleware } from '../../../src/gateway/middleware/auth.js';
import type { TenantContext } from '../../../src/types/tenant.js';

// Mock Fastify request/reply
function mockRequest(headers: Record<string, string> = {}) {
  return {
    headers,
    tenantContext: null as TenantContext | null,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as any;
}

function mockReply() {
  const reply: any = {
    _code: 200,
    _body: null,
    code(c: number) { reply._code = c; return reply; },
    send(body: any) { reply._body = body; return reply; },
  };
  return reply;
}

// Mock ApiKeyService
function mockApiKeyService(result: TenantContext | null) {
  return {
    validateApiKey: vi.fn().mockResolvedValue(result),
  } as any;
}

const validContext: TenantContext = {
  id: 'tenant-123',
  tier: 'starter',
  apiKeyId: 'key-456',
  scopes: ['completions', 'embeddings'],
  rateLimitRpm: 300,
};

describe('Auth Middleware', () => {
  it('returns 401 when no API key is provided', async () => {
    const service = mockApiKeyService(null);
    const middleware = createAuthMiddleware(service);
    const req = mockRequest({});
    const reply = mockReply();

    await middleware(req, reply);

    expect(reply._code).toBe(401);
    expect(reply._body.error).toBe('Unauthorized');
  });

  it('returns 401 for invalid key format (no afr_live_ prefix)', async () => {
    const service = mockApiKeyService(null);
    const middleware = createAuthMiddleware(service);
    const req = mockRequest({ 'x-api-key': 'sk_bad_key_format' });
    const reply = mockReply();

    await middleware(req, reply);

    expect(reply._code).toBe(401);
    expect(reply._body.message).toContain('Invalid API key format');
    expect(service.validateApiKey).not.toHaveBeenCalled();
  });

  it('returns 401 when key is not found or inactive', async () => {
    const service = mockApiKeyService(null);
    const middleware = createAuthMiddleware(service);
    const req = mockRequest({ 'x-api-key': 'afr_live_invalidkey12345678901234' });
    const reply = mockReply();

    await middleware(req, reply);

    expect(reply._code).toBe(401);
    expect(service.validateApiKey).toHaveBeenCalledWith('afr_live_invalidkey12345678901234');
  });

  it('attaches tenant context on valid key via X-API-Key header', async () => {
    const service = mockApiKeyService(validContext);
    const middleware = createAuthMiddleware(service);
    const req = mockRequest({ 'x-api-key': 'afr_live_validkey00000000000000000' });
    const reply = mockReply();

    await middleware(req, reply);

    expect(req.tenantContext).toEqual(validContext);
    expect(reply._code).toBe(200); // not changed by middleware
  });

  it('supports Authorization: Bearer header', async () => {
    const service = mockApiKeyService(validContext);
    const middleware = createAuthMiddleware(service);
    const req = mockRequest({ authorization: 'Bearer afr_live_bearerkey000000000000000' });
    const reply = mockReply();

    await middleware(req, reply);

    expect(req.tenantContext).toEqual(validContext);
    expect(service.validateApiKey).toHaveBeenCalledWith('afr_live_bearerkey000000000000000');
  });

  it('prefers X-API-Key over Authorization header', async () => {
    const service = mockApiKeyService(validContext);
    const middleware = createAuthMiddleware(service);
    const req = mockRequest({
      'x-api-key': 'afr_live_preferred0000000000000000',
      authorization: 'Bearer afr_live_ignored000000000000000000',
    });
    const reply = mockReply();

    await middleware(req, reply);

    expect(service.validateApiKey).toHaveBeenCalledWith('afr_live_preferred0000000000000000');
  });

  it('returns 403 when key lacks the required scope', async () => {
    const limitedContext: TenantContext = {
      ...validContext,
      scopes: ['embeddings'], // no 'completions'
    };
    const service = mockApiKeyService(limitedContext);
    const middleware = createAuthMiddleware(service, 'completions');
    const req = mockRequest({ 'x-api-key': 'afr_live_noscope0000000000000000000' });
    const reply = mockReply();

    await middleware(req, reply);

    expect(reply._code).toBe(403);
    expect(reply._body.message).toContain('completions');
  });

  it('allows request when key has the required scope', async () => {
    const service = mockApiKeyService(validContext);
    const middleware = createAuthMiddleware(service, 'completions');
    const req = mockRequest({ 'x-api-key': 'afr_live_hasscope000000000000000000' });
    const reply = mockReply();

    await middleware(req, reply);

    expect(req.tenantContext).toEqual(validContext);
  });

  it('logs warning on failed auth attempt', async () => {
    const service = mockApiKeyService(null);
    const middleware = createAuthMiddleware(service);
    const req = mockRequest({ 'x-api-key': 'afr_live_badkey00000000000000000000' });
    const reply = mockReply();

    await middleware(req, reply);

    expect(req.log.warn).toHaveBeenCalled();
  });
});
