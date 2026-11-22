import { Router } from 'express';
import type Database from 'better-sqlite3';

export function createPublicRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/platform-info', (_req, res) => {
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

    res.json({
      platformName: settings.platform_name ?? 'Aurum Privé',
      demoModeEnabled: Boolean(settings.demo_mode_enabled),
      sessionBillingEnabled: Boolean(settings.session_billing_enabled ?? true),
      perMinuteBillingEnabled: Boolean(settings.per_minute_billing_enabled ?? true),
      minBookingLeadMinutes: Number(settings.min_booking_lead_minutes ?? 30),
      cancellationWindowHours: Number(settings.cancellation_window_hours ?? 4),
    });
  });

  router.get('/professionals', (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const category = String(req.query.category || '').trim();
    const status = String(req.query.status || '').trim();
    const instantOnly = req.query.instantOnly === 'true';
    const maxPriceCents = req.query.maxPriceCents ? Number(req.query.maxPriceCents) : null;

    let sql = `
      SELECT
        pr.id, pr.professional_name, pr.slug, pr.bio, pr.category, pr.languages,
        pr.profile_image, pr.gallery, pr.price_per_session_cents, pr.price_per_minute_cents,
        pr.session_duration, pr.availability_status, pr.is_featured, pr.instant_call_enabled, pr.is_demo,
        COALESCE(ROUND(AVG(CASE WHEN r.status = 'published' THEN r.rating END), 1), 5.0) AS rating_avg,
        COUNT(CASE WHEN r.status = 'published' THEN r.id END) AS review_count
      FROM professionals pr
      JOIN profiles p ON p.id = pr.user_id
      LEFT JOIN reviews r ON r.professional_id = pr.id
      WHERE pr.is_approved = 1 AND p.status = 'active'
    `;
    const params: unknown[] = [];

    if (category && category !== 'all') {
      sql += ` AND pr.category = ?`;
      params.push(category);
    }
    if (status && status !== 'all') {
      sql += ` AND pr.availability_status = ?`;
      params.push(status);
    }
    if (instantOnly) {
      sql += ` AND pr.instant_call_enabled = 1 AND pr.availability_status = 'online'`;
    }
    if (maxPriceCents !== null && !Number.isNaN(maxPriceCents)) {
      sql += ` AND pr.price_per_session_cents <= ?`;
      params.push(maxPriceCents);
    }
    if (search) {
      sql += ` AND (LOWER(pr.professional_name) LIKE ? OR LOWER(pr.category) LIKE ? OR LOWER(pr.bio) LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    sql += ` GROUP BY pr.id ORDER BY pr.is_featured DESC, CASE pr.availability_status WHEN 'online' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END, pr.professional_name ASC`;

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const formatted = rows.map((row) => ({
      ...row,
      languages: JSON.parse(String(row.languages || '[]')),
      gallery: JSON.parse(String(row.gallery || '[]')),
    }));

    const categories = db
      .prepare(
        `SELECT DISTINCT pr.category FROM professionals pr
         JOIN profiles p ON p.id = pr.user_id
         WHERE pr.is_approved = 1 AND p.status = 'active' ORDER BY pr.category ASC`
      )
      .all() as Array<{ category: string }>;

    res.json({
      professionals: formatted,
      categories: categories.map((c) => c.category),
    });
  });

  router.get('/professionals/:slug', (req, res) => {
    const pro = db
      .prepare(
        `SELECT
          pr.id, pr.professional_name, pr.slug, pr.bio, pr.category, pr.languages,
          pr.profile_image, pr.gallery, pr.price_per_session_cents, pr.price_per_minute_cents,
          pr.session_duration, pr.availability_status, pr.is_featured, pr.instant_call_enabled, pr.is_demo
         FROM professionals pr
         JOIN profiles p ON p.id = pr.user_id
         WHERE pr.slug = ? AND pr.is_approved = 1 AND p.status = 'active'`
      )
      .get(req.params.slug) as Record<string, unknown> | undefined;

    if (!pro) {
      res.status(404).json({ error: 'Profissional não encontrado ou indisponível.' });
      return;
    }

    const availability = db
      .prepare(
        `SELECT id, day_of_week, start_time, end_time, is_available
         FROM professional_availability
         WHERE professional_id = ? AND is_available = 1
         ORDER BY day_of_week ASC, start_time ASC`
      )
      .all(pro.id);

    const reviews = db
      .prepare(
        `SELECT r.id, r.rating, r.comment, r.created_at, p.full_name AS client_name
         FROM reviews r
         JOIN clients c ON c.id = r.client_id
         JOIN profiles p ON p.id = c.user_id
         WHERE r.professional_id = ? AND r.status = 'published'
         ORDER BY r.created_at DESC LIMIT 20`
      )
      .all(pro.id);

    const upcomingBookedSlots = db
      .prepare(
        `SELECT scheduled_at FROM bookings
         WHERE professional_id = ? AND status NOT IN ('cancelada', 'expirou') AND scheduled_at >= datetime('now')`
      )
      .all(pro.id) as Array<{ scheduled_at: string }>;

    const availabilityBlocks = db
      .prepare(
        `SELECT id, block_date, start_time, end_time, reason
         FROM professional_availability_blocks
         WHERE professional_id = ? AND block_date >= date('now')
         ORDER BY block_date ASC`
      )
      .all(pro.id);

    res.json({
      professional: {
        ...pro,
        languages: JSON.parse(String(pro.languages || '[]')),
        gallery: JSON.parse(String(pro.gallery || '[]')),
      },
      availability,
      availabilityBlocks,
      reviews,
      bookedSlots: upcomingBookedSlots.map((s) => s.scheduled_at),
    });
  });

  return router;
}
