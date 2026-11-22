import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { logAudit } from '../security.ts';
import type { RealtimeHub } from '../ws.ts';
import { loadGatewayRuntimeConfig } from './credentials.ts';
import { getPaymentProvider } from './registry.ts';
import type { GatewayId } from './types.ts';

export function getPlatformSettingValue<T>(db: Database.Database, key: string, fallback: T): T {
  const row = db.prepare('SELECT setting_value FROM platform_settings WHERE setting_key = ?').get(key) as
    | { setting_value: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.setting_value) as T;
  } catch {
    return fallback;
  }
}

export function resolveCommissionPercentage(
  db: Database.Database,
  proCommission: unknown
): number {
  const globalCommission = Number(getPlatformSettingValue<number>(db, 'global_commission_percentage', 30));
  const rawCommission =
    proCommission !== null && proCommission !== undefined ? Number(proCommission) : globalCommission;
  return Math.min(100, Math.max(0, Number.isFinite(rawCommission) ? rawCommission : 30));
}

export function calculateFinancialSplit(params: {
  amountCents: number;
  commissionPercentage: number;
  gatewayFeeCents?: number;
}) {
  const grossCents = Math.max(0, Math.round(params.amountCents));
  const gatewayFeeCents = Math.max(0, Math.round(params.gatewayFeeCents || 0));
  const netReceivedCents = Math.max(0, grossCents - gatewayFeeCents);
  const platformFeeCents = Math.round((grossCents * params.commissionPercentage) / 100);
  const professionalCents = Math.max(0, grossCents - platformFeeCents);

  return {
    grossCents,
    gatewayFeeCents,
    netReceivedCents,
    platformFeeCents,
    professionalCents,
  };
}

/**
 * Separate accounting helper: records gateway processing fees on the payment record.
 */
export function recordGatewayFees(
  db: Database.Database,
  params: { paymentId: string; gatewayFeeCents: number }
) {
  db.prepare(`UPDATE payments SET gateway_fee_cents = ? WHERE id = ?`).run(
    Math.max(0, Math.round(params.gatewayFeeCents)),
    params.paymentId
  );
}

/**
 * Separate accounting helper: records net received amount after gateway fees.
 */
export function recordReceivedAmounts(
  db: Database.Database,
  params: { paymentId: string; netReceivedCents: number }
) {
  db.prepare(`UPDATE payments SET net_received_cents = ? WHERE id = ?`).run(
    Math.max(0, Math.round(params.netReceivedCents)),
    params.paymentId
  );
}

/**
 * Separate accounting helper: records platform commission percentage & cents.
 */
export function recordPlatformCommission(
  db: Database.Database,
  params: { paymentId: string; commissionPercentage: number; platformFeeCents: number }
) {
  db.prepare(
    `UPDATE payments
     SET commission_percentage_applied = ?, platform_fee_cents = ?
     WHERE id = ?`
  ).run(params.commissionPercentage, Math.max(0, Math.round(params.platformFeeCents)), params.paymentId);
}

/**
 * Separate accounting helper: records professional net share on payment, immutable ledger,
 * and increments pending escrow balance until session completion.
 */
export function recordProfessionalEarnings(
  db: Database.Database,
  params: {
    paymentId: string;
    professionalId: string;
    clientId: string;
    bookingId: string;
    provider: GatewayId;
    grossCents: number;
    gatewayFeeCents: number;
    platformFeeCents: number;
    professionalCents: number;
    currency: string;
    isDemo: boolean;
  }
) {
  db.prepare(`UPDATE payments SET professional_cents = ?, professional_id = ? WHERE id = ?`).run(
    params.professionalCents,
    params.professionalId,
    params.paymentId
  );

  db.prepare(
    `INSERT INTO financial_transactions (
      id, payment_id, professional_id, client_id, booking_id, transaction_type,
      gross_cents, platform_fee_cents, professional_cents, gateway_fee_cents, provider,
      currency, status, is_demo
    ) VALUES (?, ?, ?, ?, ?, 'session_credit', ?, ?, ?, ?, ?, ?, 'posted', ?)`
  ).run(
    crypto.randomUUID(),
    params.paymentId,
    params.professionalId,
    params.clientId,
    params.bookingId,
    params.grossCents,
    params.platformFeeCents,
    params.professionalCents,
    params.gatewayFeeCents,
    params.provider,
    params.currency.toUpperCase(),
    params.isDemo ? 1 : 0
  );

  db.prepare(
    `INSERT INTO professional_balances (id, professional_id, available_cents, pending_cents, paid_cents)
     VALUES (?, ?, 0, ?, 0)
     ON CONFLICT(professional_id) DO UPDATE SET
       pending_cents = professional_balances.pending_cents + excluded.pending_cents,
       updated_at = datetime('now')`
  ).run(crypto.randomUUID(), params.professionalId, params.professionalCents);
}

/**
 * Strictly enforces platform financial authorization rules before allowing a participant
 * to obtain a LiveKit/WebRTC room token or start/rejoin a private video call.
 */
export function verifyCallFinancialAuthorization(
  db: Database.Database,
  callId: string
): { authorized: true; bookingId: string; paymentId: string } | { authorized: false; reason: string } {
  const row = db
    .prepare(
      `SELECT vc.id AS call_id, vc.call_status,
              b.id AS booking_id, b.status AS booking_status,
              pr.is_approved AS pro_approved, p_pro.status AS pro_account_status
       FROM video_calls vc
       JOIN bookings b ON b.id = vc.booking_id
       JOIN professionals pr ON pr.id = vc.professional_id
       JOIN profiles p_pro ON p_pro.id = pr.user_id
       WHERE vc.id = ?`
    )
    .get(callId) as
    | {
        call_id: string;
        call_status: string;
        booking_id: string;
        booking_status: string;
        pro_approved: number;
        pro_account_status: string;
      }
    | undefined;

  if (!row) {
    return { authorized: false, reason: 'Sala de atendimento não encontrada.' };
  }

  if (!row.pro_approved || row.pro_account_status !== 'active') {
    return { authorized: false, reason: 'Profissional indisponível ou com conta suspensa.' };
  }

  if (!['pagamento_confirmado', 'em_andamento'].includes(row.booking_status)) {
    return {
      authorized: false,
      reason: 'Autorização financeira pendente: a reserva precisa estar com pagamento confirmado.',
    };
  }

  const approvedPayment = db
    .prepare("SELECT id, amount_cents, provider FROM payments WHERE booking_id = ? AND status = 'approved' LIMIT 1")
    .get(row.booking_id) as { id: string; amount_cents: number; provider: string } | undefined;

  if (!approvedPayment) {
    return {
      authorized: false,
      reason: 'Chamada bloqueada: nenhum pagamento aprovado confirmado no gateway para esta reserva.',
    };
  }

  const refundedOrCancelled = db
    .prepare("SELECT id, status FROM payments WHERE id = ? AND status IN ('refunded', 'cancelled', 'rejected') LIMIT 1")
    .get(approvedPayment.id);

  if (refundedOrCancelled) {
    return {
      authorized: false,
      reason: 'Chamada bloqueada: o pagamento desta sessão foi estornado ou cancelado.',
    };
  }

  const ledgerCredit = db
    .prepare(
      `SELECT id FROM financial_transactions
       WHERE payment_id = ? AND transaction_type = 'session_credit' AND status = 'posted'
       LIMIT 1`
    )
    .get(approvedPayment.id);

  if (!ledgerCredit) {
    return {
      authorized: false,
      reason: 'Autorização financeira incompleta no ledger contábil da plataforma.',
    };
  }

  return { authorized: true, bookingId: row.booking_id, paymentId: approvedPayment.id };
}

export function finalizeConfirmedPayment(
  db: Database.Database,
  hub: RealtimeHub,
  params: {
    paymentId: string;
    expectedGatewayId?: GatewayId;
    externalPaymentId: string;
    externalCaptureId?: string | null;
    gatewayFeeCents?: number;
    isDemoSandbox: boolean;
    extraMeta?: Record<string, unknown>;
  }
): {
  idempotent: boolean;
  callId?: string;
  commissionPct?: number;
  grossCents?: number;
  gatewayFeeCents?: number;
  platformFeeCents?: number;
  proCents?: number;
} {
  const payment = db
    .prepare(
      `SELECT py.*, b.professional_id, b.is_instant, b.duration_minutes, b.status AS booking_status,
              pr.commission_percentage, pr.user_id AS pro_user_id, pr.professional_name,
              c.user_id AS client_user_id, cp.full_name AS client_name
       FROM payments py
       JOIN bookings b ON b.id = py.booking_id
       JOIN professionals pr ON pr.id = b.professional_id
       JOIN clients c ON c.id = py.client_id
       JOIN profiles cp ON cp.id = c.user_id
       WHERE py.id = ?`
    )
    .get(params.paymentId) as Record<string, unknown> | undefined;

  if (!payment) throw new Error('Pagamento não encontrado.');

  // Cross-gateway isolation guard
  if (params.expectedGatewayId && String(payment.provider) !== params.expectedGatewayId) {
    throw new Error(
      `Isolamento de gateway violado: pagamento pertence a "${payment.provider}", tentativa de alteração via "${params.expectedGatewayId}".`
    );
  }

  if (payment.status === 'refunded') {
    throw new Error('Este pagamento já foi estornado e não pode ser aprovado.');
  }
  if (payment.status === 'cancelled') {
    throw new Error('Este pagamento foi cancelado e não pode ser confirmado.');
  }

  if (payment.status === 'approved') {
    const existingCall = db.prepare('SELECT id FROM video_calls WHERE booking_id = ?').get(payment.booking_id) as
      | { id: string }
      | undefined;
    return { idempotent: true, callId: existingCall?.id };
  }

  const commissionPct = resolveCommissionPercentage(db, payment.commission_percentage);
  const split = calculateFinancialSplit({
    amountCents: Number(payment.amount_cents),
    commissionPercentage: commissionPct,
    gatewayFeeCents: params.gatewayFeeCents || 0,
  });

  const callId = crypto.randomUUID();
  const roomName = `aurum-${String(payment.booking_id).slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`;
  const initialCallStatus = payment.is_instant ? 'aguardando_profissional' : 'pagamento_confirmado';
  const currency = String(payment.currency || 'BRL').toUpperCase();
  const gatewayId = String(payment.provider) as GatewayId;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE payments
       SET status = 'approved',
           provider_payment_id = COALESCE(?, provider_payment_id),
           external_capture_id = COALESCE(?, external_capture_id),
           failure_reason = NULL,
           metadata = ?,
           paid_at = COALESCE(paid_at, datetime('now')),
           confirmed_at = COALESCE(confirmed_at, datetime('now'))
       WHERE id = ?`
    ).run(
      params.externalPaymentId,
      params.externalCaptureId || null,
      JSON.stringify(params.extraMeta || {}),
      params.paymentId
    );

    recordGatewayFees(db, {
      paymentId: params.paymentId,
      gatewayFeeCents: split.gatewayFeeCents,
    });

    recordReceivedAmounts(db, {
      paymentId: params.paymentId,
      netReceivedCents: split.netReceivedCents,
    });

    recordPlatformCommission(db, {
      paymentId: params.paymentId,
      commissionPercentage: commissionPct,
      platformFeeCents: split.platformFeeCents,
    });

    recordProfessionalEarnings(db, {
      paymentId: params.paymentId,
      professionalId: String(payment.professional_id),
      clientId: String(payment.client_id),
      bookingId: String(payment.booking_id),
      provider: gatewayId,
      grossCents: split.grossCents,
      gatewayFeeCents: split.gatewayFeeCents,
      platformFeeCents: split.platformFeeCents,
      professionalCents: split.professionalCents,
      currency,
      isDemo: params.isDemoSandbox,
    });

    db.prepare(`UPDATE bookings SET status = 'pagamento_confirmado', updated_at = datetime('now') WHERE id = ?`).run(
      payment.booking_id
    );

    db.prepare(
      `INSERT INTO video_calls (
        id, booking_id, client_id, professional_id, room_name, call_status, amount_cents, is_demo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(booking_id) DO UPDATE SET call_status = excluded.call_status`
    ).run(
      callId,
      payment.booking_id,
      payment.client_id,
      payment.professional_id,
      roomName,
      initialCallStatus,
      split.grossCents,
      params.isDemoSandbox ? 1 : 0
    );

    db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type, is_demo)
       VALUES (?, ?, ?, ?, 'payment_confirmed', ?)`
    ).run(
      crypto.randomUUID(),
      payment.client_user_id,
      'Pagamento confirmado',
      `Sua sala privada com ${payment.professional_name} foi liberada via ${gatewayId === 'paypal' ? 'PayPal' : 'Mercado Pago'}.`,
      params.isDemoSandbox ? 1 : 0
    );

    db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type, is_demo)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      payment.pro_user_id,
      payment.is_instant ? 'Solicitação de chamada imediata' : 'Novo atendimento confirmado',
      `${payment.client_name} confirmou o pagamento (${payment.duration_minutes} min) via ${gatewayId === 'paypal' ? 'PayPal' : 'Mercado Pago'}.`,
      payment.is_instant ? 'call_requested' : 'new_booking',
      params.isDemoSandbox ? 1 : 0
    );

    logAudit(
      db,
      null,
      `PAYMENT_CONFIRMED_${gatewayId.toUpperCase()}`,
      'payment',
      params.paymentId,
      {
        gateway: gatewayId,
        grossCents: split.grossCents,
        gatewayFeeCents: split.gatewayFeeCents,
        netReceivedCents: split.netReceivedCents,
        platformFeeCents: split.platformFeeCents,
        proCents: split.professionalCents,
        commissionPct,
        currency,
        callId,
        externalPaymentId: params.externalPaymentId,
        sandbox: params.isDemoSandbox,
      },
      params.isDemoSandbox ? 1 : 0
    );
  });
  tx();

  const savedCall = db.prepare('SELECT id FROM video_calls WHERE booking_id = ?').get(payment.booking_id) as
    | { id: string }
    | undefined;
  const effectiveCallId = savedCall?.id || callId;

  hub.notifyUser(String(payment.client_user_id), {
    type: 'notification:new',
    data: { title: 'Pagamento confirmado', callId: effectiveCallId, paymentId: params.paymentId, gateway: gatewayId },
  });
  hub.notifyUser(String(payment.pro_user_id), {
    type: payment.is_instant ? 'call:incoming' : 'notification:new',
    data: {
      title: payment.is_instant ? 'Chamada imediata solicitada' : 'Novo atendimento confirmado',
      callId: effectiveCallId,
      clientName: payment.client_name,
    },
  });

  return {
    idempotent: false,
    callId: effectiveCallId,
    commissionPct,
    grossCents: split.grossCents,
    gatewayFeeCents: split.gatewayFeeCents,
    platformFeeCents: split.platformFeeCents,
    proCents: split.professionalCents,
  };
}

export function rejectOrCancelPaymentRecord(
  db: Database.Database,
  hub: RealtimeHub,
  params: {
    paymentId: string;
    expectedGatewayId?: GatewayId;
    status: 'rejected' | 'cancelled';
    reason: string;
    externalPaymentId?: string;
    actorUserId?: string | null;
  }
) {
  const payment = db
    .prepare(
      `SELECT py.*, c.user_id AS client_user_id
       FROM payments py
       JOIN clients c ON c.id = py.client_id
       WHERE py.id = ?`
    )
    .get(params.paymentId) as Record<string, unknown> | undefined;

  if (!payment) return;
  if (params.expectedGatewayId && String(payment.provider) !== params.expectedGatewayId) {
    throw new Error(
      `Isolamento de gateway: pagamento pertence a "${payment.provider}", não a "${params.expectedGatewayId}".`
    );
  }
  if (payment.status === 'approved' || payment.status === 'refunded') {
    throw new Error('Pagamentos já aprovados ou estornados não podem ser recusados/cancelados.');
  }
  if (payment.status === params.status) return;

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE payments
       SET status = ?,
           failure_reason = ?,
           provider_payment_id = COALESCE(?, provider_payment_id),
           cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, datetime('now')) ELSE cancelled_at END
       WHERE id = ?`
    ).run(
      params.status,
      params.reason,
      params.externalPaymentId || null,
      params.status,
      params.paymentId
    );

    db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type, is_demo)
       VALUES (?, ?, ?, ?, 'payment_failed', ?)`
    ).run(
      crypto.randomUUID(),
      payment.client_user_id,
      params.status === 'rejected' ? 'Pagamento recusado' : 'Pagamento cancelado',
      `O pagamento não foi concluído (${params.reason}). A chamada permanece bloqueada.`,
      Number(payment.is_demo || 0)
    );

    logAudit(
      db,
      params.actorUserId ?? null,
      params.status === 'rejected' ? 'PAYMENT_REJECTED' : 'PAYMENT_CANCELLED',
      'payment',
      params.paymentId,
      { gateway: payment.provider, reason: params.reason, externalPaymentId: params.externalPaymentId },
      Number(payment.is_demo || 0)
    );
  });
  tx();

  hub.notifyUser(String(payment.client_user_id), {
    type: 'payment:status',
    data: { paymentId: params.paymentId, status: params.status, reason: params.reason },
  });
}

export async function processGatewayRefund(
  db: Database.Database,
  hub: RealtimeHub,
  params: {
    paymentId: string;
    actorUserId: string | null;
    reason: string;
    partialAmountCents?: number;
    skipRemoteGatewayCall?: boolean;
    expectedGatewayId?: GatewayId;
  }
): Promise<{
  ok: true;
  provider: string;
  providerRefundId: string;
  refundGrossCents: number;
  refundPlatformFeeCents: number;
  refundProfessionalCents: number;
}> {
  const payment = db
    .prepare(
      `SELECT py.*, b.professional_id, pr.user_id AS pro_user_id, pr.professional_name,
              c.user_id AS client_user_id, vc.id AS video_call_id
       FROM payments py
       JOIN bookings b ON b.id = py.booking_id
       JOIN professionals pr ON pr.id = b.professional_id
       JOIN clients c ON c.id = py.client_id
       LEFT JOIN video_calls vc ON vc.booking_id = b.id
       WHERE py.id = ?`
    )
    .get(params.paymentId) as Record<string, unknown> | undefined;

  if (!payment) {
    throw new Error('Pagamento não encontrado.');
  }

  const gatewayId = String(payment.provider) === 'mercadopago_sandbox' ? 'mercadopago' : String(payment.provider);

  if (params.expectedGatewayId && gatewayId !== params.expectedGatewayId) {
    throw new Error(`Isolamento de gateway: estorno recusado para provedor divergente (${params.expectedGatewayId}).`);
  }

  if (payment.status !== 'approved') {
    throw new Error('Somente pagamentos aprovados podem ser estornados.');
  }

  const totalAmountCents = Number(payment.amount_cents);
  const refundGrossCents =
    params.partialAmountCents && params.partialAmountCents > 0 && params.partialAmountCents < totalAmountCents
      ? params.partialAmountCents
      : totalAmountCents;

  let providerRefundId = `${gatewayId}-refund-${crypto.randomUUID().slice(0, 10)}`;

  if (!params.skipRemoteGatewayCall) {
    const provider = getPaymentProvider(gatewayId);
    const config = loadGatewayRuntimeConfig(db, gatewayId);
    if (provider && config) {
      const refundRes = await provider.requestRefund(
        {
          paymentId: String(payment.id),
          externalPaymentId: payment.provider_payment_id ? String(payment.provider_payment_id) : null,
          externalCaptureId: payment.external_capture_id ? String(payment.external_capture_id) : null,
          amountCents: refundGrossCents,
          totalAmountCents,
          currency: String(payment.currency || 'BRL'),
          reason: params.reason,
          idempotencyKey: `refund-${payment.id}-${refundGrossCents}`,
        },
        config
      );
      providerRefundId = refundRes.externalRefundId;
    }
  }

  const originalLedger = db
    .prepare("SELECT * FROM financial_transactions WHERE payment_id = ? AND transaction_type = 'session_credit'")
    .get(payment.id) as Record<string, unknown> | undefined;

  const ratio = totalAmountCents > 0 ? refundGrossCents / totalAmountCents : 1;
  const refundPlatformFeeCents = originalLedger
    ? Math.round(Number(originalLedger.platform_fee_cents) * ratio)
    : 0;
  const refundProfessionalCents = originalLedger
    ? refundGrossCents - refundPlatformFeeCents
    : 0;
  const refundGatewayFeeCents = Math.round(Number(payment.gateway_fee_cents || 0) * ratio);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE payments
       SET status = 'refunded',
           refunded_at = datetime('now'),
           provider_refund_id = ?,
           refund_reason = ?
       WHERE id = ?`
    ).run(providerRefundId, params.reason, payment.id);

    db.prepare(
      `UPDATE bookings
       SET status = 'cancelada', cancellation_reason = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(params.reason, payment.booking_id);

    db.prepare(`UPDATE video_calls SET call_status = 'cancelada' WHERE booking_id = ?`).run(payment.booking_id);

    if (originalLedger) {
      db.prepare(
        `INSERT INTO financial_transactions (
          id, payment_id, professional_id, client_id, booking_id, transaction_type,
          gross_cents, platform_fee_cents, professional_cents, gateway_fee_cents, provider,
          currency, status, is_demo
        ) VALUES (?, ?, ?, ?, ?, 'refund_debit', ?, ?, ?, ?, ?, ?, 'posted', ?)`
      ).run(
        crypto.randomUUID(),
        payment.id,
        payment.professional_id,
        payment.client_id,
        payment.booking_id,
        -refundGrossCents,
        -refundPlatformFeeCents,
        -refundProfessionalCents,
        -refundGatewayFeeCents,
        gatewayId,
        String(payment.currency || 'BRL').toUpperCase(),
        Number(payment.is_demo || 0)
      );

      db.prepare(
        `UPDATE professional_balances
         SET pending_cents = MAX(0, pending_cents - ?),
             available_cents = CASE
               WHEN pending_cents < ? THEN MAX(0, available_cents - (? - pending_cents))
               ELSE available_cents
             END,
             updated_at = datetime('now')
         WHERE professional_id = ?`
      ).run(refundProfessionalCents, refundProfessionalCents, refundProfessionalCents, payment.professional_id);
    }

    db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type, is_demo)
       VALUES (?, ?, 'Pagamento estornado', ?, 'payment_refunded', ?)`
    ).run(
      crypto.randomUUID(),
      payment.client_user_id,
      `O estorno via ${gatewayId === 'paypal' ? 'PayPal' : 'Mercado Pago'} foi processado (${params.reason}).`,
      Number(payment.is_demo || 0)
    );

    db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type, is_demo)
       VALUES (?, ?, 'Sessão estornada', ?, 'payment_refunded', ?)`
    ).run(
      crypto.randomUUID(),
      payment.pro_user_id,
      `Um atendimento foi cancelado e estornado (${params.reason}).`,
      Number(payment.is_demo || 0)
    );

    logAudit(
      db,
      params.actorUserId,
      'PAYMENT_REFUNDED',
      'payment',
      String(payment.id),
      {
        gateway: gatewayId,
        providerRefundId,
        refundGrossCents,
        refundPlatformFeeCents,
        refundProfessionalCents,
        reason: params.reason,
      },
      Number(payment.is_demo || 0)
    );
  });
  tx();

  hub.notifyUser(String(payment.client_user_id), {
    type: 'payment:refunded',
    data: { paymentId: payment.id, refundGrossCents, gateway: gatewayId },
  });
  hub.notifyUser(String(payment.pro_user_id), {
    type: 'payment:refunded',
    data: { paymentId: payment.id, refundGrossCents, gateway: gatewayId },
  });
  if (payment.video_call_id) {
    hub.closeRoom(String(payment.video_call_id), 'refunded');
  }

  return {
    ok: true,
    provider: gatewayId,
    providerRefundId,
    refundGrossCents,
    refundPlatformFeeCents,
    refundProfessionalCents,
  };
}
