/**
 * MTN MoMo API Client — Low-level HTTP client for MTN Mobile Money Collections API.
 *
 * Handles:
 *   - OAuth2 token management (auto-refresh)
 *   - Request to Pay (initiate payment)
 *   - Payment status polling
 *   - Account balance queries
 *   - Phone number validation (Ghana format)
 *
 * This is the first AI API platform in the world to accept MoMo payments.
 * Built for Africa. Built different.
 *
 * Reference: https://momodeveloper.mtn.com/docs/services/collection
 */

import { randomUUID } from 'node:crypto';
import type {
  MomoConfig,
  MomoEnvironment,
  MomoTokenResponse,
  RequestToPayBody,
  RequestToPayResult,
  MomoAccountBalance,
  MomoPayer,
} from './momoTypes.js';
import { MomoApiError } from './momoTypes.js';

// ── Constants ───────────────────────────────────────────────────

const SANDBOX_BASE_URL = 'https://sandbox.momodeveloper.mtn.com';
const PRODUCTION_BASE_URL = 'https://proxy.momoapi.mtn.com';

/** Token refresh buffer — refresh 5 minutes before expiry */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Maximum retries for transient failures */
const MAX_RETRIES = 3;

/** Retry backoff base in ms */
const RETRY_BACKOFF_MS = 1000;

// ── Phone number utilities ──────────────────────────────────────

/**
 * Normalize a Ghanaian phone number to international format (233XXXXXXXXX).
 *
 * Accepts:
 *   - 0241234567  → 233241234567
 *   - 233241234567 → 233241234567
 *   - +233241234567 → 233241234567
 *   - 241234567 → 233241234567
 *
 * @throws Error if the number is invalid
 */
export function normalizeGhanaPhone(phone: string): string {
  // Strip whitespace, dashes, and leading +
  const cleaned = phone.replace(/[\s\-()]/g, '').replace(/^\+/, '');

  let normalized: string;

  if (cleaned.startsWith('233') && cleaned.length === 12) {
    // Already in international format
    normalized = cleaned;
  } else if (cleaned.startsWith('0') && cleaned.length === 10) {
    // Local format: 0XX XXXX XXX
    normalized = '233' + cleaned.slice(1);
  } else if (cleaned.length === 9 && /^[2-5]/.test(cleaned)) {
    // Without leading 0: XX XXXX XXX
    normalized = '233' + cleaned;
  } else {
    throw new Error(
      `Invalid Ghanaian phone number: '${phone}'. ` +
      `Expected format: 0241234567, 233241234567, or +233241234567`
    );
  }

  // Validate network prefix (Ghana mobile prefixes)
  const prefix = normalized.slice(3, 5);
  const validPrefixes = [
    '20', '23', '24', '25', '26', '27', '28', '29', // MTN / AirtelTigo
    '50', '53', '54', '55', '59',                     // MTN / Vodafone
  ];

  if (!validPrefixes.includes(prefix)) {
    throw new Error(
      `Invalid Ghana mobile prefix: '${prefix}'. Number: '${phone}'`
    );
  }

  return normalized;
}

/**
 * Validate that a phone number looks like a valid MTN Ghana number.
 * MTN prefixes: 024, 025, 053, 054, 055, 059
 */
export function isMtnGhanaNumber(phone: string): boolean {
  try {
    const normalized = normalizeGhanaPhone(phone);
    const prefix = normalized.slice(3, 5);
    const mtnPrefixes = ['24', '25', '53', '54', '55', '59'];
    return mtnPrefixes.includes(prefix);
  } catch {
    return false;
  }
}

// ── MoMo Client ─────────────────────────────────────────────────

export class MomoClient {
  private readonly config: MomoConfig;
  private readonly baseUrl: string;

  /** Cached OAuth2 token */
  private accessToken: string | null = null;
  /** Token expiry timestamp */
  private tokenExpiresAt: number = 0;

  constructor(config: MomoConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl ?? (
      config.environment === 'sandbox' ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL
    );
  }

  // ── Authentication ──────────────────────────────────────────

  /**
   * Get a valid OAuth2 access token, refreshing if needed.
   * Uses Basic auth with apiUserId:apiKey to obtain a Bearer token.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const credentials = Buffer.from(
      `${this.config.apiUserId}:${this.config.apiKey}`
    ).toString('base64');

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/collection/token/`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new MomoApiError(
        `Token request failed: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    const data = await response.json() as MomoTokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in * 1000) - TOKEN_REFRESH_BUFFER_MS;

    return this.accessToken;
  }

  // ── Collections API ─────────────────────────────────────────

  /**
   * Initiate a Request to Pay.
   *
   * This sends a payment prompt to the customer's phone.
   * They'll see a USSD dialog asking them to confirm the payment.
   *
   * Flow:
   *   1. We call this → MTN receives the request
   *   2. Customer gets USSD prompt on their phone
   *   3. Customer enters MoMo PIN to confirm (or cancels)
   *   4. We poll getPaymentStatus() or receive a callback
   *
   * @param params Payment parameters
   * @returns The reference ID (UUID) to track this payment
   */
  async requestToPay(params: {
    amount: number;
    currency?: string;
    phoneNumber: string;
    externalId: string;
    payerMessage?: string;
    payeeNote?: string;
  }): Promise<string> {
    const token = await this.getAccessToken();
    const referenceId = randomUUID();
    const currency = params.currency ?? this.config.currency;

    // Normalize phone number
    const normalizedPhone = normalizeGhanaPhone(params.phoneNumber);

    const body: RequestToPayBody = {
      amount: params.amount.toFixed(2),
      currency,
      externalId: params.externalId,
      payer: {
        partyIdType: 'MSISDN',
        partyId: normalizedPhone,
      },
      payerMessage: params.payerMessage ?? `AfrAI API credits — ${currency} ${params.amount.toFixed(2)}`,
      payeeNote: params.payeeNote ?? `Top-up ${params.externalId}`,
    };

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'X-Reference-Id': referenceId,
      'X-Target-Environment': this.config.environment,
      'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
      'Content-Type': 'application/json',
    };

    if (this.config.callbackUrl) {
      headers['X-Callback-Url'] = this.config.callbackUrl;
    }

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/collection/v1_0/requesttopay`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }
    );

    // 202 Accepted = payment request submitted successfully
    if (response.status !== 202) {
      const errorBody = await response.text().catch(() => 'No body');
      throw new MomoApiError(
        `Request to Pay failed: ${response.status} — ${errorBody}`,
        response.status,
      );
    }

    return referenceId;
  }

  /**
   * Check the status of a Request to Pay.
   *
   * @param referenceId The UUID returned by requestToPay()
   * @returns Payment result with status (PENDING, SUCCESSFUL, FAILED)
   */
  async getPaymentStatus(referenceId: string): Promise<RequestToPayResult> {
    const token = await this.getAccessToken();

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/collection/v1_0/requesttopay/${referenceId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Target-Environment': this.config.environment,
          'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
        },
      }
    );

    if (!response.ok) {
      throw new MomoApiError(
        `Payment status check failed: ${response.status}`,
        response.status,
      );
    }

    return response.json() as Promise<RequestToPayResult>;
  }

  /**
   * Get the MoMo Collections account balance.
   */
  async getAccountBalance(): Promise<MomoAccountBalance> {
    const token = await this.getAccessToken();

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/collection/v1_0/account/balance`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Target-Environment': this.config.environment,
          'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
        },
      }
    );

    if (!response.ok) {
      throw new MomoApiError(
        `Balance check failed: ${response.status}`,
        response.status,
      );
    }

    return response.json() as Promise<MomoAccountBalance>;
  }

  /**
   * Validate that a phone number is registered with MoMo.
   * Uses the Account Holder validation endpoint.
   *
   * @param phoneNumber Phone number to validate
   * @returns true if the account exists
   */
  async validateAccountHolder(phoneNumber: string): Promise<boolean> {
    const token = await this.getAccessToken();
    const normalized = normalizeGhanaPhone(phoneNumber);

    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/collection/v1_0/accountholder/msisdn/${normalized}/active`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Target-Environment': this.config.environment,
            'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
          },
        }
      );

      if (response.ok) {
        const data = await response.json() as { result: boolean };
        return data.result === true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Sandbox Provisioning ────────────────────────────────────

  /**
   * Create an API user in the sandbox environment.
   * Only needed for sandbox testing — production users are provisioned
   * through the MTN MoMo developer portal.
   */
  async createSandboxUser(callbackHost: string): Promise<{ userId: string; apiKey: string }> {
    if (this.config.environment !== 'sandbox') {
      throw new Error('Sandbox user creation is only available in sandbox environment');
    }

    const userId = randomUUID();

    // Step 1: Create API user
    const createResponse = await fetch(`${this.baseUrl}/v1_0/apiuser`, {
      method: 'POST',
      headers: {
        'X-Reference-Id': userId,
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ providerCallbackHost: callbackHost }),
    });

    if (createResponse.status !== 201) {
      throw new MomoApiError(
        `Failed to create sandbox user: ${createResponse.status}`,
        createResponse.status,
      );
    }

    // Step 2: Generate API key
    const keyResponse = await fetch(`${this.baseUrl}/v1_0/apiuser/${userId}/apikey`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.config.subscriptionKey,
      },
    });

    if (keyResponse.status !== 201) {
      throw new MomoApiError(
        `Failed to generate API key: ${keyResponse.status}`,
        keyResponse.status,
      );
    }

    const keyData = await keyResponse.json() as { apiKey: string };

    return { userId, apiKey: keyData.apiKey };
  }

  // ── Internals ───────────────────────────────────────────────

  /**
   * Fetch with exponential backoff retry for transient failures.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    retries: number = MAX_RETRIES,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, init);

        // Don't retry client errors (4xx) except 429
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return response;
        }

        // Retry on 429 (rate limit) and 5xx (server errors)
        if (response.status === 429 || response.status >= 500) {
          if (attempt < retries) {
            const retryAfter = response.headers.get('Retry-After');
            const delayMs = retryAfter
              ? parseInt(retryAfter, 10) * 1000
              : RETRY_BACKOFF_MS * Math.pow(2, attempt);
            await this.delay(delayMs);
            continue;
          }
        }

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) {
          await this.delay(RETRY_BACKOFF_MS * Math.pow(2, attempt));
        }
      }
    }

    throw new MomoApiError(
      `Request failed after ${retries + 1} attempts: ${lastError?.message}`,
      0,
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
