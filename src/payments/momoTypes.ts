/**
 * MTN MoMo Types — Type definitions for the MTN Mobile Money API.
 *
 * Covers the Collections API (receiving payments) for AfrAI wallet top-ups.
 * Reference: https://momodeveloper.mtn.com/api-documentation
 */

// ── Environment ─────────────────────────────────────────────────

export type MomoEnvironment = 'sandbox' | 'production';

export interface MomoConfig {
  /** MTN MoMo API subscription key (from developer portal) */
  readonly subscriptionKey: string;
  /** API user ID (UUID — created in sandbox, assigned in production) */
  readonly apiUserId: string;
  /** API key (generated after creating API user) */
  readonly apiKey: string;
  /** Target environment */
  readonly environment: MomoEnvironment;
  /** Currency code (GHS for Ghana, UGX for Uganda, EUR for sandbox) */
  readonly currency: string;
  /** Callback URL for async payment notifications */
  readonly callbackUrl?: string;
  /** Base URL override (defaults based on environment) */
  readonly baseUrl?: string;
}

// ── Collections API ─────────────────────────────────────────────

/** Payer identification */
export interface MomoPayer {
  /** Always 'MSISDN' for phone numbers */
  readonly partyIdType: 'MSISDN';
  /** Phone number in international format (e.g., '233XXXXXXXXX' for Ghana) */
  readonly partyId: string;
}

/** Request to Pay — initiates a payment from a customer */
export interface RequestToPayBody {
  /** Amount to charge (string, e.g., '10.00') */
  readonly amount: string;
  /** Currency code (e.g., 'GHS') */
  readonly currency: string;
  /** Your internal reference ID */
  readonly externalId: string;
  /** The customer being charged */
  readonly payer: MomoPayer;
  /** Message shown to the payer on their phone */
  readonly payerMessage: string;
  /** Internal note for the payee (you) */
  readonly payeeNote: string;
}

/** Payment status from MTN */
export type MomoPaymentStatus =
  | 'PENDING'
  | 'SUCCESSFUL'
  | 'FAILED';

/** Reason codes for failed payments */
export type MomoFailureReason =
  | 'PAYEE_NOT_FOUND'
  | 'PAYER_NOT_FOUND'
  | 'NOT_ALLOWED'
  | 'NOT_ALLOWED_TARGET_ENVIRONMENT'
  | 'INVALID_CALLBACK_URL_HOST'
  | 'INVALID_CURRENCY'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_PROCESSING_ERROR'
  | 'NOT_ENOUGH_FUNDS'
  | 'PAYER_LIMIT_REACHED'
  | 'PAYEE_NOT_ALLOWED_TO_RECEIVE'
  | 'PAYMENT_NOT_APPROVED'
  | 'RESOURCE_NOT_FOUND'
  | 'APPROVAL_REJECTED'
  | 'EXPIRED'
  | 'TRANSACTION_CANCELED'
  | 'RESOURCE_ALREADY_EXIST';

/** Response when checking payment status */
export interface RequestToPayResult {
  /** Amount charged */
  readonly amount: string;
  /** Currency */
  readonly currency: string;
  /** Financial transaction ID from MTN (only on success) */
  readonly financialTransactionId?: string;
  /** External ID you provided */
  readonly externalId: string;
  /** Payer info */
  readonly payer: MomoPayer;
  /** Payment status */
  readonly status: MomoPaymentStatus;
  /** Reason for failure (only when status is FAILED) */
  readonly reason?: MomoFailureReason;
}

/** MTN account balance */
export interface MomoAccountBalance {
  /** Available balance */
  readonly availableBalance: string;
  /** Currency */
  readonly currency: string;
}

/** OAuth2 token response */
export interface MomoTokenResponse {
  /** Bearer access token */
  readonly access_token: string;
  /** Token type (always 'access_token') */
  readonly token_type: string;
  /** Expiry in seconds (typically 3600) */
  readonly expires_in: number;
}

// ── AfrAI Payment Models ────────────────────────────────────────

/** Payment initiation request from the AfrAI API */
export interface TopUpRequest {
  /** Amount in the local currency (e.g., 10.00 GHS) */
  readonly amount: number;
  /** Customer phone number (e.g., '0241234567' or '233241234567') */
  readonly phoneNumber: string;
  /** Tenant ID making the payment */
  readonly tenantId: string;
}

/** Credit tiers — how much API credit per local currency amount */
export interface CreditTier {
  /** Amount in local currency */
  readonly amountLocal: number;
  /** API credits granted (in USD equivalent) */
  readonly creditsUsd: number;
  /** Display label */
  readonly label: string;
}

/** Internal payment record stored in the database */
export interface PaymentRecord {
  /** Internal payment ID (UUID) */
  readonly id: string;
  /** MTN reference ID (UUID sent with requesttopay) */
  readonly momoReferenceId: string;
  /** MTN financial transaction ID (received on success) */
  readonly momoTransactionId: string | null;
  /** Tenant who initiated the payment */
  readonly tenantId: string;
  /** Phone number charged */
  readonly phoneNumber: string;
  /** Amount in local currency */
  readonly amountLocal: string;
  /** Currency code */
  readonly currency: string;
  /** API credits to grant on success (USD) */
  readonly creditsUsd: string;
  /** Payment status */
  readonly status: 'pending' | 'successful' | 'failed' | 'expired';
  /** Failure reason if any */
  readonly failureReason: string | null;
  /** When the payment was initiated */
  readonly createdAt: Date;
  /** Last status update */
  readonly updatedAt: Date;
}

/** Wallet balance for a tenant */
export interface WalletBalance {
  /** Tenant ID */
  readonly tenantId: string;
  /** Available credits in USD */
  readonly balanceUsd: string;
  /** Total credits ever purchased */
  readonly totalPurchasedUsd: string;
  /** Total credits spent on API calls */
  readonly totalSpentUsd: string;
}

/** MoMo API error */
export class MomoApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly momoCode?: string,
  ) {
    super(message);
    this.name = 'MomoApiError';
  }
}
