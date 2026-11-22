import crypto from 'crypto';
import type { Request } from 'express';
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  GatewayPaymentSnapshot,
  GatewayRuntimeConfig,
  ParsedWebhookEvent,
  PaymentProvider,
  PaymentStatus,
  RefundInput,
  RefundResult,
  TransactionValidationResult,
} from '../types.ts';

function paypalBaseUrl(env: 'sandbox' | 'production'): string {
  return env === 'production' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function mapPayPalStatus(ppStatus?: string): PaymentStatus {
  switch (ppStatus) {
    case 'COMPLETED':
      return 'approved';
    case 'DECLINED':
    case 'FAILED':
    case 'DENIED':
      return 'rejected';
    case 'VOIDED':
    case 'CANCELLED':
      return 'cancelled';
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'refunded';
    default:
      return 'pending';
  }
}

export class PayPalProvider implements PaymentProvider {
  readonly gatewayId = 'paypal';
  readonly displayName = 'PayPal';

  hasCredentials(config: GatewayRuntimeConfig): boolean {
    return Boolean(config.credentials.clientId && config.credentials.clientSecret);
  }

  private async getOAuthAccessToken(config: GatewayRuntimeConfig): Promise<string> {
    const clientId = config.credentials.clientId;
    const clientSecret = config.credentials.clientSecret;
    if (!clientId || !clientSecret) {
      throw new Error('Credenciais PayPal (Client ID e Client Secret) não configuradas.');
    }

    const base = paypalBaseUrl(config.environment);
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!res.ok || !data.access_token) {
      throw new Error(data.error_description || `Falha OAuth2 PayPal (HTTP ${res.status}).`);
    }
    return data.access_token;
  }

  async createPayment(input: CreatePaymentInput, config: GatewayRuntimeConfig): Promise<CreatePaymentResult> {
    const amountDecimal = (input.amountCents / 100).toFixed(2);
    const currency = (input.currency || 'BRL').toUpperCase();

    if (!this.hasCredentials(config)) {
      if (config.environment === 'production') {
        throw new Error('PayPal em produção requer PAYPAL_CLIENT_ID e PAYPAL_CLIENT_SECRET configurados.');
      }
      return {
        externalId: `pp-sbx-${input.paymentId.slice(0, 12)}`,
        status: 'pending',
        checkoutUrl: null,
        isLocalSandbox: true,
        rawMetadata: { mode: 'sandbox_local', method: input.paymentMethod, currency },
      };
    }

    const accessToken = await this.getOAuthAccessToken(config);
    const base = paypalBaseUrl(config.environment);

    const purchaseUnit: Record<string, unknown> = {
      reference_id: input.bookingId,
      custom_id: input.paymentId,
      description: `Aurum Privé — Sessão Privada (${input.professionalName})`,
      amount: {
        currency_code: currency,
        value: amountDecimal,
      },
    };

    // Marketplace platform_fees support when approved by PayPal Commerce Platform
    if (config.splitEnabled && input.splitAccountId) {
      const feeCents = Math.round((input.amountCents * input.commissionPercentage) / 100);
      purchaseUnit.payee = { merchant_id: input.splitAccountId };
      purchaseUnit.payment_instruction = {
        disbursement_mode: 'INSTANT',
        platform_fees: [
          {
            amount: {
              currency_code: currency,
              value: (feeCents / 100).toFixed(2),
            },
          },
        ],
      };
    }

    const res = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': input.idempotencyKey,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [purchaseUnit],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Aurum Privé',
              locale: currency === 'BRL' ? 'pt-BR' : 'en-US',
              user_action: 'PAY_NOW',
              return_url: `${input.appUrl}/cliente/agendamentos?gateway=paypal&payment=success&paymentId=${input.paymentId}`,
              cancel_url: `${input.appUrl}/cliente/agendamentos?gateway=paypal&payment=cancelled&paymentId=${input.paymentId}`,
            },
          },
        },
      }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      links?: Array<{ rel: string; href: string }>;
      message?: string;
    };

    const approveLink = data.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href || null;

    if (!res.ok || !data.id || !approveLink) {
      throw new Error(data.message || `Falha ao criar pedido PayPal (HTTP ${res.status}).`);
    }

    return {
      externalId: data.id,
      status: 'pending',
      checkoutUrl: approveLink,
      isLocalSandbox: false,
      rawMetadata: { paypalOrderId: data.id, environment: config.environment, currency },
    };
  }

  async getPayment(externalId: string, config: GatewayRuntimeConfig): Promise<GatewayPaymentSnapshot> {
    const accessToken = await this.getOAuthAccessToken(config);
    const base = paypalBaseUrl(config.environment);

    const res = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(externalId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      throw new Error(data.message || `Erro ao consultar pedido PayPal (HTTP ${res.status}).`);
    }

    const pu = data.purchase_units?.[0] || {};
    const capture = pu.payments?.captures?.[0];
    const amountVal = Number(capture?.amount?.value || pu.amount?.value || 0);
    const currency = String(capture?.amount?.currency_code || pu.amount?.currency_code || 'BRL').toUpperCase();
    const feeVal = Number(capture?.seller_receivable_breakdown?.paypal_fee?.value || 0);

    return {
      externalId: String(data.id || externalId),
      captureId: capture?.id ? String(capture.id) : null,
      status: capture ? mapPayPalStatus(capture.status) : mapPayPalStatus(data.status),
      amountCents: Math.round(amountVal * 100),
      currency,
      gatewayFeeCents: Math.max(0, Math.round(feeVal * 100)),
      externalReference: pu.custom_id ? String(pu.custom_id) : null,
      statusDetail: capture?.status || data.status || null,
      raw: data,
    };
  }

  async confirmPayment(externalId: string, config: GatewayRuntimeConfig): Promise<GatewayPaymentSnapshot> {
    const accessToken = await this.getOAuthAccessToken(config);
    const base = paypalBaseUrl(config.environment);

    const res = await fetch(`${base}/v2/checkout/orders/${encodeURIComponent(externalId)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `capture-${externalId}`,
      },
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      // If already captured, fetch current snapshot cleanly
      if (res.status === 422) {
        return this.getPayment(externalId, config);
      }
      throw new Error(data.message || `PayPal recusou captura do pagamento (HTTP ${res.status}).`);
    }

    const pu = data.purchase_units?.[0] || {};
    const capture = pu.payments?.captures?.[0];
    const amountVal = Number(capture?.amount?.value || pu.amount?.value || 0);
    const currency = String(capture?.amount?.currency_code || pu.amount?.currency_code || 'BRL').toUpperCase();
    const feeVal = Number(capture?.seller_receivable_breakdown?.paypal_fee?.value || 0);

    return {
      externalId: String(data.id || externalId),
      captureId: capture?.id ? String(capture.id) : null,
      status: capture ? mapPayPalStatus(capture.status) : mapPayPalStatus(data.status),
      amountCents: Math.round(amountVal * 100),
      currency,
      gatewayFeeCents: Math.max(0, Math.round(feeVal * 100)),
      externalReference: pu.custom_id ? String(pu.custom_id) : null,
      statusDetail: capture?.status || data.status || null,
      raw: data,
    };
  }

  async cancelPayment(externalId: string, _config: GatewayRuntimeConfig): Promise<{ cancelled: boolean; raw?: Record<string, unknown> }> {
    // Uncaptured PayPal Orders expire cleanly if not captured; mark cancelled locally
    return {
      cancelled: true,
      raw: { orderId: externalId, note: 'PayPal uncaptured order cancelled locally' },
    };
  }

  async requestRefund(input: RefundInput, config: GatewayRuntimeConfig): Promise<RefundResult> {
    const captureId = input.externalCaptureId || input.externalPaymentId;
    if (!this.hasCredentials(config) || !captureId || captureId.startsWith('pp-sbx-')) {
      return {
        externalRefundId: `pp-refund-sbx-${crypto.randomUUID().slice(0, 10)}`,
        status: 'refunded',
        isLocalSandbox: true,
      };
    }

    const accessToken = await this.getOAuthAccessToken(config);
    const base = paypalBaseUrl(config.environment);

    const body =
      input.amountCents > 0 && input.amountCents < input.totalAmountCents
        ? {
            amount: {
              value: (input.amountCents / 100).toFixed(2),
              currency_code: (input.currency || 'BRL').toUpperCase(),
            },
            note_to_payer: input.reason.slice(0, 255),
          }
        : {
            note_to_payer: input.reason.slice(0, 255),
          };

    const res = await fetch(`${base}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': input.idempotencyKey,
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json().catch(() => ({}))) as { id?: string; status?: string; message?: string };
    if (!res.ok) {
      throw new Error(data.message || `PayPal recusou o estorno (HTTP ${res.status}).`);
    }

    return {
      externalRefundId: String(data.id || `pp-ref-${crypto.randomUUID().slice(0, 8)}`),
      status: 'refunded',
      isLocalSandbox: false,
      raw: data as Record<string, unknown>,
    };
  }

  async parseAndVerifyWebhook(req: Request, config: GatewayRuntimeConfig): Promise<ParsedWebhookEvent> {
    const body = (req.body || {}) as Record<string, any>;
    const eventType = String(body.event_type || 'UNKNOWN');
    const eventId = body.id ? String(body.id) : null;
    const resource = (body.resource || {}) as Record<string, any>;
    const orderId =
      resource.supplementary_data?.related_ids?.order_id ||
      (eventType.startsWith('CHECKOUT.ORDER') ? resource.id : null) ||
      resource.id ||
      null;
    const externalReference = resource.custom_id || resource.purchase_units?.[0]?.custom_id || null;

    const webhookId = config.credentials.webhookId;
    let signatureValid = false;

    if (this.hasCredentials(config) && webhookId) {
      try {
        const transmissionId = String(req.headers['paypal-transmission-id'] || '');
        const transmissionTime = String(req.headers['paypal-transmission-time'] || '');
        const certUrl = String(req.headers['paypal-cert-url'] || '');
        const authAlgo = String(req.headers['paypal-auth-algo'] || '');
        const transmissionSig = String(req.headers['paypal-transmission-sig'] || '');

        if (transmissionId && transmissionTime && certUrl && authAlgo && transmissionSig) {
          const accessToken = await this.getOAuthAccessToken(config);
          const base = paypalBaseUrl(config.environment);
          const verifyRes = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              auth_algo: authAlgo,
              cert_url: certUrl,
              transmission_id: transmissionId,
              transmission_sig: transmissionSig,
              transmission_time: transmissionTime,
              webhook_id: webhookId,
              webhook_event: body,
            }),
          });
          const verifyData = (await verifyRes.json().catch(() => ({}))) as { verification_status?: string };
          signatureValid = verifyRes.ok && verifyData.verification_status === 'SUCCESS';
        }
      } catch {
        signatureValid = false;
      }
    } else if (config.environment === 'sandbox' && !webhookId && !this.hasCredentials(config)) {
      // Unconfigured local sandbox won't accept external unsigned calls anyway
      signatureValid = false;
    }

    if (!signatureValid) {
      return {
        gatewayId: this.gatewayId,
        eventId,
        eventType,
        resourceId: orderId ? String(orderId) : null,
        signatureValid: false,
        action: 'ignored',
        externalReference: externalReference ? String(externalReference) : null,
        rawPayload: body,
      };
    }

    let action: ParsedWebhookEvent['action'] = 'ignored';
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'CHECKOUT.ORDER.APPROVED') {
      action = 'payment_approved';
    } else if (eventType === 'PAYMENT.CAPTURE.DENIED' || eventType === 'PAYMENT.CAPTURE.DECLINED') {
      action = 'payment_rejected';
    } else if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType === 'PAYMENT.CAPTURE.REVERSED') {
      action = 'payment_refunded';
    }

    return {
      gatewayId: this.gatewayId,
      eventId,
      eventType,
      resourceId: orderId ? String(orderId) : null,
      signatureValid: true,
      action,
      externalReference: externalReference ? String(externalReference) : null,
      rawPayload: body,
    };
  }

  validateTransaction(
    localPayment: { id: string; provider: string; amount_cents: number; currency: string },
    snapshot: GatewayPaymentSnapshot
  ): TransactionValidationResult {
    if (localPayment.provider !== this.gatewayId) {
      return { valid: false, reason: 'Isolamento de gateway: transação pertence a outro provedor.' };
    }
    if (snapshot.externalReference && snapshot.externalReference !== localPayment.id) {
      return { valid: false, reason: 'custom_id do pedido PayPal não corresponde ao pagamento local.' };
    }
    if (snapshot.amountCents !== Number(localPayment.amount_cents)) {
      return {
        valid: false,
        reason: `Divergência de valor PayPal: esperado ${localPayment.amount_cents}, recebido ${snapshot.amountCents}.`,
      };
    }
    if (snapshot.currency.toUpperCase() !== String(localPayment.currency || 'BRL').toUpperCase()) {
      return { valid: false, reason: 'Moeda PayPal diverge da reserva.' };
    }
    return { valid: true };
  }

  async testConnection(config: GatewayRuntimeConfig): Promise<{ ok: boolean; status: string; message: string }> {
    if (!this.hasCredentials(config)) {
      if (config.environment === 'sandbox') {
        return {
          ok: true,
          status: 'sandbox_local',
          message: 'Sandbox Local ativo. Configure Client ID e Client Secret Sandbox para testar OAuth2 no PayPal.',
        };
      }
      return {
        ok: false,
        status: 'missing_credentials',
        message: 'Client ID / Client Secret de produção do PayPal não configurados.',
      };
    }

    try {
      await this.getOAuthAccessToken(config);
      return {
        ok: true,
        status: 'connected',
        message: `Autenticação OAuth2 PayPal validada (${config.environment}).`,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        message: err instanceof Error ? err.message : 'Falha na autenticação OAuth2 PayPal.',
      };
    }
  }
}
