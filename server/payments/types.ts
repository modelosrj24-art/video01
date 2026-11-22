import type { Request } from 'express';

export type GatewayId = 'mercadopago' | 'paypal' | string;
export type GatewayEnvironment = 'sandbox' | 'production';
export type PaymentStatus = 'pending' | 'approved' | 'rejected' | 'refunded' | 'cancelled';

export interface GatewayRuntimeConfig {
  id: GatewayId;
  displayName: string;
  isEnabled: boolean;
  environment: GatewayEnvironment;
  supportedMethods: string[];
  supportedCurrencies: string[];
  splitEnabled: boolean;
  complianceVerified: boolean;
  credentials: Record<string, string>;
  hasLiveCredentials: boolean;
}

export interface CreatePaymentInput {
  paymentId: string;
  bookingId: string;
  clientId: string;
  clientName: string;
  clientEmail: string;
  professionalId: string;
  professionalName: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  durationMinutes: number;
  commissionPercentage: number;
  idempotencyKey: string;
  appUrl: string;
  splitAccountId?: string;
}

export interface CreatePaymentResult {
  externalId: string | null;
  status: PaymentStatus;
  checkoutUrl?: string | null;
  pixCopyPaste?: string | null;
  pixQrBase64?: string | null;
  isLocalSandbox: boolean;
  gatewayFeeCents?: number;
  rawMetadata?: Record<string, unknown>;
}

export interface GatewayPaymentSnapshot {
  externalId: string;
  captureId?: string | null;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  gatewayFeeCents: number;
  externalReference?: string | null;
  statusDetail?: string | null;
  raw?: Record<string, unknown>;
}

export interface RefundInput {
  paymentId: string;
  externalPaymentId: string | null;
  externalCaptureId?: string | null;
  amountCents: number;
  totalAmountCents: number;
  currency: string;
  reason: string;
  idempotencyKey: string;
}

export interface RefundResult {
  externalRefundId: string;
  status: 'refunded';
  isLocalSandbox: boolean;
  raw?: Record<string, unknown>;
}

export interface ParsedWebhookEvent {
  gatewayId: GatewayId;
  eventId: string | null;
  eventType: string;
  resourceId: string | null;
  signatureValid: boolean;
  action: 'payment_updated' | 'payment_approved' | 'payment_rejected' | 'payment_cancelled' | 'payment_refunded' | 'ignored';
  externalReference?: string | null;
  rawPayload: Record<string, unknown>;
}

export interface TransactionValidationResult {
  valid: boolean;
  reason?: string;
}

export interface PaymentProvider {
  readonly gatewayId: GatewayId;
  readonly displayName: string;

  hasCredentials(config: GatewayRuntimeConfig): boolean;

  createPayment(input: CreatePaymentInput, config: GatewayRuntimeConfig): Promise<CreatePaymentResult>;

  getPayment(externalId: string, config: GatewayRuntimeConfig): Promise<GatewayPaymentSnapshot>;

  confirmPayment(externalId: string, config: GatewayRuntimeConfig): Promise<GatewayPaymentSnapshot>;

  cancelPayment(externalId: string, config: GatewayRuntimeConfig): Promise<{ cancelled: boolean; raw?: Record<string, unknown> }>;

  requestRefund(input: RefundInput, config: GatewayRuntimeConfig): Promise<RefundResult>;

  parseAndVerifyWebhook(req: Request, config: GatewayRuntimeConfig): Promise<ParsedWebhookEvent>;

  validateTransaction(
    localPayment: { id: string; provider: string; amount_cents: number; currency: string },
    snapshot: GatewayPaymentSnapshot
  ): TransactionValidationResult;

  testConnection(config: GatewayRuntimeConfig): Promise<{ ok: boolean; status: string; message: string }>;
}
