import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type Database from 'better-sqlite3';
import { createAuthMiddleware, requireRole, hashPassword, logAudit, type AuthenticatedRequest } from '../security.ts';
import type { RealtimeHub } from '../ws.ts';
import {
  decryptGatewayCredentials,
  encryptGatewayCredentials,
  loadGatewayRuntimeConfig,
  maskGatewayCredentials,
} from '../payments/credentials.ts';
import { getPaymentProvider } from '../payments/registry.ts';
import { processGatewayRefund, rejectOrCancelPaymentRecord } from '../payments/ledger-service.ts';

export function createAdminRouter(db: Database.Database, hub?: RealtimeHub): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth, requireRole('admin'));

  // 1. Dashboard with real SQL aggregations + period grouping (daily | weekly | monthly)
  router.get('/dashboard', (req, res) => {
    const period = String(req.query.period || 'daily');

    const proStats = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN pr.is_approved = 1 AND p.status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN pr.is_approved = 1 AND p.status = 'active' AND pr.availability_status = 'online' THEN 1 ELSE 0 END) AS online,
           SUM(CASE WHEN pr.is_approved = 0 THEN 1 ELSE 0 END) AS pending_approval
         FROM professionals pr JOIN profiles p ON p.id = pr.user_id`
      )
      .get();

    const clientStats = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS new_30d
         FROM clients`
      )
      .get();

    const callStats = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN call_status = 'finalizada' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN call_status = 'em_andamento' THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE WHEN call_status IN ('cancelada', 'recusada') THEN 1 ELSE 0 END) AS cancelled
         FROM video_calls`
      )
      .get();

    const financials = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN transaction_type IN ('session_credit', 'refund_debit') THEN gross_cents ELSE 0 END), 0) AS gross_revenue_cents,
           COALESCE(SUM(CASE WHEN transaction_type IN ('session_credit', 'refund_debit') THEN platform_fee_cents ELSE 0 END), 0) AS platform_revenue_cents,
           COALESCE(SUM(CASE WHEN transaction_type IN ('session_credit', 'refund_debit') THEN professional_cents ELSE 0 END), 0) AS professional_share_cents
         FROM financial_transactions`
      )
      .get();

    const pendingPayments = db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents FROM payments WHERE status = 'pending'")
      .get();

    const pendingPayouts = db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents FROM payout_requests WHERE status IN ('pending', 'approved')")
      .get();

    const bookingConv = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status IN ('pagamento_confirmado', 'em_andamento', 'finalizada') THEN 1 ELSE 0 END) AS converted
         FROM bookings`
      )
      .get() as { total: number; converted: number };

    const conversionRate = bookingConv.total > 0 ? Number(((bookingConv.converted / bookingConv.total) * 100).toFixed(1)) : 0;

    const groupExpr =
      period === 'monthly'
        ? "strftime('%Y-%m', created_at)"
        : period === 'weekly'
          ? "strftime('%Y-W%W', created_at)"
          : 'date(created_at)';

    const revenueSeries = db
      .prepare(
        `SELECT
           ${groupExpr} AS day,
           COALESCE(SUM(gross_cents), 0) AS gross_cents,
           COALESCE(SUM(platform_fee_cents), 0) AS platform_cents,
           COUNT(*) AS calls
         FROM financial_transactions
         WHERE transaction_type = 'session_credit'
         GROUP BY ${groupExpr}
         ORDER BY day ASC LIMIT 30`
      )
      .all();

    const topByRevenue = db
      .prepare(
        `SELECT
           pr.id, pr.professional_name, pr.category, pr.profile_image, pr.commission_percentage,
           COUNT(CASE WHEN ft.transaction_type = 'session_credit' THEN ft.id END) AS total_calls,
           COALESCE(SUM(CASE WHEN ft.transaction_type IN ('session_credit', 'refund_debit') THEN ft.gross_cents ELSE 0 END), 0) AS gross_cents,
           COALESCE(SUM(CASE WHEN ft.transaction_type IN ('session_credit', 'refund_debit') THEN ft.platform_fee_cents ELSE 0 END), 0) AS platform_fee_cents
         FROM professionals pr
         LEFT JOIN financial_transactions ft ON ft.professional_id = pr.id
         GROUP BY pr.id
         ORDER BY gross_cents DESC LIMIT 6`
      )
      .all();

    const topByCalls = db
      .prepare(
        `SELECT
           pr.id, pr.professional_name, pr.category,
           COUNT(vc.id) AS call_count,
           COALESCE(SUM(vc.duration_seconds), 0) AS total_seconds
         FROM professionals pr
         LEFT JOIN video_calls vc ON vc.professional_id = pr.id AND vc.call_status = 'finalizada'
         GROUP BY pr.id
         ORDER BY call_count DESC, total_seconds DESC LIMIT 6`
      )
      .all();

    const demoCount = db.prepare('SELECT COUNT(*) AS cnt FROM profiles WHERE is_demo = 1').get() as { cnt: number };

    res.json({
      proStats,
      clientStats,
      callStats,
      financials,
      pendingPayments,
      pendingPayouts,
      conversionRate,
      revenueSeries,
      topProfessionals: topByRevenue,
      topByCalls,
      hasDemoData: demoCount.cnt > 0,
    });
  });

  // 2. Professionals CRUD + Filters
  router.get('/professionals', (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const approval = String(req.query.approval || 'all');
    const availability = String(req.query.availability || 'all');

    let sql = `
      SELECT pr.*, p.full_name, p.email, p.phone, p.status AS account_status,
             pb.available_cents, pb.pending_cents, pb.paid_cents
      FROM professionals pr
      JOIN profiles p ON p.id = pr.user_id
      LEFT JOIN professional_balances pb ON pb.professional_id = pr.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (search) {
      sql += ` AND (LOWER(pr.professional_name) LIKE ? OR LOWER(p.email) LIKE ? OR LOWER(pr.category) LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    if (approval === 'approved') sql += ' AND pr.is_approved = 1';
    else if (approval === 'pending') sql += ' AND pr.is_approved = 0';

    if (availability !== 'all') {
      sql += ' AND pr.availability_status = ?';
      params.push(availability);
    }

    sql += ' ORDER BY pr.created_at DESC';

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    res.json({
      professionals: rows.map((r) => ({
        ...r,
        languages: JSON.parse(String(r.languages || '[]')),
        gallery: JSON.parse(String(r.gallery || '[]')),
      })),
    });
  });

  router.post('/professionals', (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      fullName: z.string().min(2).max(120),
      professionalName: z.string().min(2).max(120),
      email: z.string().email(),
      password: z.string().min(8),
      phone: z.string().max(30).optional().default(''),
      category: z.string().min(2).max(80),
      bio: z.string().max(2000).optional().default(''),
      languages: z.array(z.string()).optional().default(['Português']),
      pricePerSessionCents: z.number().int().min(100),
      pricePerMinuteCents: z.number().int().min(0).optional().default(0),
      sessionDuration: z.number().int().min(5).max(240).default(30),
      commissionPercentage: z.number().min(0).max(100).default(30),
      isApproved: z.boolean().default(true),
      isFeatured: z.boolean().default(false),
      instantCallEnabled: z.boolean().default(true),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    if (db.prepare('SELECT id FROM profiles WHERE email = ?').get(email)) {
      res.status(409).json({ error: 'E-mail já cadastrado na plataforma.' });
      return;
    }

    const slugBase = parsed.data.professionalName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const slug = `${slugBase}-${crypto.randomBytes(2).toString('hex')}`;

    const userId = crypto.randomUUID();
    const proId = crypto.randomUUID();
    const passwordHash = hashPassword(parsed.data.password);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO profiles (id, full_name, email, password_hash, phone, user_role, status, is_demo)
         VALUES (?, ?, ?, ?, ?, 'professional', 'active', 0)`
      ).run(userId, parsed.data.fullName.trim(), email, passwordHash, parsed.data.phone.trim());

      db.prepare(
        `INSERT INTO professionals (
          id, user_id, professional_name, slug, bio, category, languages,
          price_per_session_cents, price_per_minute_cents, session_duration,
          commission_percentage, availability_status, is_approved, is_featured, instant_call_enabled, is_demo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?, ?, 0)`
      ).run(
        proId,
        userId,
        parsed.data.professionalName.trim(),
        slug,
        parsed.data.bio.trim(),
        parsed.data.category.trim(),
        JSON.stringify(parsed.data.languages),
        parsed.data.pricePerSessionCents,
        parsed.data.pricePerMinuteCents,
        parsed.data.sessionDuration,
        parsed.data.commissionPercentage,
        parsed.data.isApproved ? 1 : 0,
        parsed.data.isFeatured ? 1 : 0,
        parsed.data.instantCallEnabled ? 1 : 0
      );

      db.prepare(`INSERT INTO professional_balances (id, professional_id) VALUES (?, ?)`).run(crypto.randomUUID(), proId);
      for (const day of [1, 2, 3, 4, 5]) {
        db.prepare(
          `INSERT INTO professional_availability (id, professional_id, day_of_week, start_time, end_time, is_available)
           VALUES (?, ?, ?, '09:00', '18:00', 1)`
        ).run(crypto.randomUUID(), proId, day);
      }

      logAudit(db, req.auth!.userId, 'ADMIN_CREATED_PROFESSIONAL', 'professional', proId, { email, slug });
    });
    tx();

    res.status(201).json({ ok: true, id: proId, slug });
  });

  router.patch('/professionals/:id', (req: AuthenticatedRequest, res) => {
    const pro = db.prepare('SELECT * FROM professionals WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const schema = z.object({
      fullName: z.string().min(2).max(120).optional(),
      phone: z.string().max(30).optional(),
      professionalName: z.string().min(2).max(120).optional(),
      category: z.string().min(2).max(80).optional(),
      bio: z.string().max(2000).optional(),
      languages: z.array(z.string().min(2)).optional(),
      pricePerSessionCents: z.number().int().min(100).optional(),
      pricePerMinuteCents: z.number().int().min(0).optional(),
      sessionDuration: z.number().int().min(5).max(240).optional(),
      commissionPercentage: z.number().min(0).max(100).optional(),
      isApproved: z.boolean().optional(),
      isFeatured: z.boolean().optional(),
      instantCallEnabled: z.boolean().optional(),
      accountStatus: z.enum(['active', 'pending', 'suspended', 'blocked']).optional(),
      availabilityStatus: z.enum(['online', 'offline', 'busy']).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados de atualização inválidos.' });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE professionals SET
           professional_name = COALESCE(?, professional_name),
           category = COALESCE(?, category),
           bio = COALESCE(?, bio),
           languages = COALESCE(?, languages),
           price_per_session_cents = COALESCE(?, price_per_session_cents),
           price_per_minute_cents = COALESCE(?, price_per_minute_cents),
           session_duration = COALESCE(?, session_duration),
           commission_percentage = COALESCE(?, commission_percentage),
           is_approved = COALESCE(?, is_approved),
           is_featured = COALESCE(?, is_featured),
           instant_call_enabled = COALESCE(?, instant_call_enabled),
           availability_status = COALESCE(?, availability_status),
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        parsed.data.professionalName ?? null,
        parsed.data.category ?? null,
        parsed.data.bio ?? null,
        parsed.data.languages ? JSON.stringify(parsed.data.languages) : null,
        parsed.data.pricePerSessionCents ?? null,
        parsed.data.pricePerMinuteCents ?? null,
        parsed.data.sessionDuration ?? null,
        parsed.data.commissionPercentage ?? null,
        parsed.data.isApproved !== undefined ? (parsed.data.isApproved ? 1 : 0) : null,
        parsed.data.isFeatured !== undefined ? (parsed.data.isFeatured ? 1 : 0) : null,
        parsed.data.instantCallEnabled !== undefined ? (parsed.data.instantCallEnabled ? 1 : 0) : null,
        parsed.data.availabilityStatus ?? null,
        pro.id
      );

      if (parsed.data.accountStatus || parsed.data.fullName || parsed.data.phone !== undefined) {
        db.prepare(
          `UPDATE profiles SET
             status = COALESCE(?, status),
             full_name = COALESCE(?, full_name),
             phone = COALESCE(?, phone),
             updated_at = datetime('now')
           WHERE id = ?`
        ).run(parsed.data.accountStatus ?? null, parsed.data.fullName ?? null, parsed.data.phone ?? null, pro.user_id);
      }

      logAudit(db, req.auth!.userId, 'ADMIN_UPDATED_PROFESSIONAL', 'professional', String(pro.id), parsed.data);
    });
    tx();

    res.json({ ok: true });
  });

  router.delete('/professionals/:id', (req: AuthenticatedRequest, res) => {
    const pro = db.prepare('SELECT user_id, professional_name FROM professionals WHERE id = ?').get(req.params.id) as
      | { user_id: string; professional_name: string }
      | undefined;
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }
    db.prepare('DELETE FROM profiles WHERE id = ?').run(pro.user_id);
    logAudit(db, req.auth!.userId, 'ADMIN_DELETED_PROFESSIONAL', 'professional', req.params.id, {
      professionalName: pro.professional_name,
    });
    res.json({ ok: true });
  });

  // 3. Clients management + filters + edit
  router.get('/clients', (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const status = String(req.query.status || 'all');

    let sql = `
      SELECT c.id, c.user_id, p.full_name, p.email, p.phone, p.status, p.created_at, p.is_demo,
             COUNT(b.id) AS total_bookings,
             COALESCE(SUM(CASE WHEN py.status = 'approved' THEN py.amount_cents ELSE 0 END), 0) AS total_spent_cents
      FROM clients c
      JOIN profiles p ON p.id = c.user_id
      LEFT JOIN bookings b ON b.client_id = c.id
      LEFT JOIN payments py ON py.booking_id = b.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (search) {
      sql += ` AND (LOWER(p.full_name) LIKE ? OR LOWER(p.email) LIKE ? OR LOWER(COALESCE(p.phone, '')) LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    if (status !== 'all') {
      sql += ' AND p.status = ?';
      params.push(status);
    }
    sql += ' GROUP BY c.id ORDER BY p.created_at DESC';

    const clients = db.prepare(sql).all(...params);
    res.json({ clients });
  });

  router.patch('/clients/:userId', (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      fullName: z.string().min(2).max(120).optional(),
      phone: z.string().max(30).optional(),
      status: z.enum(['active', 'pending', 'suspended', 'blocked']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Dados inválidos.' });
      return;
    }

    db.prepare(
      `UPDATE profiles SET
         full_name = COALESCE(?, full_name),
         phone = COALESCE(?, phone),
         status = COALESCE(?, status),
         updated_at = datetime('now')
       WHERE id = ? AND user_role = 'client'`
    ).run(parsed.data.fullName ?? null, parsed.data.phone ?? null, parsed.data.status ?? null, req.params.userId);

    logAudit(db, req.auth!.userId, 'ADMIN_UPDATED_CLIENT', 'profile', req.params.userId, parsed.data);
    res.json({ ok: true });
  });

  router.patch('/clients/:userId/status', (req: AuthenticatedRequest, res) => {
    const schema = z.object({ status: z.enum(['active', 'suspended', 'blocked']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Status inválido.' });
      return;
    }
    db.prepare(`UPDATE profiles SET status = ?, updated_at = datetime('now') WHERE id = ? AND user_role = 'client'`).run(
      parsed.data.status,
      req.params.userId
    );
    logAudit(db, req.auth!.userId, 'ADMIN_CLIENT_STATUS_CHANGED', 'profile', req.params.userId, parsed.data);
    res.json({ ok: true });
  });

  // 4. Bookings & Video Calls management
  router.get('/bookings', (req, res) => {
    const status = String(req.query.status || 'all');
    const search = String(req.query.search || '').trim().toLowerCase();

    let sql = `
      SELECT b.*, pr.professional_name, cp.full_name AS client_name, cp.email AS client_email,
             vc.id AS video_call_id, vc.call_status
      FROM bookings b
      JOIN professionals pr ON pr.id = b.professional_id
      JOIN clients c ON c.id = b.client_id
      JOIN profiles cp ON cp.id = c.user_id
      LEFT JOIN video_calls vc ON vc.booking_id = b.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (status !== 'all') {
      sql += ' AND b.status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (LOWER(pr.professional_name) LIKE ? OR LOWER(cp.full_name) LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term);
    }
    sql += ' ORDER BY b.scheduled_at DESC';

    res.json({ bookings: db.prepare(sql).all(...params) });
  });

  router.post('/bookings/:id/cancel', (req: AuthenticatedRequest, res) => {
    const reason = String(req.body?.reason || 'Cancelado pela administração').slice(0, 300);
    const tx = db.transaction(() => {
      db.prepare(`UPDATE bookings SET status = 'cancelada', cancellation_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(
        reason,
        req.params.id
      );
      db.prepare(`UPDATE video_calls SET call_status = 'cancelada' WHERE booking_id = ?`).run(req.params.id);
      logAudit(db, req.auth!.userId, 'ADMIN_CANCELLED_BOOKING', 'booking', req.params.id, { reason });
    });
    tx();
    res.json({ ok: true });
  });

  router.get('/calls', (req, res) => {
    const status = String(req.query.status || 'all');
    const search = String(req.query.search || '').trim().toLowerCase();

    let sql = `
      SELECT vc.*, pr.professional_name, cp.full_name AS client_name, b.scheduled_at, b.duration_minutes, b.billing_mode
      FROM video_calls vc
      JOIN professionals pr ON pr.id = vc.professional_id
      JOIN clients c ON c.id = vc.client_id
      JOIN profiles cp ON cp.id = c.user_id
      JOIN bookings b ON b.id = vc.booking_id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    if (status !== 'all') {
      sql += ' AND vc.call_status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (LOWER(pr.professional_name) LIKE ? OR LOWER(cp.full_name) LIKE ? OR LOWER(vc.room_name) LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    sql += ' ORDER BY vc.created_at DESC';

    res.json({ calls: db.prepare(sql).all(...params) });
  });

  router.post('/calls/:id/force-end', (req: AuthenticatedRequest, res) => {
    const call = db.prepare('SELECT * FROM video_calls WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!call) {
      res.status(404).json({ error: 'Chamada não encontrada.' });
      return;
    }
    const tx = db.transaction(() => {
      db.prepare(`UPDATE video_calls SET call_status = 'finalizada', ended_at = datetime('now') WHERE id = ?`).run(req.params.id);
      db.prepare(`UPDATE bookings SET status = 'finalizada', updated_at = datetime('now') WHERE id = ?`).run(call.booking_id);
      logAudit(db, req.auth!.userId, 'ADMIN_FORCE_ENDED_CALL', 'video_call', req.params.id);
    });
    tx();
    res.json({ ok: true });
  });

  // 5. Payments, Multi-Gateway Filter, Cancellation, Ledger & Refunds
  router.get('/payments', (req, res) => {
    const status = String(req.query.status || 'all');
    const gateway = String(req.query.gateway || 'all');
    const search = String(req.query.search || '').trim().toLowerCase();

    let paySql = `
      SELECT py.*, cp.full_name AS client_name, pr.professional_name, b.scheduled_at
      FROM payments py
      JOIN clients c ON c.id = py.client_id
      JOIN profiles cp ON cp.id = c.user_id
      JOIN bookings b ON b.id = py.booking_id
      JOIN professionals pr ON pr.id = b.professional_id
      WHERE 1=1
    `;
    const payParams: unknown[] = [];
    if (status !== 'all') {
      paySql += ' AND py.status = ?';
      payParams.push(status);
    }
    if (gateway !== 'all') {
      if (gateway === 'mercadopago') {
        paySql += " AND py.provider IN ('mercadopago', 'mercadopago_sandbox')";
      } else {
        paySql += ' AND py.provider = ?';
        payParams.push(gateway);
      }
    }
    if (search) {
      paySql += ` AND (LOWER(cp.full_name) LIKE ? OR LOWER(pr.professional_name) LIKE ? OR LOWER(COALESCE(py.provider_payment_id, '')) LIKE ?)`;
      const term = `%${search}%`;
      payParams.push(term, term, term);
    }
    paySql += ' ORDER BY py.created_at DESC';

    const payments = db.prepare(paySql).all(...payParams);
    const transactions = db
      .prepare(
        `SELECT ft.*, pr.professional_name, cp.full_name AS client_name
         FROM financial_transactions ft
         JOIN professionals pr ON pr.id = ft.professional_id
         LEFT JOIN clients c ON c.id = ft.client_id
         LEFT JOIN profiles cp ON cp.id = c.user_id
         ORDER BY ft.created_at DESC`
      )
      .all();

    const webhookEvents = db
      .prepare('SELECT * FROM payment_webhook_events ORDER BY created_at DESC LIMIT 40')
      .all();
    const mpCfg = loadGatewayRuntimeConfig(db, 'mercadopago');
    const ppCfg = loadGatewayRuntimeConfig(db, 'paypal');

    res.json({
      payments,
      transactions,
      webhookEvents,
      gatewayStatus: {
        configured: Boolean(mpCfg?.hasLiveCredentials),
        environment: mpCfg?.hasLiveCredentials ? mpCfg.environment : 'sandbox_local',
        isTestMode: mpCfg?.environment !== 'production',
        webhookSecretConfigured: Boolean(mpCfg?.credentials.webhookSecret),
        mercadopagoEnabled: Boolean(mpCfg?.isEnabled),
        paypalEnabled: Boolean(ppCfg?.isEnabled),
      },
    });
  });

  router.post('/payments/:id/cancel', async (req: AuthenticatedRequest, res) => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!payment) {
      res.status(404).json({ error: 'Pagamento não encontrado.' });
      return;
    }
    if (payment.status !== 'pending') {
      res.status(400).json({ error: 'Somente pagamentos pendentes podem ser cancelados.' });
      return;
    }

    const gatewayId = String(payment.provider) === 'mercadopago_sandbox' ? 'mercadopago' : String(payment.provider);
    const provider = getPaymentProvider(gatewayId);
    const config = loadGatewayRuntimeConfig(db, gatewayId);
    if (provider && config && payment.provider_payment_id) {
      try {
        await provider.cancelPayment(String(payment.provider_payment_id), config);
      } catch {
        // Proceed with local cancellation if remote order already expired
      }
    }

    const dummyHub =
      hub ||
      ({
        notifyUser: () => {},
        closeRoom: () => {},
      } as unknown as RealtimeHub);

    rejectOrCancelPaymentRecord(db, dummyHub, {
      paymentId: String(payment.id),
      expectedGatewayId: String(payment.provider),
      status: 'cancelled',
      reason: String(req.body?.reason || 'Cancelado administrativamente').slice(0, 200),
      actorUserId: req.auth!.userId,
    });
    res.json({ ok: true });
  });

  router.post('/payments/:id/refund', async (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      reason: z.string().min(3).max(250).optional().default('Estornado pelo administrador'),
      amountCents: z.number().int().positive().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Parâmetros de estorno inválidos.' });
      return;
    }

    try {
      const dummyHub =
        hub ||
        ({
          notifyUser: () => {},
          closeRoom: () => {},
        } as unknown as RealtimeHub);

      const result = await processGatewayRefund(db, dummyHub, {
        paymentId: req.params.id,
        actorUserId: req.auth!.userId,
        reason: parsed.data.reason,
        partialAmountCents: parsed.data.amountCents,
      });

      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Erro ao processar estorno.' });
    }
  });

  // 5B. GATEWAYS DE PAGAMENTO (Mercado Pago & PayPal config, credentials, health & revenue comparison)
  router.get('/gateways', (_req, res) => {
    const rows = db.prepare('SELECT * FROM payment_gateways ORDER BY id ASC').all() as Array<Record<string, unknown>>;

    const metricsRows = db
      .prepare(
        `SELECT
           CASE WHEN provider = 'mercadopago_sandbox' THEN 'mercadopago' ELSE provider END AS gateway_id,
           COUNT(*) AS total_count,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
           SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
           SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded_count,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN amount_cents ELSE 0 END), 0) AS gross_approved_cents,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN gateway_fee_cents ELSE 0 END), 0) AS gateway_fee_cents,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN platform_fee_cents ELSE 0 END), 0) AS platform_fee_cents,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN professional_cents ELSE 0 END), 0) AS professional_cents,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_cents ELSE 0 END), 0) AS pending_cents,
           COALESCE(SUM(CASE WHEN status = 'refunded' THEN amount_cents ELSE 0 END), 0) AS refunded_cents
         FROM payments
         GROUP BY gateway_id`
      )
      .all() as Array<Record<string, any>>;

    const metricsMap = new Map<string, Record<string, any>>();
    for (const m of metricsRows) {
      metricsMap.set(String(m.gateway_id), m);
    }

    const gateways = rows.map((row) => {
      const id = String(row.id);
      const runtime = loadGatewayRuntimeConfig(db, id);
      const masked = maskGatewayCredentials(id, runtime?.credentials || {});
      const metrics = metricsMap.get(id) || {
        gateway_id: id,
        total_count: 0,
        approved_count: 0,
        pending_count: 0,
        rejected_count: 0,
        cancelled_count: 0,
        refunded_count: 0,
        gross_approved_cents: 0,
        gateway_fee_cents: 0,
        platform_fee_cents: 0,
        professional_cents: 0,
        pending_cents: 0,
        refunded_cents: 0,
      };

      return {
        id,
        displayName: String(row.display_name),
        isEnabled: Boolean(row.is_enabled),
        environment: runtime?.environment || 'sandbox',
        supportedMethods: runtime?.supportedMethods || [],
        supportedCurrencies: runtime?.supportedCurrencies || ['BRL'],
        splitEnabled: Boolean(row.split_enabled),
        complianceVerified: Boolean(row.compliance_verified),
        complianceNotes: String(row.compliance_notes || ''),
        hasLiveCredentials: Boolean(runtime?.hasLiveCredentials),
        maskedCredentials: masked,
        lastHealthStatus: String(row.last_health_status || 'sandbox_ready'),
        lastHealthMessage: String(row.last_health_message || ''),
        updatedAt: String(row.updated_at || ''),
        metrics,
      };
    });

    const webhookEvents = db
      .prepare('SELECT * FROM payment_webhook_events ORDER BY created_at DESC LIMIT 30')
      .all();

    res.json({ gateways, webhookEvents });
  });

  router.patch('/gateways/:id', (req: AuthenticatedRequest, res) => {
    const gatewayId = req.params.id;
    const existing = db.prepare('SELECT * FROM payment_gateways WHERE id = ?').get(gatewayId) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Gateway de pagamento não encontrado.' });
      return;
    }

    const schema = z.object({
      isEnabled: z.boolean().optional(),
      environment: z.enum(['sandbox', 'production']).optional(),
      supportedMethods: z.array(z.string()).optional(),
      supportedCurrencies: z.array(z.string()).optional(),
      splitEnabled: z.boolean().optional(),
      complianceVerified: z.boolean().optional(),
      complianceNotes: z.string().max(1000).optional(),
      credentials: z.record(z.string(), z.string()).optional(),
    });

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Configuração de gateway inválida.' });
      return;
    }

    const nextCompliance =
      parsed.data.complianceVerified !== undefined
        ? parsed.data.complianceVerified
        : Boolean(existing.compliance_verified);
    const nextEnvironment = parsed.data.environment || String(existing.environment);

    // Enforce business-model & payout compliance check before allowing Production activation
    if (nextEnvironment === 'production' && !nextCompliance) {
      res.status(400).json({
        error:
          'Antes de ativar o ambiente de Produção, confirme a verificação de elegibilidade do provedor (modelo de negócio, serviços online e regras de repasse).',
      });
      return;
    }

    const currentCreds = decryptGatewayCredentials(String(existing.encrypted_credentials || '{}'));
    const nextCreds = { ...currentCreds };
    if (parsed.data.credentials) {
      for (const [k, v] of Object.entries(parsed.data.credentials)) {
        const trimmed = v.trim();
        if (trimmed) {
          nextCreds[k] = trimmed;
        }
      }
    }

    const encrypted = encryptGatewayCredentials(nextCreds);

    db.prepare(
      `UPDATE payment_gateways
       SET is_enabled = COALESCE(?, is_enabled),
           environment = COALESCE(?, environment),
           supported_methods = COALESCE(?, supported_methods),
           supported_currencies = COALESCE(?, supported_currencies),
           split_enabled = COALESCE(?, split_enabled),
           compliance_verified = COALESCE(?, compliance_verified),
           compliance_notes = COALESCE(?, compliance_notes),
           encrypted_credentials = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      parsed.data.isEnabled !== undefined ? (parsed.data.isEnabled ? 1 : 0) : null,
      parsed.data.environment ?? null,
      parsed.data.supportedMethods ? JSON.stringify(parsed.data.supportedMethods) : null,
      parsed.data.supportedCurrencies ? JSON.stringify(parsed.data.supportedCurrencies) : null,
      parsed.data.splitEnabled !== undefined ? (parsed.data.splitEnabled ? 1 : 0) : null,
      parsed.data.complianceVerified !== undefined ? (parsed.data.complianceVerified ? 1 : 0) : null,
      parsed.data.complianceNotes !== undefined ? parsed.data.complianceNotes : null,
      encrypted,
      gatewayId
    );

    const runtimeAfter = loadGatewayRuntimeConfig(db, gatewayId);
    if (nextEnvironment === 'production' && !runtimeAfter?.hasLiveCredentials) {
      db.prepare(
        `UPDATE payment_gateways
         SET last_health_status = 'missing_credentials',
             last_health_message = 'Ambiente de produção selecionado, mas credenciais de API ainda não foram configuradas.'
         WHERE id = ?`
      ).run(gatewayId);
    }

    logAudit(db, req.auth!.userId, 'ADMIN_GATEWAY_UPDATED', 'payment_gateway', gatewayId, {
      isEnabled: parsed.data.isEnabled,
      environment: parsed.data.environment,
      splitEnabled: parsed.data.splitEnabled,
      complianceVerified: nextCompliance,
      credentialsUpdated: Boolean(parsed.data.credentials && Object.values(parsed.data.credentials).some((v) => v.trim())),
    });

    res.json({ ok: true });
  });

  router.post('/gateways/:id/test', async (req: AuthenticatedRequest, res) => {
    const gatewayId = req.params.id;
    const provider = getPaymentProvider(gatewayId);
    const config = loadGatewayRuntimeConfig(db, gatewayId);
    if (!provider || !config) {
      res.status(404).json({ error: 'Gateway de pagamento não encontrado.' });
      return;
    }

    const result = await provider.testConnection(config);
    db.prepare(
      `UPDATE payment_gateways
       SET last_health_status = ?, last_health_message = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(result.status, result.message.slice(0, 400), gatewayId);

    logAudit(db, req.auth!.userId, 'ADMIN_GATEWAY_TESTED', 'payment_gateway', gatewayId, {
      ok: result.ok,
      status: result.status,
    });

    res.json(result);
  });

  // 6. Financial Ledger Manual Adjustment & Commission Overview
  router.post('/financials/adjustment', (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      professionalId: z.string().min(1),
      amountCents: z.number().int().refine((v) => v !== 0, 'Informe um valor diferente de zero'),
      reason: z.string().min(3).max(200),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Ajuste inválido.' });
      return;
    }

    const bal = db
      .prepare('SELECT available_cents FROM professional_balances WHERE professional_id = ?')
      .get(parsed.data.professionalId) as { available_cents: number } | undefined;

    if (!bal) {
      res.status(404).json({ error: 'Saldo do profissional não encontrado.' });
      return;
    }
    if (bal.available_cents + parsed.data.amountCents < 0) {
      res.status(400).json({ error: 'Ajuste resultaria em saldo disponível negativo.' });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO financial_transactions (
          id, professional_id, transaction_type, gross_cents, platform_fee_cents, professional_cents, currency, status
        ) VALUES (?, ?, 'adjustment', ?, 0, ?, 'BRL', 'posted')`
      ).run(crypto.randomUUID(), parsed.data.professionalId, parsed.data.amountCents, parsed.data.amountCents);

      db.prepare(
        `UPDATE professional_balances SET available_cents = available_cents + ?, updated_at = datetime('now') WHERE professional_id = ?`
      ).run(parsed.data.amountCents, parsed.data.professionalId);

      logAudit(db, req.auth!.userId, 'ADMIN_LEDGER_ADJUSTMENT', 'professional', parsed.data.professionalId, {
        amountCents: parsed.data.amountCents,
        reason: parsed.data.reason,
      });
    });
    tx();

    res.status(201).json({ ok: true });
  });

  // 7. Payouts & Repasses
  router.get('/payouts', (req, res) => {
    const status = String(req.query.status || 'all');
    let sql = `
      SELECT po.*, pr.professional_name, p.email AS professional_email
      FROM payout_requests po
      JOIN professionals pr ON pr.id = po.professional_id
      JOIN profiles p ON p.id = pr.user_id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    if (status !== 'all') {
      sql += ' AND po.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY po.requested_at DESC';

    const payouts = db.prepare(sql).all(...params);
    const summary = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_cents ELSE 0 END), 0) AS pending_cents,
           COALESCE(SUM(CASE WHEN status = 'approved' THEN amount_cents ELSE 0 END), 0) AS approved_cents,
           COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END), 0) AS paid_cents
         FROM payout_requests`
      )
      .get();

    res.json({ payouts, summary });
  });

  router.post('/payouts/:id/:action', (req: AuthenticatedRequest, res) => {
    const action = req.params.action;
    if (!['approve', 'reject', 'mark-paid'].includes(action)) {
      res.status(400).json({ error: 'Ação inválida.' });
      return;
    }

    const payout = db
      .prepare(
        `SELECT po.*, pr.user_id AS pro_user_id
         FROM payout_requests po JOIN professionals pr ON pr.id = po.professional_id
         WHERE po.id = ?`
      )
      .get(req.params.id) as Record<string, unknown> | undefined;

    if (!payout) {
      res.status(404).json({ error: 'Solicitação de saque não encontrada.' });
      return;
    }

    const notes = String(req.body?.adminNotes || '').slice(0, 400);
    const externalReference = String(req.body?.externalReference || `REP-${String(payout.id).slice(0, 8)}`).slice(0, 120);
    const transferReceipt = String(req.body?.transferReceipt || '').slice(0, 400);

    const tx = db.transaction(() => {
      if (action === 'approve' && payout.status === 'pending') {
        db.prepare(`UPDATE payout_requests SET status = 'approved', approved_at = datetime('now'), admin_notes = ? WHERE id = ?`).run(
          notes,
          payout.id
        );
        db.prepare(
          `INSERT INTO notifications (id, user_id, title, message, type)
           VALUES (?, ?, 'Saque aprovado', 'Sua solicitação de repasse foi aprovada e será transferida em breve.', 'payout_approved')`
        ).run(crypto.randomUUID(), payout.pro_user_id);
      } else if (action === 'reject' && (payout.status === 'pending' || payout.status === 'approved')) {
        db.prepare(`UPDATE payout_requests SET status = 'rejected', admin_notes = ? WHERE id = ?`).run(notes, payout.id);
        db.prepare(`UPDATE professional_balances SET available_cents = available_cents + ? WHERE professional_id = ?`).run(
          payout.amount_cents,
          payout.professional_id
        );
        db.prepare(
          `INSERT INTO notifications (id, user_id, title, message, type)
           VALUES (?, ?, 'Saque recusado', 'Sua solicitação de saque foi recusada e o valor retornou ao saldo disponível.', 'payout_rejected')`
        ).run(crypto.randomUUID(), payout.pro_user_id);
      } else if (action === 'mark-paid' && (payout.status === 'approved' || payout.status === 'pending')) {
        db.prepare(
          `UPDATE payout_requests
           SET status = 'paid', paid_at = datetime('now'), admin_notes = ?, external_reference = ?, transfer_receipt = ?
           WHERE id = ?`
        ).run(notes, externalReference, transferReceipt || null, payout.id);
        db.prepare(`UPDATE professional_balances SET paid_cents = paid_cents + ? WHERE professional_id = ?`).run(
          payout.amount_cents,
          payout.professional_id
        );
        db.prepare(
          `INSERT INTO financial_transactions (
            id, professional_id, transaction_type, gross_cents, platform_fee_cents, professional_cents, currency, status
          ) VALUES (?, ?, 'payout_debit', ?, 0, ?, 'BRL', 'posted')`
        ).run(crypto.randomUUID(), payout.professional_id, payout.amount_cents, payout.amount_cents);
        db.prepare(
          `INSERT INTO notifications (id, user_id, title, message, type)
           VALUES (?, ?, 'Repasse efetuado', ?, 'payout_paid')`
        ).run(
          crypto.randomUUID(),
          payout.pro_user_id,
          `O pagamento do seu saque foi confirmado pela administração (Ref.: ${externalReference}).`
        );
      } else {
        throw new Error('Transição de status inválida para esta solicitação.');
      }

      logAudit(db, req.auth!.userId, `ADMIN_PAYOUT_${action.toUpperCase()}`, 'payout_request', String(payout.id), {
        notes,
        externalReference,
      });
    });

    try {
      tx();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Erro ao processar saque.' });
    }
  });

  // 8. Coupons & Reviews
  router.get('/coupons', (_req, res) => {
    const coupons = db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
    res.json({ coupons });
  });

  router.post('/coupons', (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      code: z.string().min(3).max(30),
      discountType: z.enum(['percentage', 'fixed_cents']),
      discountValue: z.number().int().min(1),
      usageLimit: z.number().int().min(1).nullable().optional(),
      expirationDate: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Dados do cupom inválidos.' });
      return;
    }

    const code = parsed.data.code.trim().toUpperCase();
    if (db.prepare('SELECT id FROM coupons WHERE UPPER(code) = ?').get(code)) {
      res.status(409).json({ error: 'Cupom já existe.' });
      return;
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO coupons (id, code, discount_type, discount_value, usage_limit, expiration_date, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(id, code, parsed.data.discountType, parsed.data.discountValue, parsed.data.usageLimit ?? null, parsed.data.expirationDate ?? null);

    logAudit(db, req.auth!.userId, 'ADMIN_COUPON_CREATED', 'coupon', id, { code });
    res.status(201).json({ ok: true, id });
  });

  router.patch('/coupons/:id', (req: AuthenticatedRequest, res) => {
    const isActive = req.body?.isActive ? 1 : 0;
    db.prepare('UPDATE coupons SET is_active = ? WHERE id = ?').run(isActive, req.params.id);
    logAudit(db, req.auth!.userId, 'ADMIN_COUPON_TOGGLED', 'coupon', req.params.id, { isActive });
    res.json({ ok: true });
  });

  router.delete('/coupons/:id', (req: AuthenticatedRequest, res) => {
    db.prepare('DELETE FROM coupons WHERE id = ?').run(req.params.id);
    logAudit(db, req.auth!.userId, 'ADMIN_COUPON_DELETED', 'coupon', req.params.id);
    res.json({ ok: true });
  });

  router.get('/reviews', (_req, res) => {
    const reviews = db
      .prepare(
        `SELECT r.*, pr.professional_name, cp.full_name AS client_name
         FROM reviews r
         JOIN professionals pr ON pr.id = r.professional_id
         JOIN clients c ON c.id = r.client_id
         JOIN profiles cp ON cp.id = c.user_id
         ORDER BY r.created_at DESC`
      )
      .all();
    res.json({ reviews });
  });

  router.patch('/reviews/:id', (req: AuthenticatedRequest, res) => {
    const status = String(req.body?.status || 'published');
    if (!['published', 'hidden', 'flagged'].includes(status)) {
      res.status(400).json({ error: 'Status inválido.' });
      return;
    }
    db.prepare('UPDATE reviews SET status = ? WHERE id = ?').run(status, req.params.id);
    logAudit(db, req.auth!.userId, 'ADMIN_REVIEW_MODERATED', 'review', req.params.id, { status });
    res.json({ ok: true });
  });

  // 9. Admin Notifications & Broadcasts
  router.get('/notifications', (_req, res) => {
    const notifications = db
      .prepare(
        `SELECT n.*, p.full_name AS recipient_name, p.user_role AS recipient_role
         FROM notifications n
         JOIN profiles p ON p.id = n.user_id
         ORDER BY n.created_at DESC LIMIT 80`
      )
      .all();
    res.json({ notifications });
  });

  router.post('/notifications/broadcast', (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      audience: z.enum(['all', 'professionals', 'clients']),
      title: z.string().min(3).max(120),
      message: z.string().min(5).max(800),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
      return;
    }

    let roleSql = "SELECT id FROM profiles WHERE status = 'active'";
    if (parsed.data.audience === 'professionals') roleSql += " AND user_role = 'professional'";
    else if (parsed.data.audience === 'clients') roleSql += " AND user_role = 'client'";

    const recipients = db.prepare(roleSql).all() as Array<{ id: string }>;
    const insert = db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, 'admin_notice')`
    );

    const tx = db.transaction(() => {
      for (const r of recipients) {
        insert.run(crypto.randomUUID(), r.id, parsed.data.title.trim(), parsed.data.message.trim());
      }
      logAudit(db, req.auth!.userId, 'ADMIN_BROADCAST_SENT', 'notification', parsed.data.audience, {
        count: recipients.length,
        title: parsed.data.title,
      });
    });
    tx();

    res.status(201).json({ ok: true, sentCount: recipients.length });
  });

  // 10. Comprehensive Reports with multi-filter + computed KPIs
  router.get('/reports', (req, res) => {
    const proId = String(req.query.professionalId || '');
    const clientId = String(req.query.clientId || '');
    const status = String(req.query.status || '');
    const billingMode = String(req.query.billingMode || '');
    const paymentStatus = String(req.query.paymentStatus || '');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');

    let sql = `
      SELECT
        b.id AS booking_id, b.scheduled_at, b.duration_minutes, b.billing_mode, b.status AS booking_status,
        pr.id AS professional_id, pr.professional_name,
        c.id AS client_id, cp.full_name AS client_name,
        py.status AS payment_status, py.payment_method,
        COALESCE(ft.gross_cents, b.amount_cents) AS gross_cents,
        COALESCE(ft.platform_fee_cents, 0) AS platform_fee_cents,
        COALESCE(ft.professional_cents, 0) AS professional_cents,
        COALESCE(vc.duration_seconds, 0) AS duration_seconds
      FROM bookings b
      JOIN professionals pr ON pr.id = b.professional_id
      JOIN clients c ON c.id = b.client_id
      JOIN profiles cp ON cp.id = c.user_id
      LEFT JOIN payments py ON py.booking_id = b.id
      LEFT JOIN financial_transactions ft ON ft.booking_id = b.id AND ft.transaction_type = 'session_credit'
      LEFT JOIN video_calls vc ON vc.booking_id = b.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (proId) {
      sql += ' AND b.professional_id = ?';
      params.push(proId);
    }
    if (clientId) {
      sql += ' AND b.client_id = ?';
      params.push(clientId);
    }
    if (status) {
      sql += ' AND b.status = ?';
      params.push(status);
    }
    if (billingMode) {
      sql += ' AND b.billing_mode = ?';
      params.push(billingMode);
    }
    if (paymentStatus) {
      sql += ' AND py.status = ?';
      params.push(paymentStatus);
    }
    if (from) {
      sql += ' AND date(b.scheduled_at) >= date(?)';
      params.push(from);
    }
    if (to) {
      sql += ' AND date(b.scheduled_at) <= date(?)';
      params.push(to);
    }
    sql += ' ORDER BY b.scheduled_at DESC';

    const rows = db.prepare(sql).all(...params) as Array<Record<string, any>>;

    let grossCents = 0;
    let platformCents = 0;
    let proCents = 0;
    let approvedPayments = 0;
    let rejectedPayments = 0;
    let refundedPayments = 0;
    let totalDurationSec = 0;
    let completedCalls = 0;

    for (const r of rows) {
      if (r.payment_status === 'approved') {
        grossCents += Number(r.gross_cents || 0);
        platformCents += Number(r.platform_fee_cents || 0);
        proCents += Number(r.professional_cents || 0);
        approvedPayments++;
      } else if (r.payment_status === 'rejected') {
        rejectedPayments++;
      } else if (r.payment_status === 'refunded') {
        refundedPayments++;
      }
      if (r.booking_status === 'finalizada') {
        completedCalls++;
        totalDurationSec += Number(r.duration_seconds || 0);
      }
    }

    const avgTicketCents = approvedPayments > 0 ? Math.round(grossCents / approvedPayments) : 0;
    const avgDurationSec = completedCalls > 0 ? Math.round(totalDurationSec / completedCalls) : 0;

    const proOptions = db.prepare('SELECT id, professional_name FROM professionals ORDER BY professional_name ASC').all();
    const clientOptions = db
      .prepare('SELECT c.id, p.full_name FROM clients c JOIN profiles p ON p.id = c.user_id ORDER BY p.full_name ASC')
      .all();

    res.json({
      rows,
      summary: {
        grossCents,
        platformCents,
        proCents,
        approvedPayments,
        rejectedPayments,
        refundedPayments,
        totalCalls: rows.length,
        avgDurationSec,
        avgTicketCents,
      },
      proOptions,
      clientOptions,
    });
  });

  // 11. Settings, Integration Check & Supabase Connection Diagnostic
  router.get('/settings', (_req, res) => {
    const rows = db.prepare('SELECT setting_key, setting_value FROM platform_settings').all() as Array<{
      setting_key: string;
      setting_value: string;
    }>;
    const settings: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        settings[r.setting_key] = JSON.parse(r.setting_value);
      } catch {
        settings[r.setting_key] = r.setting_value;
      }
    }

    const defaultSupabaseUrl = 'https://jyfpqcjpwdmzmpccdekw.supabase.co';
    const supabaseUrl = process.env.VITE_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || '';
    const supabaseAnon = process.env.VITE_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || '';
    const supabaseService = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim() || '';
    const supabaseJwksUrl = process.env.SUPABASE_JWKS_URL?.trim() || (supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json` : '');

    const mpCfg = loadGatewayRuntimeConfig(db, 'mercadopago');
    const ppCfg = loadGatewayRuntimeConfig(db, 'paypal');

    const integrations = {
      supabaseConfigured: Boolean(supabaseUrl && (supabaseAnon || supabaseService)),
      supabaseUrlConfigured: Boolean(supabaseUrl),
      supabaseAnonConfigured: Boolean(supabaseAnon),
      supabaseServiceRoleConfigured: Boolean(supabaseUrl && supabaseService),
      supabaseJwksConfigured: Boolean(supabaseJwksUrl),
      supabaseTargetUrl: supabaseUrl || defaultSupabaseUrl,
      livekitConfigured: Boolean(process.env.LIVEKIT_URL?.trim() && process.env.LIVEKIT_API_KEY?.trim() && process.env.LIVEKIT_API_SECRET?.trim()),
      mercadoPagoConfigured: Boolean(mpCfg?.hasLiveCredentials),
      paypalConfigured: Boolean(ppCfg?.hasLiveCredentials),
    };

    res.json({ settings, integrations });
  });

  router.post('/supabase-verify', async (_req, res) => {
    const defaultSupabaseUrl = 'https://jyfpqcjpwdmzmpccdekw.supabase.co';
    const url = process.env.VITE_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || '';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim() || '';
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY?.trim() || process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || '';
    const key = serviceKey || anonKey;
    const probeUrl = url || defaultSupabaseUrl;
    const jwksUrl = process.env.SUPABASE_JWKS_URL?.trim() || `${probeUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;

    if (!url || !key) {
      let reachable = false;
      try {
        const probe = await fetch(`${probeUrl.replace(/\/$/, '')}/auth/v1/health`, { method: 'GET' });
        const refHeader = probe.headers.get('sb-project-ref');
        reachable = probe.status === 200 || probe.status === 401 || Boolean(refHeader);
      } catch {
        reachable = false;
      }

      const missing: string[] = [];
      if (!url) missing.push('SUPABASE_URL / VITE_SUPABASE_URL');
      if (!anonKey) missing.push('SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_ANON_KEY');
      if (!serviceKey) missing.push('SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY');

      res.status(400).json({
        connected: false,
        reachable,
        targetUrl: probeUrl,
        missingVars: missing,
        message: reachable
          ? `Projeto Supabase (${probeUrl}) acessível via HTTPS. Adicione nos Secrets do ambiente: ${missing.join(', ')}.`
          : `Credenciais ausentes (${missing.join(', ')}) e não foi possível alcançar ${probeUrl}.`,
      });
      return;
    }

    try {
      const [authHealthRes, jwksRes] = await Promise.all([
        fetch(`${url.replace(/\/$/, '')}/auth/v1/health`, { headers: { apikey: key } }),
        fetch(jwksUrl, { method: 'GET' }),
      ]);

      if (!authHealthRes.ok) {
        res.status(400).json({
          connected: false,
          reachable: true,
          targetUrl: url,
          message: `Chave Supabase recusada pelo gateway (${authHealthRes.status}). Verifique SUPABASE_PUBLISHABLE_KEY e SUPABASE_SECRET_KEY.`,
        });
        return;
      }

      const jwksOk = jwksRes.ok;
      const sb = createClient(url, key);
      const { count, error } = await sb.from('professionals').select('*', { count: 'exact', head: true });
      if (error) {
        const missingServiceHint = !serviceKey
          ? ' Adicione também SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY) nos Secrets para acesso administrativo no backend.'
          : '';
        res.status(400).json({
          connected: false,
          reachable: true,
          keyAccepted: true,
          jwksOk,
          targetUrl: url,
          message: `Chave aceita pelo Supabase (${url}${jwksOk ? ', JWKS ativo' : ''}), mas houve erro ao consultar professionals: ${error.message}.${missingServiceHint}`,
        });
        return;
      }

      const { error: gwError } = await sb.from('payment_gateways').select('id', { count: 'exact', head: true });
      const { error: vcError } = await sb.from('video_calls').select('id', { count: 'exact', head: true });
      const { error: ftError } = await sb.from('financial_transactions').select('id', { count: 'exact', head: true });
      const missingTables: string[] = [];
      if (vcError) missingTables.push('video_calls');
      if (gwError) missingTables.push('payment_gateways');
      if (ftError) missingTables.push('financial_transactions');

      const migrationHint = missingTables.length > 0
        ? ` Tabelas pendentes no SQL Editor (${missingTables.join(', ')}): execute 007_sync_existing_supabase_project.sql.`
        : ' Schema completo, JWKS e multi-gateway (005/007) validados.';

      const serviceNote = !serviceKey
        ? ' (Aviso: operando apenas com chave pública; adicione SUPABASE_SECRET_KEY nos Secrets para operações admin/webhook).'
        : '';

      res.json({
        connected: true,
        reachable: true,
        keyAccepted: true,
        jwksOk,
        targetUrl: url,
        message: `Conectado ao Supabase (${url}${jwksOk ? ' · JWKS OK' : ''}) com sucesso. Tabela professionals acessível (${count ?? 0} registros).${migrationHint}${serviceNote}`,
      });
    } catch (err) {
      res.status(500).json({
        connected: false,
        targetUrl: url,
        message: err instanceof Error ? err.message : 'Falha ao testar conexão com Supabase.',
      });
    }
  });

  router.patch('/settings', (req: AuthenticatedRequest, res) => {
    const allowedKeys = [
      'platform_name',
      'global_commission_percentage',
      'session_billing_enabled',
      'per_minute_billing_enabled',
      'min_booking_lead_minutes',
      'cancellation_window_hours',
      'late_tolerance_minutes',
      'reconnect_grace_seconds',
      'minimum_payout_cents',
      'demo_mode_enabled',
    ];

    const upsert = db.prepare(
      `INSERT INTO platform_settings (id, setting_key, setting_value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`
    );

    const tx = db.transaction(() => {
      for (const key of allowedKeys) {
        if (req.body[key] !== undefined) {
          upsert.run(crypto.randomUUID(), key, JSON.stringify(req.body[key]));
        }
      }
      logAudit(db, req.auth!.userId, 'ADMIN_SETTINGS_UPDATED', 'platform_settings', 'global', req.body);
    });
    tx();

    res.json({ ok: true });
  });

  // 12. Audit Logs with search/filter
  router.get('/audit-logs', (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    let sql = `
      SELECT al.*, p.full_name AS actor_name, p.email AS actor_email
      FROM audit_logs al
      LEFT JOIN profiles p ON p.id = al.actor_user_id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    if (search) {
      sql += ` AND (LOWER(al.action) LIKE ? OR LOWER(COALESCE(p.email, '')) LIKE ? OR LOWER(al.entity_type) LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term);
    }
    sql += ' ORDER BY al.created_at DESC LIMIT 150';

    const logs = db.prepare(sql).all(...params);
    res.json({ logs });
  });

  router.post('/demo/clear', (req: AuthenticatedRequest, res) => {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM audit_logs WHERE is_demo = 1').run();
      db.prepare('DELETE FROM notifications WHERE is_demo = 1').run();
      db.prepare('DELETE FROM coupons WHERE is_demo = 1').run();
      db.prepare('DELETE FROM reviews WHERE is_demo = 1').run();
      db.prepare('DELETE FROM payout_requests WHERE is_demo = 1').run();
      db.prepare('DELETE FROM financial_transactions WHERE is_demo = 1').run();
      db.prepare('DELETE FROM payments WHERE is_demo = 1').run();
      db.prepare('DELETE FROM video_calls WHERE is_demo = 1').run();
      db.prepare('DELETE FROM bookings WHERE is_demo = 1').run();
      db.prepare('DELETE FROM clients WHERE is_demo = 1').run();
      db.prepare('DELETE FROM professionals WHERE is_demo = 1').run();
      db.prepare('DELETE FROM admin_users WHERE is_demo = 1').run();
      db.prepare('DELETE FROM profiles WHERE is_demo = 1').run();
      db.prepare(
        `UPDATE platform_settings SET setting_value = 'false', updated_at = datetime('now')
         WHERE setting_key = 'demo_mode_enabled'`
      ).run();
      logAudit(db, req.auth!.userId, 'DEMO_DATA_CLEARED', 'platform', 'system');
    });
    tx();

    res.json({ ok: true, message: 'Todos os dados de demonstração foram removidos.' });
  });

  return router;
}
