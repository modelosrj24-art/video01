import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { createAuthMiddleware, requireRole, logAudit, type AuthenticatedRequest } from '../security.ts';
import type { RealtimeHub } from '../ws.ts';
import { getPlatformSettingValue, processGatewayRefund } from '../payments/ledger-service.ts';

const createBookingSchema = z.object({
  professionalId: z.string().min(1),
  scheduledAt: z.string().min(1),
  durationMinutes: z.number().int().min(10).max(180).optional(),
  billingMode: z.enum(['session', 'per_minute']).default('session'),
  couponCode: z.string().max(40).optional().default(''),
});

const instantCallSchema = z.object({
  professionalId: z.string().min(1),
  durationMinutes: z.number().int().min(5).max(120).optional(),
  billingMode: z.enum(['session', 'per_minute']).default('session'),
  couponCode: z.string().max(40).optional().default(''),
});

export function createClientRouter(db: Database.Database, hub?: RealtimeHub): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth, requireRole('client'));

  function getClientId(userId: string): string | null {
    const row = db.prepare('SELECT id FROM clients WHERE user_id = ?').get(userId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  function applyCouponAndPrice(baseCents: number, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    if (!code) return { finalCents: baseCents, discountCents: 0, appliedCode: null };

    const coupon = db
      .prepare(
        `SELECT * FROM coupons
         WHERE UPPER(code) = ? AND is_active = 1
           AND (expiration_date IS NULL OR expiration_date > datetime('now'))
           AND (usage_limit IS NULL OR usage_count < usage_limit)`
      )
      .get(code) as
      | { id: string; code: string; discount_type: 'percentage' | 'fixed_cents'; discount_value: number }
      | undefined;

    if (!coupon) {
      throw new Error('Cupom inválido, expirado ou esgotado.');
    }

    let discountCents = 0;
    if (coupon.discount_type === 'percentage') {
      discountCents = Math.round((baseCents * coupon.discount_value) / 100);
    } else {
      discountCents = coupon.discount_value;
    }
    discountCents = Math.min(baseCents, Math.max(0, discountCents));
    return {
      finalCents: Math.max(100, baseCents - discountCents),
      discountCents,
      appliedCode: coupon.code,
      couponId: coupon.id,
    };
  }

  router.get('/dashboard', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Perfil de cliente não encontrado.' });
      return;
    }

    const bookings = db
      .prepare(
        `SELECT b.*, pr.professional_name, pr.slug, pr.category, pr.profile_image,
                vc.id AS video_call_id, vc.call_status
         FROM bookings b
         JOIN professionals pr ON pr.id = b.professional_id
         LEFT JOIN video_calls vc ON vc.booking_id = b.id
         WHERE b.client_id = ?
         ORDER BY b.scheduled_at DESC LIMIT 10`
      )
      .all(clientId);

    const stats = db
      .prepare(
        `SELECT
           COUNT(*) AS total_bookings,
           SUM(CASE WHEN status = 'pagamento_confirmado' THEN 1 ELSE 0 END) AS upcoming_count,
           SUM(CASE WHEN status = 'finalizada' THEN 1 ELSE 0 END) AS completed_count
         FROM bookings WHERE client_id = ?`
      )
      .get(clientId);

    const totalSpent = db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total_cents FROM payments WHERE client_id = ? AND status = 'approved'`)
      .get(clientId) as { total_cents: number };

    const favorites = db
      .prepare(
        `SELECT pr.id, pr.professional_name, pr.slug, pr.category, pr.profile_image, pr.price_per_session_cents, pr.session_duration, pr.availability_status
         FROM favorites f
         JOIN professionals pr ON pr.id = f.professional_id
         WHERE f.client_id = ?`
      )
      .all(clientId);

    res.json({ stats, totalSpentCents: totalSpent.total_cents, bookings, favorites });
  });

  router.get('/favorites', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }
    const favorites = db
      .prepare(
        `SELECT pr.id, pr.professional_name, pr.slug, pr.category, pr.profile_image, pr.price_per_session_cents, pr.session_duration, pr.availability_status
         FROM favorites f
         JOIN professionals pr ON pr.id = f.professional_id
         WHERE f.client_id = ?`
      )
      .all(clientId);
    res.json({ favorites });
  });

  router.post('/favorites/:professionalId', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }
    const existing = db
      .prepare('SELECT id FROM favorites WHERE client_id = ? AND professional_id = ?')
      .get(clientId, req.params.professionalId) as { id: string } | undefined;

    if (existing) {
      db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
      res.json({ favorited: false });
    } else {
      db.prepare('INSERT INTO favorites (id, client_id, professional_id) VALUES (?, ?, ?)').run(
        crypto.randomUUID(),
        clientId,
        req.params.professionalId
      );
      res.json({ favorited: true });
    }
  });

  router.get('/bookings', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }
    const bookings = db
      .prepare(
        `SELECT b.*, pr.professional_name, pr.slug, pr.category, pr.profile_image,
                vc.id AS video_call_id, vc.call_status,
                r.id AS review_id,
                (SELECT py.status FROM payments py WHERE py.booking_id = b.id ORDER BY py.created_at DESC LIMIT 1) AS payment_status
         FROM bookings b
         JOIN professionals pr ON pr.id = b.professional_id
         LEFT JOIN video_calls vc ON vc.booking_id = b.id
         LEFT JOIN reviews r ON r.booking_id = b.id
         WHERE b.client_id = ?
         ORDER BY b.scheduled_at DESC`
      )
      .all(clientId);
    res.json({ bookings });
  });

  router.post('/bookings', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }

    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
      return;
    }

    const pro = db
      .prepare(
        `SELECT pr.*, p.status AS account_status
         FROM professionals pr JOIN profiles p ON p.id = pr.user_id
         WHERE pr.id = ? AND pr.is_approved = 1 AND p.status = 'active'`
      )
      .get(parsed.data.professionalId) as Record<string, unknown> | undefined;

    if (!pro) {
      res.status(404).json({ error: 'Profissional indisponível.' });
      return;
    }

    const sessionEnabled = Boolean(getPlatformSettingValue<boolean>(db, 'session_billing_enabled', true));
    const perMinuteEnabled = Boolean(getPlatformSettingValue<boolean>(db, 'per_minute_billing_enabled', true));
    if (parsed.data.billingMode === 'session' && !sessionEnabled) {
      res.status(400).json({ error: 'Cobrança por sessão fixa está desabilitada nas regras da plataforma.' });
      return;
    }
    if (parsed.data.billingMode === 'per_minute' && !perMinuteEnabled) {
      res.status(400).json({ error: 'Cobrança por minuto está desabilitada nas regras da plataforma.' });
      return;
    }

    const scheduledDate = new Date(parsed.data.scheduledAt);
    const minLeadMinutes = Number(getPlatformSettingValue<number>(db, 'min_booking_lead_minutes', 30));
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() < Date.now() + Math.max(0, minLeadMinutes - 5) * 60000) {
      res.status(400).json({ error: `Selecione um horário com pelo menos ${minLeadMinutes} minutos de antecedência.` });
      return;
    }

    const scheduledIso = scheduledDate.toISOString();
    const scheduledDateStr = scheduledIso.slice(0, 10);
    const scheduledTimeStr = scheduledIso.slice(11, 16);

    const blocked = db
      .prepare(
        `SELECT id FROM professional_availability_blocks
         WHERE professional_id = ? AND block_date = ?
           AND (
             (start_time IS NULL AND end_time IS NULL)
             OR (start_time <= ? AND end_time > ?)
           )
         LIMIT 1`
      )
      .get(parsed.data.professionalId, scheduledDateStr, scheduledTimeStr, scheduledTimeStr);

    if (blocked) {
      res.status(409).json({ error: 'O profissional bloqueou este dia ou horário na agenda.' });
      return;
    }

    const conflict = db
      .prepare(
        `SELECT id FROM bookings
         WHERE professional_id = ? AND scheduled_at = ? AND status NOT IN ('cancelada', 'expirou')`
      )
      .get(parsed.data.professionalId, scheduledIso);

    if (conflict) {
      res.status(409).json({ error: 'Este horário já foi reservado para este profissional.' });
      return;
    }

    const duration = parsed.data.durationMinutes || Number(pro.session_duration);
    const baseCents =
      parsed.data.billingMode === 'per_minute'
        ? Number(pro.price_per_minute_cents || 0) * duration
        : Math.round((Number(pro.price_per_session_cents) * duration) / Number(pro.session_duration));

    let pricing;
    try {
      pricing = applyCouponAndPrice(baseCents, parsed.data.couponCode);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Cupom inválido' });
      return;
    }

    const bookingId = crypto.randomUUID();
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO bookings (
          id, client_id, professional_id, scheduled_at, duration_minutes, billing_mode,
          amount_cents, coupon_code, discount_cents, status, is_instant
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando_pagamento', 0)`
      ).run(
        bookingId,
        clientId,
        parsed.data.professionalId,
        scheduledIso,
        duration,
        parsed.data.billingMode,
        pricing.finalCents,
        pricing.appliedCode,
        pricing.discountCents
      );

      if (pricing.couponId) {
        db.prepare('UPDATE coupons SET usage_count = usage_count + 1 WHERE id = ?').run(pricing.couponId);
      }

      logAudit(db, req.auth!.userId, 'BOOKING_CREATED', 'booking', bookingId, {
        professionalId: parsed.data.professionalId,
        amountCents: pricing.finalCents,
      });
    });
    tx();

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    res.status(201).json({ booking });
  });

  router.post('/instant-call', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }

    const parsed = instantCallSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
      return;
    }

    const pro = db
      .prepare(
        `SELECT pr.*, p.status AS account_status
         FROM professionals pr JOIN profiles p ON p.id = pr.user_id
         WHERE pr.id = ? AND pr.is_approved = 1 AND p.status = 'active'`
      )
      .get(parsed.data.professionalId) as Record<string, unknown> | undefined;

    const sessionEnabled = Boolean(getPlatformSettingValue<boolean>(db, 'session_billing_enabled', true));
    const perMinuteEnabled = Boolean(getPlatformSettingValue<boolean>(db, 'per_minute_billing_enabled', true));
    if (parsed.data.billingMode === 'session' && !sessionEnabled) {
      res.status(400).json({ error: 'Cobrança por sessão fixa desabilitada nas regras da plataforma.' });
      return;
    }
    if (parsed.data.billingMode === 'per_minute' && !perMinuteEnabled) {
      res.status(400).json({ error: 'Cobrança por minuto desabilitada nas regras da plataforma.' });
      return;
    }

    if (!pro || pro.availability_status !== 'online' || !pro.instant_call_enabled) {
      res.status(409).json({ error: 'Este profissional não está disponível para chamada imediata no momento.' });
      return;
    }

    const duration = parsed.data.durationMinutes || Number(pro.session_duration);
    const baseCents =
      parsed.data.billingMode === 'per_minute'
        ? Number(pro.price_per_minute_cents || 0) * duration
        : Math.round((Number(pro.price_per_session_cents) * duration) / Number(pro.session_duration));

    let pricing;
    try {
      pricing = applyCouponAndPrice(baseCents, parsed.data.couponCode);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Cupom inválido' });
      return;
    }

    const bookingId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT INTO bookings (
        id, client_id, professional_id, scheduled_at, duration_minutes, billing_mode,
        amount_cents, coupon_code, discount_cents, status, is_instant
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando_pagamento', 1)`
    ).run(
      bookingId,
      clientId,
      parsed.data.professionalId,
      nowIso,
      duration,
      parsed.data.billingMode,
      pricing.finalCents,
      pricing.appliedCode,
      pricing.discountCents
    );

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    res.status(201).json({ booking });
  });

  router.post('/bookings/:id/cancel', async (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }

    const booking = db
      .prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?')
      .get(req.params.id, clientId) as Record<string, unknown> | undefined;

    if (!booking) {
      res.status(404).json({ error: 'Agendamento não encontrado.' });
      return;
    }
    if (booking.status === 'finalizada' || booking.status === 'cancelada' || booking.status === 'em_andamento') {
      res.status(400).json({ error: 'Este agendamento não pode mais ser cancelado.' });
      return;
    }

    const reason = String(req.body?.reason || 'Cancelado pelo cliente').slice(0, 300);

    const approvedPayment = db
      .prepare("SELECT id FROM payments WHERE booking_id = ? AND status = 'approved' LIMIT 1")
      .get(booking.id) as { id: string } | undefined;

    if (approvedPayment && hub) {
      const windowHours = Number(getPlatformSettingValue<number>(db, 'cancellation_window_hours', 4));
      const scheduledMs = new Date(String(booking.scheduled_at)).getTime();
      const hoursUntil = (scheduledMs - Date.now()) / 3600000;

      if (hoursUntil >= windowHours) {
        try {
          const refundRes = await processGatewayRefund(db, hub, {
            paymentId: approvedPayment.id,
            actorUserId: req.auth!.userId,
            reason: `Cancelamento dentro da janela de ${windowHours}h: ${reason}`,
          });
          res.json({ ...refundRes, refunded: true });
          return;
        } catch (err) {
          res.status(502).json({
            error: err instanceof Error ? err.message : 'Falha ao processar reembolso automático no gateway.',
          });
          return;
        }
      }
    }

    const tx = db.transaction(() => {
      db.prepare(`UPDATE bookings SET status = 'cancelada', cancellation_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(
        reason,
        booking.id
      );
      db.prepare(`UPDATE video_calls SET call_status = 'cancelada' WHERE booking_id = ?`).run(booking.id);
      logAudit(db, req.auth!.userId, 'BOOKING_CANCELLED_BY_CLIENT', 'booking', String(booking.id), {
        reason,
        hadApprovedPayment: Boolean(approvedPayment),
      });
    });
    tx();

    res.json({
      ok: true,
      refunded: false,
      notice: approvedPayment
        ? 'Cancelamento fora da janela automática de reembolso. Caso necessário, solicite análise ao suporte administrativo.'
        : undefined,
    });
  });

  router.post('/bookings/:id/review', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }

    const schema = z.object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().min(3, 'Escreva um breve comentário').max(600),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Avaliação inválida.' });
      return;
    }

    const booking = db
      .prepare("SELECT * FROM bookings WHERE id = ? AND client_id = ? AND status = 'finalizada'")
      .get(req.params.id, clientId) as { id: string; professional_id: string } | undefined;

    if (!booking) {
      res.status(400).json({ error: 'Somente atendimentos finalizados podem ser avaliados.' });
      return;
    }

    const existing = db.prepare('SELECT id FROM reviews WHERE booking_id = ?').get(booking.id);
    if (existing) {
      res.status(409).json({ error: 'Este atendimento já foi avaliado.' });
      return;
    }

    db.prepare(
      `INSERT INTO reviews (id, client_id, professional_id, booking_id, rating, comment, status)
       VALUES (?, ?, ?, ?, ?, ?, 'published')`
    ).run(crypto.randomUUID(), clientId, booking.professional_id, booking.id, parsed.data.rating, parsed.data.comment.trim());

    res.status(201).json({ ok: true });
  });

  router.get('/calls', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }
    const calls = db
      .prepare(
        `SELECT vc.*, pr.professional_name, pr.profile_image, pr.category, b.scheduled_at, b.duration_minutes
         FROM video_calls vc
         JOIN professionals pr ON pr.id = vc.professional_id
         JOIN bookings b ON b.id = vc.booking_id
         WHERE vc.client_id = ?
         ORDER BY vc.created_at DESC`
      )
      .all(clientId);
    res.json({ calls });
  });

  router.get('/payments', (req: AuthenticatedRequest, res) => {
    const clientId = getClientId(req.auth!.userId);
    if (!clientId) {
      res.status(404).json({ error: 'Cliente não encontrado.' });
      return;
    }
    const payments = db
      .prepare(
        `SELECT py.*, b.scheduled_at, b.duration_minutes, pr.professional_name
         FROM payments py
         JOIN bookings b ON b.id = py.booking_id
         JOIN professionals pr ON pr.id = b.professional_id
         WHERE py.client_id = ?
         ORDER BY py.created_at DESC`
      )
      .all(clientId);
    res.json({ payments });
  });

  router.get('/notifications', (req: AuthenticatedRequest, res) => {
    const notifications = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40')
      .all(req.auth!.userId);
    res.json({ notifications });
  });

  router.post('/notifications/:id/read', (req: AuthenticatedRequest, res) => {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?").run(
      req.params.id,
      req.auth!.userId
    );
    res.json({ ok: true });
  });

  return router;
}
