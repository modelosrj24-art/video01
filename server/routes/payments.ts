import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  createAuthMiddleware,
  requireRole,
  signSandboxWebhook,
  verifySandboxWebhook,
  logAudit,
  type AuthenticatedRequest,
} from '../security.ts';
import type { RealtimeHub } from '../ws.ts';
import { loadGatewayRuntimeConfig } from '../payments/credentials.ts';
import { getPaymentProvider } from '../payments/registry.ts';
import {
  calculateFinancialSplit,
  finalizeConfirmedPayment,
  processGatewayRefund,
  rejectOrCancelPaymentRecord,
  resolveCommissionPercentage,
} from '../payments/ledger-service.ts';
import type { GatewayId } from '../payments/types.ts';

export function createPaymentsRouter(db: Database.Database, hub: RealtimeHub): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);

  // Public non-secret list of enabled payment gateways for checkout UI
  router.get('/gateways', (_req, res) => {
    const rows = db
      .prepare('SELECT * FROM payment_gateways WHERE is_enabled = 1 ORDER BY id ASC')
      .all() as Array<Record<string, unknown>>;

    const gateways = rows.map((row) => {
      const cfg = loadGatewayRuntimeConfig(db, String(row.id));
      return {
        id: String(row.id),
        displayName: String(row.display_name),
        environment: cfg?.environment || 'sandbox',
        supportedMethods: cfg?.supportedMethods || [],
        supportedCurrencies: cfg?.supportedCurrencies || ['BRL'],
        hasLiveCredentials: cfg?.hasLiveCredentials || false,
        splitEnabled: cfg?.splitEnabled || false,
        healthStatus: String(row.last_health_status || 'sandbox_ready'),
        healthMessage: String(row.last_health_message || ''),
      };
    });

    res.json({ gateways });
  });

  // Backward-compatible config summary (no secrets)
  router.get('/config', (_req, res) => {
    const mp = loadGatewayRuntimeConfig(db, 'mercadopago');
    const pp = loadGatewayRuntimeConfig(db, 'paypal');
    res.json({
      configured: Boolean(mp?.hasLiveCredentials),
      environment: mp?.hasLiveCredentials ? mp.environment : 'local_sandbox',
      isTestMode: mp?.environment !== 'production',
      gateways: {
        mercadopago: { enabled: Boolean(mp?.isEnabled), environment: mp?.environment || 'sandbox', hasLiveCredentials: Boolean(mp?.hasLiveCredentials) },
        paypal: { enabled: Boolean(pp?.isEnabled), environment: pp?.environment || 'sandbox', hasLiveCredentials: Boolean(pp?.hasLiveCredentials) },
      },
    });
  });

  // Multi-gateway checkout creation with idempotency & duplicate protection
  router.post('/create-checkout', requireAuth, requireRole('client'), async (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      bookingId: z.string().min(1),
      gateway: z.enum(['mercadopago', 'paypal']).default('mercadopago'),
      paymentMethod: z
        .enum(['pix', 'credit_card', 'debit_card', 'paypal_account', 'international'])
        .optional(),
      currency: z.enum(['BRL', 'USD', 'EUR']).optional().default('BRL'),
      idempotencyKey: z.string().min(6).max(120).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados de pagamento inválidos.' });
      return;
    }

    const gatewayId = parsed.data.gateway;
    const provider = getPaymentProvider(gatewayId);
    const config = loadGatewayRuntimeConfig(db, gatewayId);

    if (!provider || !config) {
      res.status(404).json({ error: 'Gateway de pagamento não encontrado.' });
      return;
    }
    if (!config.isEnabled) {
      res.status(400).json({
        error: `O gateway ${config.displayName} está desativado no momento. Escolha outro meio de pagamento disponível.`,
      });
      return;
    }

    const defaultMethod = gatewayId === 'paypal' ? 'paypal_account' : 'pix';
    const paymentMethod = parsed.data.paymentMethod || defaultMethod;
    if (!config.supportedMethods.includes(paymentMethod)) {
      res.status(400).json({
        error: `O método "${paymentMethod}" não está habilitado para ${config.displayName}.`,
      });
      return;
    }

    const currency = parsed.data.currency.toUpperCase();
    if (!config.supportedCurrencies.includes(currency)) {
      res.status(400).json({
        error: `A moeda "${currency}" não está habilitada para ${config.displayName}.`,
      });
      return;
    }

    const client = db
      .prepare(
        `SELECT c.id, p.full_name, p.email
         FROM clients c JOIN profiles p ON p.id = c.user_id
         WHERE c.user_id = ?`
      )
      .get(req.auth!.userId) as { id: string; full_name: string; email: string } | undefined;

    if (!client) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }

    const booking = db
      .prepare(
        `SELECT b.*, pr.professional_name, pr.commission_percentage
         FROM bookings b JOIN professionals pr ON pr.id = b.professional_id
         WHERE b.id = ? AND b.client_id = ?`
      )
      .get(parsed.data.bookingId, client.id) as Record<string, unknown> | undefined;

    if (!booking) {
      res.status(404).json({ error: 'Agendamento não encontrado.' });
      return;
    }
    if (booking.status !== 'aguardando_pagamento') {
      res.status(409).json({ error: 'Este agendamento já foi pago, cancelado ou expirado.' });
      return;
    }

    // Prevent duplicate payment if an approved payment already exists
    const alreadyApproved = db
      .prepare("SELECT id FROM payments WHERE booking_id = ? AND status = 'approved' LIMIT 1")
      .get(booking.id);
    if (alreadyApproved) {
      res.status(409).json({ error: 'Já existe um pagamento aprovado para este agendamento.' });
      return;
    }

    const reqIdempotencyKey =
      parsed.data.idempotencyKey || `${gatewayId}-${booking.id}-${paymentMethod}-${currency}`;

    // Return existing payment for same idempotency key if already created
    const existingByKey = db
      .prepare(
        `SELECT * FROM payments
         WHERE booking_id = ? AND client_id = ? AND idempotency_key = ? AND status = 'pending'
         LIMIT 1`
      )
      .get(booking.id, client.id, reqIdempotencyKey) as Record<string, unknown> | undefined;

    if (existingByKey && existingByKey.provider_payment_id) {
      const isLocalSbx =
        String(existingByKey.provider_payment_id).startsWith('mp-sbx-') ||
        String(existingByKey.provider_payment_id).startsWith('pp-sbx-');
      res.json({
        idempotent: true,
        paymentId: existingByKey.id,
        gateway: gatewayId,
        environment: existingByKey.gateway_environment,
        providerPaymentId: existingByKey.provider_payment_id,
        amountCents: existingByKey.amount_cents,
        currency: existingByKey.currency,
        paymentMethod: existingByKey.payment_method,
        mode: isLocalSbx
          ? `${gatewayId}_sandbox_local`
          : `${gatewayId}_${existingByKey.gateway_environment}`,
        pixCopyPaste: existingByKey.pix_qr_code || null,
        pixQrBase64: existingByKey.pix_qr_base64 || null,
        checkoutUrl: existingByKey.checkout_url || null,
        sandboxSignature: isLocalSbx ? signSandboxWebhook(String(existingByKey.id)) : undefined,
        pendingNotice: isLocalSbx
          ? `${config.displayName} em Ambiente Sandbox Local. Confirme via webhook de teste assinado por HMAC.`
          : `Checkout ${config.displayName} pronto para conclusão.`,
      });
      return;
    }

    // Cancel stale pending attempts for another gateway/method on the same booking so there are no duplicate active checkouts
    db.prepare(
      `UPDATE payments
       SET status = 'cancelled', cancelled_at = datetime('now'), failure_reason = 'Substituído por nova seleção de gateway'
       WHERE booking_id = ? AND status = 'pending' AND (provider != ? OR payment_method != ? OR currency != ?)`
    ).run(booking.id, gatewayId, paymentMethod, currency);

    const commissionPct = resolveCommissionPercentage(db, booking.commission_percentage);
    const previewSplit = calculateFinancialSplit({
      amountCents: Number(booking.amount_cents),
      commissionPercentage: commissionPct,
    });

    const paymentId = existingByKey ? String(existingByKey.id) : crypto.randomUUID();
    if (!existingByKey) {
      db.prepare(
        `INSERT INTO payments (
          id, client_id, professional_id, booking_id, provider, gateway_environment,
          amount_cents, currency, status, payment_method,
          commission_percentage_applied, platform_fee_cents, professional_cents,
          idempotency_key, is_demo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
      ).run(
        paymentId,
        client.id,
        booking.professional_id,
        booking.id,
        gatewayId,
        config.environment,
        booking.amount_cents,
        currency,
        paymentMethod,
        commissionPct,
        previewSplit.platformFeeCents,
        previewSplit.professionalCents,
        reqIdempotencyKey,
        config.environment === 'sandbox' ? 1 : 0
      );
    }

    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

    try {
      const result = await provider.createPayment(
        {
          paymentId,
          bookingId: String(booking.id),
          clientId: client.id,
          clientName: client.full_name,
          clientEmail: client.email,
          professionalId: String(booking.professional_id),
          professionalName: String(booking.professional_name),
          amountCents: Number(booking.amount_cents),
          currency,
          paymentMethod,
          durationMinutes: Number(booking.duration_minutes || 30),
          commissionPercentage: commissionPct,
          idempotencyKey: reqIdempotencyKey,
          appUrl,
        },
        config
      );

      db.prepare(
        `UPDATE payments
         SET provider_payment_id = COALESCE(?, provider_payment_id),
             pix_qr_code = COALESCE(?, pix_qr_code),
             pix_qr_base64 = COALESCE(?, pix_qr_base64),
             checkout_url = COALESCE(?, checkout_url),
             gateway_fee_cents = COALESCE(?, gateway_fee_cents),
             metadata = ?
         WHERE id = ?`
      ).run(
        result.externalId,
        result.pixCopyPaste || null,
        result.pixQrBase64 || null,
        result.checkoutUrl || null,
        result.gatewayFeeCents ?? 0,
        JSON.stringify(result.rawMetadata || {}),
        paymentId
      );

      logAudit(
        db,
        req.auth!.userId,
        'CHECKOUT_CREATED',
        'payment',
        paymentId,
        {
          gateway: gatewayId,
          environment: config.environment,
          paymentMethod,
          currency,
          amountCents: booking.amount_cents,
          isLocalSandbox: result.isLocalSandbox,
        },
        config.environment === 'sandbox' ? 1 : 0
      );

      res.json({
        paymentId,
        gateway: gatewayId,
        displayName: config.displayName,
        environment: config.environment,
        providerPaymentId: result.externalId,
        amountCents: booking.amount_cents,
        currency,
        paymentMethod,
        mode: result.isLocalSandbox ? `${gatewayId}_sandbox_local` : `${gatewayId}_${config.environment}`,
        pixCopyPaste: result.pixCopyPaste || null,
        pixQrBase64: result.pixQrBase64 || null,
        checkoutUrl: result.checkoutUrl || null,
        sandboxSignature: result.isLocalSandbox ? signSandboxWebhook(paymentId) : undefined,
        pendingNotice: result.isLocalSandbox
          ? `${config.displayName} em Sandbox Local (configure credenciais ${config.displayName} para checkout hospedado). Validação estrita por HMAC no servidor.`
          : config.environment === 'sandbox'
            ? `${config.displayName} em Ambiente Sandbox. Conclua o pagamento de teste para liberar a chamada.`
            : `Checkout seguro ${config.displayName} pronto para conclusão.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Falha ao comunicar com ${config.displayName}.`;
      db.prepare(
        `UPDATE payment_gateways
         SET last_health_status = 'degraded', last_health_message = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(msg.slice(0, 300), gatewayId);

      db.prepare(
        `UPDATE payments SET status = 'rejected', failure_reason = ? WHERE id = ? AND status = 'pending'`
      ).run(msg.slice(0, 300), paymentId);

      logAudit(db, req.auth!.userId, 'GATEWAY_CHECKOUT_FAILED', 'payment', paymentId, {
        gateway: gatewayId,
        error: msg,
      });

      res.status(502).json({
        error: `${config.displayName} indisponível no momento (${msg}). Nenhuma cobrança foi confirmada — tente novamente ou utilize outro gateway habilitado.`,
        gatewayUnavailable: gatewayId,
      });
    }
  });

  // Server-side PayPal Order Capture after checkout redirect
  router.post('/:id/capture', requireAuth, requireRole('client'), async (req: AuthenticatedRequest, res) => {
    const payment = db
      .prepare(
        `SELECT py.*, c.user_id AS client_user_id
         FROM payments py JOIN clients c ON c.id = py.client_id
         WHERE py.id = ?`
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    if (!payment) {
      res.status(404).json({ error: 'Pagamento não encontrado.' });
      return;
    }
    if (payment.client_user_id !== req.auth!.userId) {
      res.status(403).json({ error: 'Acesso negado a este pagamento.' });
      return;
    }
    if (payment.provider !== 'paypal') {
      res.status(400).json({ error: 'Captura direta é suportada apenas para pedidos PayPal.' });
      return;
    }
    if (payment.status === 'approved') {
      const call = db.prepare('SELECT id FROM video_calls WHERE booking_id = ?').get(payment.booking_id) as
        | { id: string }
        | undefined;
      res.json({ status: 'approved', callId: call?.id || null, idempotent: true });
      return;
    }
    if (payment.status !== 'pending') {
      res.status(409).json({ error: `Pagamento não pode ser capturado no status "${payment.status}".` });
      return;
    }

    const provider = getPaymentProvider('paypal');
    const config = loadGatewayRuntimeConfig(db, 'paypal');
    if (!provider || !config) {
      res.status(404).json({ error: 'Gateway PayPal indisponível.' });
      return;
    }

    if (!config.hasLiveCredentials) {
      res.status(403).json({
        error: 'Captura direta bloqueada no modo Sandbox Local. Utilize validação HMAC oficial do servidor.',
      });
      return;
    }

    const externalOrderId = String(req.body?.orderId || payment.provider_payment_id || '');
    if (!externalOrderId) {
      res.status(400).json({ error: 'ID do pedido PayPal ausente.' });
      return;
    }

    try {
      const snapshot = await provider.confirmPayment(externalOrderId, config);
      const validation = provider.validateTransaction(
        {
          id: String(payment.id),
          provider: String(payment.provider),
          amount_cents: Number(payment.amount_cents),
          currency: String(payment.currency || 'BRL'),
        },
        snapshot
      );

      if (!validation.valid) {
        res.status(409).json({ error: validation.reason || 'Transação PayPal falhou na validação de integridade.' });
        return;
      }

      if (snapshot.status === 'approved') {
        const result = finalizeConfirmedPayment(db, hub, {
          paymentId: String(payment.id),
          expectedGatewayId: 'paypal',
          externalPaymentId: snapshot.externalId,
          externalCaptureId: snapshot.captureId || null,
          gatewayFeeCents: snapshot.gatewayFeeCents,
          isDemoSandbox: config.environment === 'sandbox',
          extraMeta: { capturedVia: 'paypal_return_capture', statusDetail: snapshot.statusDetail },
        });
        res.json({ status: 'approved', ...result });
        return;
      }

      if (snapshot.status === 'rejected' || snapshot.status === 'cancelled') {
        rejectOrCancelPaymentRecord(db, hub, {
          paymentId: String(payment.id),
          expectedGatewayId: 'paypal',
          status: snapshot.status,
          reason: snapshot.statusDetail || 'Captura PayPal não autorizada',
          externalPaymentId: snapshot.externalId,
        });
      }

      res.json({ status: snapshot.status });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Falha ao capturar pedido no PayPal.' });
    }
  });

  // Cancel a pending payment via its own gateway provider
  router.post('/:id/cancel', requireAuth, async (req: AuthenticatedRequest, res) => {
    const payment = db
      .prepare(
        `SELECT py.*, c.user_id AS client_user_id
         FROM payments py JOIN clients c ON c.id = py.client_id
         WHERE py.id = ?`
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    if (!payment) {
      res.status(404).json({ error: 'Pagamento não encontrado.' });
      return;
    }
    if (req.auth!.role !== 'admin' && payment.client_user_id !== req.auth!.userId) {
      res.status(403).json({ error: 'Acesso negado.' });
      return;
    }
    if (payment.status !== 'pending') {
      res.status(400).json({ error: 'Apenas pagamentos pendentes podem ser cancelados.' });
      return;
    }

    const gatewayId = String(payment.provider) === 'mercadopago_sandbox' ? 'mercadopago' : String(payment.provider);
    const provider = getPaymentProvider(gatewayId);
    const config = loadGatewayRuntimeConfig(db, gatewayId);

    if (provider && config && payment.provider_payment_id) {
      try {
        await provider.cancelPayment(String(payment.provider_payment_id), config);
      } catch {
        // Proceed with local cancellation if remote attempt already expired
      }
    }

    rejectOrCancelPaymentRecord(db, hub, {
      paymentId: String(payment.id),
      expectedGatewayId: String(payment.provider),
      status: 'cancelled',
      reason: String(req.body?.reason || 'Cancelado antes da confirmação').slice(0, 200),
      actorUserId: req.auth!.userId,
    });

    res.json({ ok: true, status: 'cancelled' });
  });

  // Authoritative Payment Status Lookup & Gateway Sync
  router.get('/:id/status', requireAuth, async (req: AuthenticatedRequest, res) => {
    const payment = db
      .prepare(
        `SELECT py.*, b.status AS booking_status, c.user_id AS client_user_id, vc.id AS call_id
         FROM payments py
         JOIN bookings b ON b.id = py.booking_id
         JOIN clients c ON c.id = py.client_id
         LEFT JOIN video_calls vc ON vc.booking_id = b.id
         WHERE py.id = ?`
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    if (!payment) {
      res.status(404).json({ error: 'Pagamento não encontrado.' });
      return;
    }

    if (req.auth!.role !== 'admin' && payment.client_user_id !== req.auth!.userId) {
      res.status(403).json({ error: 'Acesso negado a este pagamento.' });
      return;
    }

    const gatewayId = String(payment.provider);
    const provider = getPaymentProvider(gatewayId);
    const config = loadGatewayRuntimeConfig(db, gatewayId);

    if (
      payment.status === 'pending' &&
      provider &&
      config &&
      config.hasLiveCredentials &&
      payment.provider_payment_id &&
      !String(payment.provider_payment_id).startsWith('mp-sbx-') &&
      !String(payment.provider_payment_id).startsWith('pp-sbx-')
    ) {
      try {
        const snapshot = await provider.getPayment(String(payment.provider_payment_id), config);
        const validation = provider.validateTransaction(
          {
            id: String(payment.id),
            provider: gatewayId,
            amount_cents: Number(payment.amount_cents),
            currency: String(payment.currency || 'BRL'),
          },
          snapshot
        );

        if (validation.valid) {
          if (snapshot.status === 'approved') {
            const confirmed = finalizeConfirmedPayment(db, hub, {
              paymentId: String(payment.id),
              expectedGatewayId: gatewayId,
              externalPaymentId: snapshot.externalId,
              externalCaptureId: snapshot.captureId || null,
              gatewayFeeCents: snapshot.gatewayFeeCents,
              isDemoSandbox: config.environment === 'sandbox',
              extraMeta: { syncedVia: 'status_polling', statusDetail: snapshot.statusDetail },
            });
            res.json({
              paymentId: payment.id,
              gateway: gatewayId,
              status: 'approved',
              bookingStatus: 'pagamento_confirmado',
              callId: confirmed.callId || null,
            });
            return;
          }
          if (snapshot.status === 'rejected' || snapshot.status === 'cancelled') {
            rejectOrCancelPaymentRecord(db, hub, {
              paymentId: String(payment.id),
              expectedGatewayId: gatewayId,
              status: snapshot.status,
              reason: snapshot.statusDetail || `Status ${snapshot.status} em ${config.displayName}`,
              externalPaymentId: snapshot.externalId,
            });
          }
        }
      } catch {
        // Ignore transient sync error and return DB snapshot
      }
    }

    const refreshed = db
      .prepare(
        `SELECT py.id, py.status, py.amount_cents, py.currency, py.payment_method, py.provider,
                py.gateway_environment, py.gateway_fee_cents, py.platform_fee_cents, py.professional_cents,
                py.failure_reason, py.paid_at, py.confirmed_at, py.refunded_at, py.cancelled_at,
                b.status AS booking_status, vc.id AS call_id
         FROM payments py
         JOIN bookings b ON b.id = py.booking_id
         LEFT JOIN video_calls vc ON vc.booking_id = b.id
         WHERE py.id = ?`
      )
      .get(req.params.id);

    res.json(refreshed);
  });

  // Shared verified webhook processor with strict cross-gateway isolation
  async function handleGatewayWebhook(gatewayId: GatewayId, req: Request, res: Response) {
    const provider = getPaymentProvider(gatewayId);
    const config = loadGatewayRuntimeConfig(db, gatewayId);
    if (!provider || !config) {
      res.status(404).json({ error: 'Provedor não encontrado.' });
      return;
    }

    if (!config.hasLiveCredentials) {
      res.status(400).json({ error: `Credenciais de ${config.displayName} não configuradas no backend.` });
      return;
    }

    const event = await provider.parseAndVerifyWebhook(req, config);
    if (!event.signatureValid) {
      db.prepare(
        `INSERT INTO payment_webhook_events (id, provider, event_id, event_type, resource_id, signature_valid, payload, processing_status)
         VALUES (?, ?, ?, ?, ?, 0, ?, 'rejected_invalid_signature')`
      ).run(
        crypto.randomUUID(),
        gatewayId,
        event.eventId,
        event.eventType,
        event.resourceId,
        JSON.stringify(event.rawPayload)
      );
      res.status(401).json({ error: `Assinatura do webhook ${config.displayName} inválida.` });
      return;
    }

    if (event.action === 'ignored' || !event.resourceId) {
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    try {
      let snapshot = await provider.getPayment(event.resourceId, config);

      // PayPal: if webhook signals order approved prior to capture, execute server-side capture
      if (gatewayId === 'paypal' && event.eventType === 'CHECKOUT.ORDER.APPROVED' && snapshot.status !== 'approved') {
        snapshot = await provider.confirmPayment(event.resourceId, config);
      }

      const localPayment = (
        snapshot.externalReference
          ? db.prepare('SELECT id, provider, amount_cents, currency, status FROM payments WHERE id = ?').get(snapshot.externalReference)
          : db
              .prepare('SELECT id, provider, amount_cents, currency, status FROM payments WHERE provider_payment_id = ?')
              .get(snapshot.externalId)
      ) as { id: string; provider: string; amount_cents: number; currency: string; status: string } | undefined;

      let processingStatus = `${gatewayId}_status_${snapshot.status}`;

      if (!localPayment) {
        processingStatus = 'ignored_unknown_reference';
      } else if (localPayment.provider !== gatewayId) {
        // Strict cross-gateway isolation: reject cross-provider mutation attempts
        processingStatus = 'rejected_cross_gateway_isolation';
        logAudit(db, null, 'WEBHOOK_CROSS_GATEWAY_BLOCKED', 'payment', localPayment.id, {
          expectedGateway: localPayment.provider,
          webhookGateway: gatewayId,
          resourceId: event.resourceId,
        });
      } else {
        const validation = provider.validateTransaction(localPayment, snapshot);
        if (!validation.valid) {
          processingStatus = 'rejected_validation_mismatch';
          logAudit(db, null, 'WEBHOOK_VALIDATION_MISMATCH', 'payment', localPayment.id, {
            gateway: gatewayId,
            reason: validation.reason,
            snapshotAmount: snapshot.amountCents,
            expectedAmount: localPayment.amount_cents,
          });
        } else if (snapshot.status === 'approved') {
          finalizeConfirmedPayment(db, hub, {
            paymentId: localPayment.id,
            expectedGatewayId: gatewayId,
            externalPaymentId: snapshot.externalId,
            externalCaptureId: snapshot.captureId || null,
            gatewayFeeCents: snapshot.gatewayFeeCents,
            isDemoSandbox: config.environment === 'sandbox',
            extraMeta: { webhookEventId: event.eventId, statusDetail: snapshot.statusDetail },
          });
          processingStatus = 'confirmed';
        } else if (snapshot.status === 'rejected' || snapshot.status === 'cancelled') {
          rejectOrCancelPaymentRecord(db, hub, {
            paymentId: localPayment.id,
            expectedGatewayId: gatewayId,
            status: snapshot.status,
            reason: snapshot.statusDetail || `Status ${snapshot.status} em ${config.displayName}`,
            externalPaymentId: snapshot.externalId,
          });
          processingStatus = snapshot.status;
        } else if (snapshot.status === 'refunded' && localPayment.status === 'approved') {
          await processGatewayRefund(db, hub, {
            paymentId: localPayment.id,
            actorUserId: null,
            reason: `Estorno/chargeback via webhook ${config.displayName}`,
            skipRemoteGatewayCall: true,
            expectedGatewayId: gatewayId,
          });
          processingStatus = 'refunded';
        }
      }

      db.prepare(
        `INSERT INTO payment_webhook_events (id, provider, event_id, event_type, resource_id, signature_valid, payload, processing_status)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(
        crypto.randomUUID(),
        gatewayId,
        event.eventId,
        event.eventType,
        event.resourceId,
        JSON.stringify(event.rawPayload),
        processingStatus
      );

      res.status(200).json({ received: true, processingStatus });
    } catch {
      res.status(500).json({ error: `Erro ao validar transação no webhook ${config.displayName}.` });
    }
  }

  router.post('/webhooks/mercadopago', (req, res) => handleGatewayWebhook('mercadopago', req, res));
  router.post('/webhook', (req, res) => handleGatewayWebhook('mercadopago', req, res));
  router.post('/webhooks/paypal', (req, res) => handleGatewayWebhook('paypal', req, res));

  // Hardened Sandbox Test Webhook Simulator:
  // - Never allowed in production
  // - Never allowed when live gateway credentials are active
  // - Requires server-issued HMAC-SHA256 signature
  function handleSandboxSimulation(
    req: AuthenticatedRequest,
    res: Response,
    outcome: 'approved' | 'rejected'
  ) {
    const schema = z.object({
      paymentId: z.string().min(1),
      sandboxSignature: z.string().min(1),
      reason: z.string().max(200).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Assinatura HMAC de verificação ausente.' });
      return;
    }

    if (!verifySandboxWebhook(parsed.data.paymentId, parsed.data.sandboxSignature)) {
      res.status(403).json({ error: 'Assinatura HMAC de confirmação inválida.' });
      return;
    }

    const payment = db
      .prepare(
        `SELECT py.*, c.user_id AS client_user_id
         FROM payments py JOIN clients c ON c.id = py.client_id
         WHERE py.id = ?`
      )
      .get(parsed.data.paymentId) as Record<string, unknown> | undefined;

    if (!payment) {
      res.status(404).json({ error: 'Pagamento não encontrado.' });
      return;
    }
    if (payment.client_user_id !== req.auth!.userId) {
      res.status(403).json({ error: 'Acesso negado a este pagamento.' });
      return;
    }

    const gatewayId = String(payment.provider) === 'mercadopago_sandbox' ? 'mercadopago' : String(payment.provider);
    const config = loadGatewayRuntimeConfig(db, gatewayId);
    if (!config || config.environment === 'production' || config.hasLiveCredentials) {
      res.status(403).json({
        error:
          'Confirmação via requisição direta do frontend bloqueada. Pagamentos reais devem ser confirmados pelo webhook oficial do gateway.',
      });
      return;
    }

    if (outcome === 'approved') {
      try {
        const simExternalId = String(
          payment.provider_payment_id || `${gatewayId === 'paypal' ? 'pp' : 'mp'}-sbx-${parsed.data.paymentId.slice(0, 8)}`
        );
        // Simulate realistic gateway processing fee in sandbox (e.g. 3.99% MP / 4.79% PayPal)
        const feeRate = gatewayId === 'paypal' ? 0.0479 : 0.0399;
        const simulatedFeeCents = Math.round(Number(payment.amount_cents) * feeRate);

        const result = finalizeConfirmedPayment(db, hub, {
          paymentId: String(payment.id),
          expectedGatewayId: String(payment.provider),
          externalPaymentId: simExternalId,
          externalCaptureId: gatewayId === 'paypal' ? `cap-sbx-${parsed.data.paymentId.slice(0, 8)}` : null,
          gatewayFeeCents: simulatedFeeCents,
          isDemoSandbox: true,
          extraMeta: { sandboxWebhookVerified: true, gateway: gatewayId },
        });

        db.prepare(
          `INSERT INTO payment_webhook_events (id, provider, event_id, event_type, resource_id, signature_valid, payload, processing_status)
           VALUES (?, ?, ?, 'sandbox.payment.approved', ?, 1, ?, 'confirmed')`
        ).run(
          crypto.randomUUID(),
          gatewayId,
          `sbx-${Date.now()}`,
          simExternalId,
          JSON.stringify({ paymentId: payment.id, gateway: gatewayId, simulatedFeeCents })
        );

        res.json({ confirmed: true, gateway: gatewayId, ...result });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Falha na confirmação sandbox.' });
      }
      return;
    }

    const reason = parsed.data.reason?.trim() || `Pagamento recusado no Sandbox ${config.displayName}.`;
    rejectOrCancelPaymentRecord(db, hub, {
      paymentId: String(payment.id),
      expectedGatewayId: String(payment.provider),
      status: 'rejected',
      reason,
      externalPaymentId: `${gatewayId}-sbx-rej-${String(payment.id).slice(0, 8)}`,
    });

    db.prepare(
      `INSERT INTO payment_webhook_events (id, provider, event_id, event_type, resource_id, signature_valid, payload, processing_status)
       VALUES (?, ?, ?, 'sandbox.payment.rejected', ?, 1, ?, 'rejected')`
    ).run(
      crypto.randomUUID(),
      gatewayId,
      `sbx-rej-${Date.now()}`,
      String(payment.id),
      JSON.stringify({ paymentId: payment.id, gateway: gatewayId, reason })
    );

    res.json({ rejected: true, gateway: gatewayId, reason });
  }

  router.post('/webhooks/sandbox', requireAuth, requireRole('client'), (req: AuthenticatedRequest, res) => {
    const action = req.body?.outcome === 'rejected' ? 'rejected' : 'approved';
    handleSandboxSimulation(req, res, action);
  });

  router.post('/demo-confirm', requireAuth, requireRole('client'), (req: AuthenticatedRequest, res) =>
    handleSandboxSimulation(req, res, 'approved')
  );
  router.post('/demo-reject', requireAuth, requireRole('client'), (req: AuthenticatedRequest, res) =>
    handleSandboxSimulation(req, res, 'rejected')
  );

  return router;
}
