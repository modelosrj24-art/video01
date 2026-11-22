import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { createAuthMiddleware, requireRole, logAudit, type AuthenticatedRequest } from '../security.ts';

function isSafeImageRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('/')) return !trimmed.startsWith('//');
  try {
    const u = new URL(trimmed);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function createProfessionalRouter(db: Database.Database): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth, requireRole('professional'));

  function getPro(userId: string) {
    return db
      .prepare(
        `SELECT pr.*, p.full_name, p.email, p.phone, p.status AS account_status
         FROM professionals pr
         JOIN profiles p ON p.id = pr.user_id
         WHERE pr.user_id = ?`
      )
      .get(userId) as Record<string, unknown> | undefined;
  }

  // 1. Individual Dashboard with period filter (daily | weekly | monthly)
  router.get('/dashboard', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Perfil profissional não encontrado.' });
      return;
    }

    const period = String(req.query.period || 'daily');
    const groupExpr =
      period === 'monthly'
        ? "strftime('%Y-%m', created_at)"
        : period === 'weekly'
          ? "strftime('%Y-W%W', created_at)"
          : 'date(created_at)';

    const balance = db.prepare('SELECT * FROM professional_balances WHERE professional_id = ?').get(pro.id);

    const kpis = db
      .prepare(
        `SELECT
           COUNT(*) AS total_sessions,
           SUM(CASE WHEN status = 'finalizada' THEN 1 ELSE 0 END) AS completed_sessions,
           SUM(CASE WHEN status IN ('pagamento_confirmado', 'em_andamento') THEN 1 ELSE 0 END) AS upcoming_sessions,
           SUM(CASE WHEN status = 'cancelada' THEN 1 ELSE 0 END) AS cancelled_sessions
         FROM bookings WHERE professional_id = ?`
      )
      .get(pro.id);

    const reviewAgg = db
      .prepare(
        `SELECT
           COUNT(*) AS review_count,
           COALESCE(ROUND(AVG(rating), 1), 5.0) AS avg_rating
         FROM reviews
         WHERE professional_id = ? AND status = 'published'`
      )
      .get(pro.id);

    const financialSummary = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN transaction_type IN ('session_credit', 'refund_debit') THEN gross_cents ELSE 0 END), 0) AS gross_cents,
           COALESCE(SUM(CASE WHEN transaction_type IN ('session_credit', 'refund_debit') THEN platform_fee_cents ELSE 0 END), 0) AS platform_fee_cents,
           COALESCE(SUM(CASE WHEN transaction_type IN ('session_credit', 'refund_debit', 'adjustment') THEN professional_cents ELSE 0 END), 0) AS net_cents
         FROM financial_transactions
         WHERE professional_id = ?`
      )
      .get(pro.id);

    const callTime = db
      .prepare(
        "SELECT COALESCE(SUM(duration_seconds), 0) AS total_seconds FROM video_calls WHERE professional_id = ? AND call_status = 'finalizada'"
      )
      .get(pro.id) as { total_seconds: number };

    const earningsToday = db
      .prepare(
        `SELECT COALESCE(SUM(professional_cents), 0) AS cents
         FROM financial_transactions
         WHERE professional_id = ? AND transaction_type = 'session_credit' AND date(created_at) = date('now')`
      )
      .get(pro.id) as { cents: number };

    const earningsWeek = db
      .prepare(
        `SELECT COALESCE(SUM(professional_cents), 0) AS cents
         FROM financial_transactions
         WHERE professional_id = ? AND transaction_type = 'session_credit' AND created_at >= datetime('now', '-7 days')`
      )
      .get(pro.id) as { cents: number };

    const earningsMonth = db
      .prepare(
        `SELECT COALESCE(SUM(professional_cents), 0) AS cents
         FROM financial_transactions
         WHERE professional_id = ? AND transaction_type = 'session_credit' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`
      )
      .get(pro.id) as { cents: number };

    const earningsSeries = db
      .prepare(
        `SELECT ${groupExpr} AS day,
                COALESCE(SUM(professional_cents), 0) AS cents,
                COALESCE(SUM(gross_cents), 0) AS gross_cents,
                COALESCE(SUM(platform_fee_cents), 0) AS platform_fee_cents,
                COUNT(*) AS sessions
         FROM financial_transactions
         WHERE professional_id = ? AND transaction_type = 'session_credit'
         GROUP BY ${groupExpr}
         ORDER BY day ASC LIMIT 30`
      )
      .all(pro.id);

    const incomingCalls = db
      .prepare(
        `SELECT vc.*, cp.full_name AS client_name, b.duration_minutes, b.billing_mode, b.scheduled_at
         FROM video_calls vc
         JOIN bookings b ON b.id = vc.booking_id
         JOIN clients c ON c.id = vc.client_id
         JOIN profiles cp ON cp.id = c.user_id
         WHERE vc.professional_id = ?
           AND vc.call_status IN ('aguardando_profissional', 'pagamento_confirmado', 'aguardando_cliente', 'em_andamento')
         ORDER BY vc.created_at DESC`
      )
      .all(pro.id);

    const upcomingBookings = db
      .prepare(
        `SELECT b.*, cp.full_name AS client_name, vc.id AS video_call_id, vc.call_status
         FROM bookings b
         JOIN clients c ON c.id = b.client_id
         JOIN profiles cp ON cp.id = c.user_id
         LEFT JOIN video_calls vc ON vc.booking_id = b.id
         WHERE b.professional_id = ?
           AND b.status IN ('pagamento_confirmado', 'aguardando_pagamento', 'em_andamento')
         ORDER BY b.scheduled_at ASC LIMIT 6`
      )
      .all(pro.id);

    const recentReviews = db
      .prepare(
        `SELECT r.id, r.rating, r.comment, r.created_at, cp.full_name AS client_name
         FROM reviews r
         JOIN clients c ON c.id = r.client_id
         JOIN profiles cp ON cp.id = c.user_id
         WHERE r.professional_id = ? AND r.status = 'published'
         ORDER BY r.created_at DESC LIMIT 4`
      )
      .all(pro.id);

    const clientCount = db
      .prepare('SELECT COUNT(DISTINCT client_id) AS count FROM bookings WHERE professional_id = ?')
      .get(pro.id) as { count: number };

    res.json({
      professional: {
        ...pro,
        languages: JSON.parse(String(pro.languages || '[]')),
        gallery: JSON.parse(String(pro.gallery || '[]')),
      },
      balance,
      kpis,
      reviewAgg,
      financialSummary,
      authorizedClientCount: clientCount.count,
      totalCallSeconds: callTime.total_seconds,
      earningsTodayCents: earningsToday.cents,
      earningsWeekCents: earningsWeek.cents,
      earningsMonthCents: earningsMonth.cents,
      earningsSeries,
      incomingCalls,
      upcomingBookings,
      recentReviews,
    });
  });

  // 2. Profile management (commercial prices & commission remain admin-locked)
  router.patch('/profile', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const schema = z.object({
      fullName: z.string().min(2).max(120).optional(),
      phone: z.string().max(30).optional(),
      professionalName: z.string().min(2).max(120).optional(),
      bio: z.string().min(10).max(2000).optional(),
      languages: z.array(z.string().min(2).max(40)).min(1).max(8).optional(),
      availabilityStatus: z.enum(['online', 'offline', 'busy']).optional(),
      instantCallEnabled: z.boolean().optional(),
      profileImage: z
        .string()
        .max(500)
        .refine(isSafeImageRef, 'URL de imagem inválida.')
        .optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
      return;
    }

    const nextProName = parsed.data.professionalName?.trim() || String(pro.professional_name);
    const nextBio = parsed.data.bio !== undefined ? parsed.data.bio.trim() : String(pro.bio);
    const nextLangs = parsed.data.languages ? JSON.stringify(parsed.data.languages) : String(pro.languages);
    const nextStatus = parsed.data.availabilityStatus ?? String(pro.availability_status);
    const nextInstant =
      parsed.data.instantCallEnabled !== undefined
        ? parsed.data.instantCallEnabled
          ? 1
          : 0
        : Number(pro.instant_call_enabled);
    const nextImg =
      parsed.data.profileImage !== undefined
        ? parsed.data.profileImage.trim() || null
        : pro.profile_image
          ? String(pro.profile_image)
          : null;

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE professionals
         SET professional_name = ?, bio = ?, languages = ?, availability_status = ?, instant_call_enabled = ?, profile_image = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      ).run(nextProName, nextBio, nextLangs, nextStatus, nextInstant, nextImg, pro.id, req.auth!.userId);

      if (parsed.data.fullName !== undefined || parsed.data.phone !== undefined) {
        db.prepare(
          `UPDATE profiles
           SET full_name = COALESCE(?, full_name),
               phone = COALESCE(?, phone),
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          parsed.data.fullName ? parsed.data.fullName.trim() : null,
          parsed.data.phone !== undefined ? parsed.data.phone.trim() : null,
          req.auth!.userId
        );
      }

      logAudit(db, req.auth!.userId, 'PROFESSIONAL_PROFILE_UPDATED', 'professional', String(pro.id), {
        availabilityStatus: nextStatus,
      });
    });
    tx();

    const updated = getPro(req.auth!.userId)!;
    res.json({
      professional: {
        ...updated,
        languages: JSON.parse(String(updated.languages || '[]')),
        gallery: JSON.parse(String(updated.gallery || '[]')),
      },
    });
  });

  // 3. Weekly availability + date-specific blocks
  router.get('/availability', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }
    const slots = db
      .prepare('SELECT * FROM professional_availability WHERE professional_id = ? ORDER BY day_of_week ASC, start_time ASC')
      .all(pro.id);
    const blocks = db
      .prepare('SELECT * FROM professional_availability_blocks WHERE professional_id = ? ORDER BY block_date ASC, start_time ASC')
      .all(pro.id);
    res.json({ slots, blocks });
  });

  router.put('/availability', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const slotSchema = z.object({
      slots: z.array(
        z.object({
          day_of_week: z.number().int().min(0).max(6),
          start_time: z.string().regex(/^\d{2}:\d{2}$/),
          end_time: z.string().regex(/^\d{2}:\d{2}$/),
          is_available: z.boolean(),
        })
      ),
    });

    const parsed = slotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Horários inválidos.' });
      return;
    }

    for (const s of parsed.data.slots) {
      if (s.end_time <= s.start_time) {
        res.status(400).json({ error: 'O horário de término deve ser posterior ao início.' });
        return;
      }
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM professional_availability WHERE professional_id = ?').run(pro.id);
      const insert = db.prepare(
        `INSERT INTO professional_availability (id, professional_id, day_of_week, start_time, end_time, is_available)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const s of parsed.data.slots) {
        insert.run(crypto.randomUUID(), pro.id, s.day_of_week, s.start_time, s.end_time, s.is_available ? 1 : 0);
      }
      logAudit(db, req.auth!.userId, 'PROFESSIONAL_AVAILABILITY_UPDATED', 'professional', String(pro.id), {
        slotCount: parsed.data.slots.length,
      });
    });
    tx();

    const slots = db
      .prepare('SELECT * FROM professional_availability WHERE professional_id = ? ORDER BY day_of_week ASC, start_time ASC')
      .all(pro.id);
    res.json({ slots });
  });

  router.post('/availability/blocks', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const schema = z.object({
      blockDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (use AAAA-MM-DD).'),
      startTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional()
        .or(z.literal('')),
      endTime: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional()
        .or(z.literal('')),
      reason: z.string().max(160).optional().default(''),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados do bloqueio inválidos.' });
      return;
    }

    const start = parsed.data.startTime?.trim() || null;
    const end = parsed.data.endTime?.trim() || null;
    if ((start && !end) || (!start && end)) {
      res.status(400).json({ error: 'Informe início e fim para bloqueio parcial, ou deixe ambos vazios para dia inteiro.' });
      return;
    }
    if (start && end && end <= start) {
      res.status(400).json({ error: 'O horário de término do bloqueio deve ser posterior ao início.' });
      return;
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO professional_availability_blocks (id, professional_id, block_date, start_time, end_time, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, pro.id, parsed.data.blockDate, start, end, parsed.data.reason.trim());

    logAudit(db, req.auth!.userId, 'PROFESSIONAL_BLOCK_ADDED', 'professional_availability_block', id, {
      blockDate: parsed.data.blockDate,
    });

    const block = db.prepare('SELECT * FROM professional_availability_blocks WHERE id = ?').get(id);
    res.status(201).json({ block });
  });

  router.delete('/availability/blocks/:id', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const result = db
      .prepare('DELETE FROM professional_availability_blocks WHERE id = ? AND professional_id = ?')
      .run(req.params.id, pro.id);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Bloqueio não encontrado para este profissional.' });
      return;
    }
    res.json({ ok: true });
  });

  // 4. Bookings (Strictly scoped to pro.id)
  router.get('/bookings', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const status = String(req.query.status || 'all');
    const search = String(req.query.search || '').trim().toLowerCase();

    let sql = `
      SELECT b.*, cp.full_name AS client_name, cp.email AS client_email,
             vc.id AS video_call_id, vc.call_status, vc.duration_seconds
      FROM bookings b
      JOIN clients c ON c.id = b.client_id
      JOIN profiles cp ON cp.id = c.user_id
      LEFT JOIN video_calls vc ON vc.booking_id = b.id
      WHERE b.professional_id = ?
    `;
    const params: unknown[] = [pro.id];

    if (status !== 'all') {
      sql += ' AND b.status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (LOWER(cp.full_name) LIKE ? OR LOWER(cp.email) LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term);
    }
    sql += ' ORDER BY b.scheduled_at DESC';

    const bookings = db.prepare(sql).all(...params);
    res.json({ bookings });
  });

  router.post('/bookings/:id/cancel', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const booking = db
      .prepare(
        `SELECT b.*, c.user_id AS client_user_id
         FROM bookings b
         JOIN clients c ON c.id = b.client_id
         WHERE b.id = ? AND b.professional_id = ?`
      )
      .get(req.params.id, pro.id) as Record<string, unknown> | undefined;

    if (!booking) {
      res.status(404).json({ error: 'Agendamento não encontrado para este profissional.' });
      return;
    }
    if (booking.status === 'finalizada' || booking.status === 'cancelada') {
      res.status(400).json({ error: 'Este agendamento não pode ser cancelado.' });
      return;
    }

    const reason = String(req.body?.reason || 'Cancelado pelo profissional').slice(0, 300);
    const tx = db.transaction(() => {
      db.prepare(`UPDATE bookings SET status = 'cancelada', cancellation_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(
        reason,
        booking.id
      );
      db.prepare(`UPDATE video_calls SET call_status = 'cancelada' WHERE booking_id = ?`).run(booking.id);
      db.prepare(
        `INSERT INTO notifications (id, user_id, title, message, type)
         VALUES (?, ?, 'Sessão cancelada pelo profissional', ?, 'booking_cancelled')`
      ).run(crypto.randomUUID(), booking.client_user_id, `Sua sessão com ${pro.professional_name} foi cancelada: ${reason}`);
      logAudit(db, req.auth!.userId, 'BOOKING_CANCELLED_BY_PROFESSIONAL', 'booking', String(booking.id), { reason });
    });
    tx();

    res.json({ ok: true });
  });

  // 5. Video Calls History + Summary (Strictly scoped to pro.id)
  router.get('/calls', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const status = String(req.query.status || 'all');
    const search = String(req.query.search || '').trim().toLowerCase();

    let sql = `
      SELECT vc.*, cp.full_name AS client_name, b.scheduled_at, b.duration_minutes, b.billing_mode, b.is_instant
      FROM video_calls vc
      JOIN bookings b ON b.id = vc.booking_id
      JOIN clients c ON c.id = vc.client_id
      JOIN profiles cp ON cp.id = c.user_id
      WHERE vc.professional_id = ?
    `;
    const params: unknown[] = [pro.id];

    if (status !== 'all') {
      sql += ' AND vc.call_status = ?';
      params.push(status);
    }
    if (search) {
      sql += ' AND (LOWER(cp.full_name) LIKE ? OR LOWER(vc.room_name) LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term);
    }
    sql += ' ORDER BY vc.created_at DESC';

    const calls = db.prepare(sql).all(...params);
    const summary = db
      .prepare(
        `SELECT
           COUNT(*) AS total_calls,
           SUM(CASE WHEN call_status = 'finalizada' THEN 1 ELSE 0 END) AS completed_calls,
           SUM(CASE WHEN call_status IN ('aguardando_profissional', 'pagamento_confirmado', 'aguardando_cliente', 'em_andamento') THEN 1 ELSE 0 END) AS active_calls,
           COALESCE(SUM(CASE WHEN call_status = 'finalizada' THEN duration_seconds ELSE 0 END), 0) AS total_seconds,
           COALESCE(ROUND(AVG(CASE WHEN call_status = 'finalizada' THEN duration_seconds END)), 0) AS avg_duration_seconds
         FROM video_calls
         WHERE professional_id = ?`
      )
      .get(pro.id);

    res.json({ calls, summary });
  });

  // 6. Isolated CRM: Strictly scoped to clients who have booked with THIS professional
  router.get('/clients', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const search = String(req.query.search || '').trim().toLowerCase();
    let sql = `
      SELECT
        c.id AS client_id,
        cp.full_name,
        cp.email,
        cp.created_at AS registered_at,
        COUNT(b.id) AS total_sessions,
        SUM(CASE WHEN b.status = 'finalizada' THEN 1 ELSE 0 END) AS completed_sessions,
        COALESCE(SUM(CASE WHEN b.status IN ('pagamento_confirmado', 'em_andamento', 'finalizada') THEN b.amount_cents ELSE 0 END), 0) AS total_spent_cents,
        MAX(b.scheduled_at) AS last_session_at,
        COALESCE(pcn.notes, '') AS private_notes
      FROM bookings b
      JOIN clients c ON c.id = b.client_id
      JOIN profiles cp ON cp.id = c.user_id
      LEFT JOIN professional_client_notes pcn ON pcn.professional_id = ? AND pcn.client_id = c.id
      WHERE b.professional_id = ?
    `;
    const params: unknown[] = [pro.id, pro.id];

    if (search) {
      sql += ' AND (LOWER(cp.full_name) LIKE ? OR LOWER(cp.email) LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term);
    }

    sql += ' GROUP BY c.id ORDER BY last_session_at DESC';

    const clients = db.prepare(sql).all(...params);
    res.json({ clients });
  });

  // Isolated client history: ONLY sessions/calls/reviews between THIS client and THIS professional
  router.get('/clients/:clientId/history', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const hasBooking = db
      .prepare('SELECT id FROM bookings WHERE professional_id = ? AND client_id = ? LIMIT 1')
      .get(pro.id, req.params.clientId);
    if (!hasBooking) {
      res.status(403).json({ error: 'Acesso negado: cliente sem vínculo autorizado com este profissional.' });
      return;
    }

    const sessions = db
      .prepare(
        `SELECT b.id, b.scheduled_at, b.duration_minutes, b.billing_mode, b.amount_cents, b.status, b.is_instant,
                vc.id AS video_call_id, vc.call_status, vc.duration_seconds,
                r.rating, r.comment AS review_comment
         FROM bookings b
         LEFT JOIN video_calls vc ON vc.booking_id = b.id
         LEFT JOIN reviews r ON r.booking_id = b.id AND r.professional_id = b.professional_id AND r.status = 'published'
         WHERE b.professional_id = ? AND b.client_id = ?
         ORDER BY b.scheduled_at DESC`
      )
      .all(pro.id, req.params.clientId);

    res.json({ sessions });
  });

  router.put('/clients/:clientId/notes', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const hasBooking = db
      .prepare('SELECT id FROM bookings WHERE professional_id = ? AND client_id = ? LIMIT 1')
      .get(pro.id, req.params.clientId);
    if (!hasBooking) {
      res.status(403).json({ error: 'Cliente sem vínculo de atendimento com este profissional.' });
      return;
    }

    const notes = String(req.body?.notes || '').slice(0, 2000);
    db.prepare(
      `INSERT INTO professional_client_notes (id, professional_id, client_id, notes)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(professional_id, client_id) DO UPDATE SET notes = excluded.notes, updated_at = datetime('now')`
    ).run(crypto.randomUUID(), pro.id, req.params.clientId, notes);

    logAudit(db, req.auth!.userId, 'PROFESSIONAL_CLIENT_NOTE_SAVED', 'client', req.params.clientId);
    res.json({ ok: true });
  });

  // 7. Financials, Commissions, Balance & Payouts (Strictly scoped to pro.id)
  router.get('/financials', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const type = String(req.query.type || 'all');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');

    const balance = db.prepare('SELECT * FROM professional_balances WHERE professional_id = ?').get(pro.id);

    const summary = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN transaction_type = 'session_credit' THEN gross_cents ELSE 0 END), 0) AS total_gross_cents,
           COALESCE(SUM(CASE WHEN transaction_type = 'session_credit' THEN platform_fee_cents ELSE 0 END), 0) AS total_platform_fee_cents,
           COALESCE(SUM(CASE WHEN transaction_type = 'session_credit' THEN professional_cents ELSE 0 END), 0) AS total_net_cents,
           COALESCE(SUM(CASE WHEN transaction_type = 'refund_debit' THEN ABS(professional_cents) ELSE 0 END), 0) AS total_refunded_cents,
           COALESCE(SUM(CASE WHEN transaction_type = 'adjustment' THEN professional_cents ELSE 0 END), 0) AS total_adjustments_cents
         FROM financial_transactions
         WHERE professional_id = ?`
      )
      .get(pro.id);

    let txSql = `
      SELECT ft.*, cp.full_name AS client_name
      FROM financial_transactions ft
      LEFT JOIN clients c ON c.id = ft.client_id
      LEFT JOIN profiles cp ON cp.id = c.user_id
      WHERE ft.professional_id = ?
    `;
    const txParams: unknown[] = [pro.id];

    if (type !== 'all') {
      txSql += ' AND ft.transaction_type = ?';
      txParams.push(type);
    }
    if (from) {
      txSql += ' AND date(ft.created_at) >= date(?)';
      txParams.push(from);
    }
    if (to) {
      txSql += ' AND date(ft.created_at) <= date(?)';
      txParams.push(to);
    }
    txSql += ' ORDER BY ft.created_at DESC';

    const transactions = db.prepare(txSql).all(...txParams);
    const payouts = db
      .prepare('SELECT * FROM payout_requests WHERE professional_id = ? ORDER BY requested_at DESC')
      .all(pro.id);

    const minSetting = db
      .prepare("SELECT setting_value FROM platform_settings WHERE setting_key = 'minimum_payout_cents'")
      .get() as { setting_value: string } | undefined;
    const minimumPayoutCents = minSetting ? Number(JSON.parse(minSetting.setting_value)) : 10000;

    const commissionPercentage = Number(pro.commission_percentage);
    res.json({
      balance,
      summary,
      transactions,
      payouts,
      commissionPercentage,
      proNetPercentage: Number((100 - commissionPercentage).toFixed(2)),
      minimumPayoutCents,
    });
  });

  router.post('/payouts', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }

    const schema = z.object({
      amountCents: z.number().int().min(1000, 'Valor mínimo de saque é R$ 10,00'),
      payoutMethod: z.enum(['pix', 'ted']),
      pixKey: z.string().max(160).optional().default(''),
      tedDetails: z.string().max(240).optional().default(''),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados de saque inválidos.' });
      return;
    }

    const detailsText =
      parsed.data.payoutMethod === 'pix' ? parsed.data.pixKey.trim() : parsed.data.tedDetails.trim();
    if (detailsText.length < 3) {
      res.status(400).json({
        error:
          parsed.data.payoutMethod === 'pix'
            ? 'Informe uma chave PIX válida.'
            : 'Informe banco, agência, conta e CPF/CNPJ do titular.',
      });
      return;
    }

    const minSetting = db
      .prepare("SELECT setting_value FROM platform_settings WHERE setting_key = 'minimum_payout_cents'")
      .get() as { setting_value: string } | undefined;
    const minCents = minSetting ? Number(JSON.parse(minSetting.setting_value)) : 10000;

    if (parsed.data.amountCents < minCents) {
      res.status(400).json({ error: `Valor mínimo para saque é R$ ${(minCents / 100).toFixed(2)}.` });
      return;
    }

    const payoutId = crypto.randomUUID();
    try {
      const tx = db.transaction(() => {
        const balance = db
          .prepare('SELECT available_cents FROM professional_balances WHERE professional_id = ?')
          .get(pro.id) as { available_cents: number } | undefined;

        if (!balance || balance.available_cents < parsed.data.amountCents) {
          throw new Error('Saldo disponível insuficiente para este saque.');
        }

        // Reserve funds atomically so double-withdrawal cannot happen
        db.prepare(
          `UPDATE professional_balances
           SET available_cents = available_cents - ?, updated_at = datetime('now')
           WHERE professional_id = ?`
        ).run(parsed.data.amountCents, pro.id);

        const storedDetails =
          parsed.data.payoutMethod === 'pix'
            ? JSON.stringify({ pixKey: detailsText })
            : JSON.stringify({ bankAccount: detailsText });

        db.prepare(
          `INSERT INTO payout_requests (id, professional_id, amount_cents, payout_method, payout_details, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`
        ).run(payoutId, pro.id, parsed.data.amountCents, parsed.data.payoutMethod, storedDetails);

        // Notify admins about the payout request
        const admins = db.prepare('SELECT user_id FROM admin_users').all() as Array<{ user_id: string }>;
        const notifyAdmin = db.prepare(
          `INSERT INTO notifications (id, user_id, title, message, type) VALUES (?, ?, ?, ?, 'payout_requested')`
        );
        for (const a of admins) {
          notifyAdmin.run(
            crypto.randomUUID(),
            a.user_id,
            'Nova solicitação de saque',
            `${pro.professional_name} solicitou repasse de R$ ${(parsed.data.amountCents / 100).toFixed(2)} via ${parsed.data.payoutMethod.toUpperCase()}.`
          );
        }

        logAudit(db, req.auth!.userId, 'PAYOUT_REQUESTED', 'payout_request', payoutId, {
          amountCents: parsed.data.amountCents,
          method: parsed.data.payoutMethod,
        });
      });
      tx();
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Erro ao solicitar saque.' });
      return;
    }

    res.status(201).json({ ok: true, payoutId });
  });

  // 8. Reviews & Notifications (Strictly scoped)
  router.get('/reviews', (req: AuthenticatedRequest, res) => {
    const pro = getPro(req.auth!.userId);
    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado.' });
      return;
    }
    const reviews = db
      .prepare(
        `SELECT r.*, cp.full_name AS client_name
         FROM reviews r
         JOIN clients c ON c.id = r.client_id
         JOIN profiles cp ON cp.id = c.user_id
         WHERE r.professional_id = ? AND r.status = 'published'
         ORDER BY r.created_at DESC`
      )
      .all(pro.id);
    res.json({ reviews });
  });

  router.get('/notifications', (req: AuthenticatedRequest, res) => {
    const notifications = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 60')
      .all(req.auth!.userId);
    res.json({ notifications });
  });

  router.post('/notifications/read-all', (req: AuthenticatedRequest, res) => {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(
      req.auth!.userId
    );
    res.json({ ok: true });
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
