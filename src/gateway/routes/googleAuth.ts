/**
 * Google OAuth2 Routes — "Continue with Google" for AfrAI.
 *
 * GET  /v1/auth/google           — Redirect to Google consent screen
 * GET  /v1/auth/google/callback  — Handle Google redirect, create/login account
 *
 * Requires: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'crypto';
import type { ApiKeyService } from '../../services/apiKeyService.js';

export interface GoogleAuthRouteOptions {
  apiKeyService: ApiKeyService;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  frontendUrl: string;
}

// In-memory state store (CSRF protection). Production: use Redis.
const stateStore = new Map<string, { createdAt: number }>();

// Cleanup expired states every 5 min
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [key, val] of stateStore) {
    if (val.createdAt < cutoff) stateStore.delete(key);
  }
}, 5 * 60 * 1000);

export async function googleAuthRoutes(
  app: FastifyInstance,
  opts: GoogleAuthRouteOptions,
): Promise<void> {
  const { apiKeyService, clientId, clientSecret, redirectUri, frontendUrl } = opts;

  // ===== STEP 1: Redirect to Google =====
  app.get(
    '/v1/auth/google',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Sign in with Google',
        description: 'Redirects to Google OAuth2 consent screen.',
        response: {
          302: { type: 'null', description: 'Redirect to Google' },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const state = randomBytes(32).toString('hex');
      stateStore.set(state, { createdAt: Date.now() });

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'online',
        prompt: 'select_account',
      });

      return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    },
  );

  // ===== STEP 2: Google callback =====
  app.get(
    '/v1/auth/google/callback',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Google OAuth2 callback',
        description: 'Handles Google redirect. Exchanges code for user info, creates account, redirects to frontend with API key.',
        querystring: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            state: { type: 'string' },
            error: { type: 'string' },
          },
        },
        response: {
          302: { type: 'null', description: 'Redirect to frontend' },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { code?: string; state?: string; error?: string };

      // Handle Google errors (user denied, etc.)
      if (query.error) {
        return reply.redirect(`${frontendUrl}/auth?error=${encodeURIComponent(query.error)}`);
      }

      if (!query.code || !query.state) {
        return reply.redirect(`${frontendUrl}/auth?error=missing_params`);
      }

      // Verify state (CSRF)
      if (!stateStore.has(query.state)) {
        return reply.redirect(`${frontendUrl}/auth?error=invalid_state`);
      }
      stateStore.delete(query.state);

      try {
        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: query.code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          request.log.error({ status: tokenRes.status, body: errBody }, 'Google token exchange failed');
          return reply.redirect(`${frontendUrl}/auth?error=token_exchange_failed`);
        }

        const tokens = (await tokenRes.json()) as {
          access_token: string;
          id_token?: string;
        };

        // Get user info
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });

        if (!userRes.ok) {
          return reply.redirect(`${frontendUrl}/auth?error=userinfo_failed`);
        }

        const userInfo = await userRes.json() as { email?: string; name?: string };
        const gEmail: string = userInfo.email ?? '';
        const gName: string = userInfo.name ?? '';

        if (gEmail.length === 0) {
          return reply.redirect(`${frontendUrl}/auth?error=no_email`);
        }

        // Create account or sign in existing
        const accountName = gName.length > 0 ? gName : (gEmail.split('@')[0] ?? gEmail);

        // Check if user already exists
        const existingTenant = await apiKeyService.findTenantByEmail(gEmail);

        if (existingTenant) {
          // Existing account — issue a fresh API key
          const rotated = await apiKeyService.rotateApiKey(existingTenant.id);
          const callbackParams = new URLSearchParams();
          callbackParams.set('api_key', rotated.rawKey);
          callbackParams.set('name', existingTenant.name);
          callbackParams.set('email', gEmail);
          callbackParams.set('new_account', 'false');

          return reply.redirect(`${frontendUrl}/auth/callback?${callbackParams}`);
        }

        // New account
        const tenant = await apiKeyService.createTenant(accountName, gEmail, 'free');
        const callbackParams = new URLSearchParams();
        callbackParams.set('api_key', String(tenant.rawKey));
        callbackParams.set('name', String(accountName));
        callbackParams.set('email', gEmail);
        callbackParams.set('new_account', 'true');

        return reply.redirect(`${frontendUrl}/auth/callback?${callbackParams}`);
      } catch (err) {
        request.log.error({ err }, 'Google OAuth flow failed');
        return reply.redirect(`${frontendUrl}/auth?error=server_error`);
      }
    },
  );
}
