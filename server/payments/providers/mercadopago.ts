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

function mapMercadoPagoStatus(mpStatus?: string): PaymentStatus {
  switch (mpStatus) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    case 'refunded':
    case 'charged_back':
      return 'refunded';
    default:
      return 'pending';
  }
}

function extractMpFeeCents(mpData: Record<string, any>): number {
  if (!Array.isArray(mpData.fee_details)) return 0;
  let total = 0;
  for (const fee of mpData.fee_details) {
    if (fee && typeof fee.amount === 'number') {
      total += Math.round(fee.amount * 100);
    }
  }
  return Math.max(0, total);
}

export function verifyMercadoPagoXSignature(params: {
  signatureHeader: string;
  requestIdHeader: string;
  dataId: string;
  webhookSecret: string;
}): boolean {
  const { signatureHeader, requestIdHeader, dataId, webhookSecret } = params;
  if (!webhookSecret || !signatureHeader) return false;

  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, part) => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      acc[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return acc;
  }, {});

  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const tsNum = Number(ts);
  if (Number.isFinite(tsNum) && tsNum > 0) {
    const tsSeconds = tsNum > 1e12 ? Math.floor(tsNum / 1000) : tsNum;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - tsSeconds) > 900) return false;
  }

  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (requestIdHeader) manifest += `request-id:${requestIdHeader};`;
  manifest += `ts:${ts};`;

  const expectedHex = crypto.createHmac('sha256', webhookSecret).update(manifest).digest('hex');
  const providedBuf = Buffer.from(v1.toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expectedHex.toLowerCase(), 'utf8');

  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export class MercadoPagoProvider implements PaymentProvider {
  readonly gatewayId = 'mercadopago';
  readonly displayName = 'Mercado Pago';

  hasCredentials(config: GatewayRuntimeConfig): boolean {
    return Boolean(config.credentials.accessToken);
  }

  async createPayment(input: CreatePaymentInput, config: GatewayRuntimeConfig): Promise<CreatePaymentResult> {
    const token = config.credentials.accessToken;
    const amountDecimal = Number((input.amountCents / 100).toFixed(2));
    const webhookUrl = `${input.appUrl}/api/payments/webhooks/mercadopago`;

    // Local Sandbox mode when no live Mercado Pago access token is configured yet
    if (!token) {
      if (config.environment === 'production') {
        throw new Error('Mercado Pago em produção requer MERCADOPAGO_ACCESS_TOKEN configurado no backend.');
      }
      const pixCopyPaste =
        input.paymentMethod === 'pix'
          ? `00020126580014BR.GOV.BCB.PIX0136aurum-mp-sbx-${input.paymentId.slice(0, 12)}5204000053039865406${amountDecimal.toFixed(
              2
            )}5802BR5911AURUM PRIVE6009SAO PAULO62070503***6304TEST`
          : null;

      return {
        externalId: `mp-sbx-${input.paymentId.slice(0, 12)}`,
        status: 'pending',
        pixCopyPaste,
        pixQrBase64: null,
        checkoutUrl: null,
        isLocalSandbox: true,
        rawMetadata: { mode: 'sandbox_local', method: input.paymentMethod },
      };
    }

    // 1. Direct PIX payment via Mercado Pago v1/payments
    if (input.paymentMethod === 'pix') {
      try {
        const nameParts = input.clientName.trim().split(/\s+/);
        const mpBody: Record<string, unknown> = {
          transaction_amount: amountDecimal,
          description: `Sessão Privada Aurum Privé — ${input.professionalName}`,
          payment_method_id: 'pix',
          external_reference: input.paymentId,
          notification_url: webhookUrl,
          payer: {
            email: input.clientEmail,
            first_name: nameParts[0] || 'Cliente',
            last_name: nameParts.slice(1).join(' ') || 'Aurum',
          },
          metadata: {
            payment_id: input.paymentId,
            booking_id: input.bookingId,
            gateway: 'mercadopago',
            environment: config.environment,
          },
        };

        // Optional marketplace split (application_fee) when account is eligible & enabled
        if (config.splitEnabled && input.splitAccountId) {
          const feeCents = Math.round((input.amountCents * input.commissionPercentage) / 100);
          mpBody.application_fee = Number((feeCents / 100).toFixed(2));
        }

        const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': input.idempotencyKey,
          },
          body: JSON.stringify(mpBody),
        });

        const mpData = (await mpRes.json()) as Record<string, any>;
        const txData = mpData.point_of_interaction?.transaction_data;
        if (mpRes.ok && mpData.id && txData?.qr_code) {
          return {
            externalId: String(mpData.id),
            status: mapMercadoPagoStatus(mpData.status),
            pixCopyPaste: String(txData.qr_code),
            pixQrBase64: txData.qr_code_base64 ? String(txData.qr_code_base64) : null,
            checkoutUrl: txData.ticket_url ? String(txData.ticket_url) : null,
            isLocalSandbox: false,
            gatewayFeeCents: extractMpFeeCents(mpData),
            rawMetadata: { mpPaymentId: mpData.id, environment: config.environment },
          };
        }
      } catch {
        // Fallback to Checkout Pro Preference below
      }
    }

    // 2. Checkout Pro Preference (Credit/Debit Card or PIX fallback)
    const excludedTypes =
      input.paymentMethod === 'credit_card'
        ? [{ id: 'ticket' }, { id: 'debit_card' }]
        : input.paymentMethod === 'debit_card'
          ? [{ id: 'ticket' }, { id: 'credit_card' }]
          : [];

    const prefBody: Record<string, unknown> = {
      items: [
        {
          id: input.bookingId,
          title: `Sessão Privada — ${input.professionalName} (${input.durationMinutes} min)`,
          quantity: 1,
          currency_id: input.currency || 'BRL',
          unit_price: amountDecimal,
        },
      ],
      payer: {
        name: input.clientName,
        email: input.clientEmail,
      },
      payment_methods: {
        excluded_payment_types: excludedTypes,
      },
      external_reference: input.paymentId,
      notification_url: webhookUrl,
      back_urls: {
        success: `${input.appUrl}/cliente/agendamentos?gateway=mercadopago&payment=success&paymentId=${input.paymentId}`,
        pending: `${input.appUrl}/cliente/agendamentos?gateway=mercadopago&payment=pending&paymentId=${input.paymentId}`,
        failure: `${input.appUrl}/cliente/agendamentos?gateway=mercadopago&payment=failure&paymentId=${input.paymentId}`,
      },
      auto_return: 'approved',
      metadata: {
        payment_id: input.paymentId,
        booking_id: input.bookingId,
        gateway: 'mercadopago',
        environment: config.environment,
      },
    };

    if (config.splitEnabled && input.splitAccountId) {
      const feeCents = Math.round((input.amountCents * input.commissionPercentage) / 100);
      prefBody.marketplace_fee = Number((feeCents / 100).toFixed(2));
    }

    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify(prefBody),
    });

    const prefData = (await prefRes.json()) as {
      id?: string;
      init_point?: string;
      sandbox_init_point?: string;
      message?: string;
    };

    const checkoutUrl =
      config.environment === 'sandbox'
        ? prefData.sandbox_init_point || prefData.init_point
        : prefData.init_point || prefData.sandbox_init_point;

    if (!prefRes.ok || !checkoutUrl) {
      throw new Error(prefData.message || 'O Mercado Pago não retornou link de checkout válido.');
    }

    return {
      externalId: prefData.id || null,
      status: 'pending',
      checkoutUrl,
      isLocalSandbox: false,
      rawMetadata: { preferenceId: prefData.id, environment: config.environment },
    };
  }

  async getPayment(externalId: string, config: GatewayRuntimeConfig): Promise<GatewayPaymentSnapshot> {
    const token = config.credentials.accessToken;
    if (!token) {
      throw new Error('Token do Mercado Pago não configurado.');
    }

    const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(externalId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as Record<string, any>;
    if (!res.ok) {
      throw new Error(data.message || `Falha ao consultar pagamento Mercado Pago (HTTP ${res.status}).`);
    }

    return {
      externalId: String(data.id || externalId),
      status: mapMercadoPagoStatus(data.status),
      amountCents: Math.round(Number(data.transaction_amount || 0) * 100),
      currency: String(data.currency_id || 'BRL').toUpperCase(),
      gatewayFeeCents: extractMpFeeCents(data),
      externalReference: data.external_reference ? String(data.external_reference) : null,
      statusDetail: data.status_detail ? String(data.status_detail) : null,
      raw: data,
    };
  }

  async confirmPayment(externalId: string, config: GatewayRuntimeConfig): Promise<GatewayPaymentSnapshot> {
    // Mercado Pago confirms asynchronously via Checkout/PIX webhook; confirmPayment queries authoritative API
    return this.getPayment(externalId, config);
  }

  async cancelPayment(externalId: string, config: GatewayRuntimeConfig): Promise<{ cancelled: boolean; raw?: Record<string, unknown> }> {
    const token = config.credentials.accessToken;
    if (!token || externalId.startsWith('mp-sbx-')) {
      return { cancelled: true, raw: { sandboxLocal: true } };
    }

    // Only numeric payment IDs can be cancelled via /v1/payments/{id}
    if (!/^\d+$/.test(externalId)) {
      return { cancelled: true, raw: { preferenceCancelledLocally: true } };
    }

    const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(externalId)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(String(data.message || `Mercado Pago recusou cancelamento (HTTP ${res.status}).`));
    }
    return { cancelled: true, raw: data };
  }

  async requestRefund(input: RefundInput, config: GatewayRuntimeConfig): Promise<RefundResult> {
    const token = config.credentials.accessToken;
    if (!token || !input.externalPaymentId || input.externalPaymentId.startsWith('mp-sbx-') || input.externalPaymentId.startsWith('mp-demo-') || input.externalPaymentId.startsWith('mp-sandbox-')) {
      return {
        externalRefundId: `mp-refund-sbx-${crypto.randomUUID().slice(0, 10)}`,
        status: 'refunded',
        isLocalSandbox: true,
      };
    }

    const body =
      input.amountCents > 0 && input.amountCents < input.totalAmountCents
        ? { amount: Number((input.amountCents / 100).toFixed(2)) }
        : {};

    const res = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(input.externalPaymentId)}/refunds`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify(body),
      }
    );

    const data = (await res.json().catch(() => ({}))) as { id?: number | string; message?: string };
    if (!res.ok) {
      throw new Error(data.message || `Mercado Pago recusou estorno (HTTP ${res.status}).`);
    }

    return {
      externalRefundId: String(data.id || `mp-ref-${crypto.randomUUID().slice(0, 8)}`),
      status: 'refunded',
      isLocalSandbox: false,
      raw: data as Record<string, unknown>,
    };
  }

  async parseAndVerifyWebhook(req: Request, config: GatewayRuntimeConfig): Promise<ParsedWebhookEvent> {
    const dataId = String(req.query['data.id'] || req.body?.data?.id || req.body?.id || '').trim();
    const sigHeader = String(req.headers['x-signature'] || '');
    const requestIdHeader = String(req.headers['x-request-id'] || '');
    const eventType = String(req.body?.type || req.body?.action || req.query.topic || 'payment');
    const eventId = req.body?.id ? String(req.body.id) : null;
    const webhookSecret = config.credentials.webhookSecret;

    let signatureValid = true;
    if (webhookSecret) {
      signatureValid = verifyMercadoPagoXSignature({
        signatureHeader: sigHeader,
        requestIdHeader,
        dataId,
        webhookSecret,
      });
    } else if (config.environment === 'production') {
      // Production strictly requires webhook secret
      signatureValid = false;
    }

    if (!signatureValid) {
      return {
        gatewayId: this.gatewayId,
        eventId,
        eventType,
        resourceId: dataId || null,
        signatureValid: false,
        action: 'ignored',
        rawPayload: (req.body || {}) as Record<string, unknown>,
      };
    }

    const isPaymentEvent = !req.body?.type || req.body.type === 'payment';
    return {
      gatewayId: this.gatewayId,
      eventId,
      eventType,
      resourceId: dataId || null,
      signatureValid: true,
      action: isPaymentEvent && dataId ? 'payment_updated' : 'ignored',
      rawPayload: (req.body || {}) as Record<string, unknown>,
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
      return { valid: false, reason: 'Referência externa diverge do pagamento local.' };
    }
    if (snapshot.amountCents !== Number(localPayment.amount_cents)) {
      return {
        valid: false,
        reason: `Divergência de valor: esperado ${localPayment.amount_cents}, recebido ${snapshot.amountCents}.`,
      };
    }
    if (snapshot.currency.toUpperCase() !== String(localPayment.currency || 'BRL').toUpperCase()) {
      return { valid: false, reason: 'Moeda da transação diverge da reserva.' };
    }
    return { valid: true };
  }

  async testConnection(config: GatewayRuntimeConfig): Promise<{ ok: boolean; status: string; message: string }> {
    const token = config.credentials.accessToken;
    if (!token) {
      if (config.environment === 'sandbox') {
        return {
          ok: true,
          status: 'sandbox_local',
          message: 'Sandbox Local ativo. Configure o Access Token de teste para validar contra a API Mercado Pago.',
        };
      }
      return {
        ok: false,
        status: 'missing_credentials',
        message: 'Access Token de produção não configurado.',
      };
    }

    try {
      const res = await fetch('https://api.mercadopago.com/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as { id?: number; nickname?: string; message?: string };
      if (!res.ok) {
        return {
          ok: false,
          status: 'error',
          message: data.message || `Erro Mercado Pago (HTTP ${res.status})`,
        };
      }
      return {
        ok: true,
        status: 'connected',
        message: `Conectado ao Mercado Pago (${data.nickname || data.id || config.environment}).`,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'unreachable',
        message: err instanceof Error ? err.message : 'Falha de rede ao consultar Mercado Pago.',
      };
    }
  }
}
