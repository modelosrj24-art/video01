import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const DB_PATH = path.join(DATA_DIR, 'platform.db');

export function initDatabase(): Database.Database {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      phone TEXT,
      avatar_url TEXT,
      user_role TEXT NOT NULL CHECK (user_role IN ('admin', 'professional', 'client')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'suspended', 'blocked')),
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      user_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      granted_by TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS professionals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
      professional_name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      bio TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      languages TEXT NOT NULL DEFAULT '["Português"]',
      profile_image TEXT,
      gallery TEXT NOT NULL DEFAULT '[]',
      price_per_session_cents INTEGER NOT NULL CHECK (price_per_session_cents >= 0),
      price_per_minute_cents INTEGER DEFAULT 0 CHECK (price_per_minute_cents >= 0),
      session_duration INTEGER NOT NULL DEFAULT 30 CHECK (session_duration > 0),
      commission_percentage REAL NOT NULL DEFAULT 30.0 CHECK (commission_percentage >= 0 AND commission_percentage <= 100),
      availability_status TEXT NOT NULL DEFAULT 'offline' CHECK (availability_status IN ('online', 'offline', 'busy')),
      is_approved INTEGER NOT NULL DEFAULT 0,
      is_featured INTEGER NOT NULL DEFAULT 0,
      instant_call_enabled INTEGER NOT NULL DEFAULT 1,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS professional_client_notes (
      id TEXT PRIMARY KEY,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      notes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (professional_id, client_id)
    );

    CREATE TABLE IF NOT EXISTS professional_availability (
      id TEXT PRIMARY KEY,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      is_available INTEGER NOT NULL DEFAULT 1,
      UNIQUE (professional_id, day_of_week, start_time)
    );

    CREATE TABLE IF NOT EXISTS professional_availability_blocks (
      id TEXT PRIMARY KEY,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      block_date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      scheduled_at TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
      billing_mode TEXT NOT NULL DEFAULT 'session' CHECK (billing_mode IN ('session', 'per_minute')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      coupon_code TEXT,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'aguardando_pagamento' CHECK (
        status IN ('aguardando_pagamento', 'pagamento_confirmado', 'em_andamento', 'finalizada', 'cancelada', 'expirou')
      ),
      cancellation_reason TEXT,
      is_instant INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_unique_slot
      ON bookings (professional_id, scheduled_at)
      WHERE status NOT IN ('cancelada', 'expirou');

    CREATE TABLE IF NOT EXISTS video_calls (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      room_name TEXT NOT NULL UNIQUE,
      call_status TEXT NOT NULL DEFAULT 'aguardando_pagamento' CHECK (
        call_status IN (
          'aguardando_pagamento', 'pagamento_confirmado', 'aguardando_profissional',
          'aguardando_cliente', 'iniciando', 'em_andamento', 'finalizada',
          'cancelada', 'recusada', 'expirou', 'falha'
        )
      ),
      started_at TEXT,
      ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS call_events (
      id TEXT PRIMARY KEY,
      video_call_id TEXT NOT NULL REFERENCES video_calls(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'mercadopago',
      provider_payment_id TEXT UNIQUE,
      amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'BRL',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'refunded', 'cancelled')),
      payment_method TEXT NOT NULL DEFAULT 'pix',
      paid_at TEXT,
      refunded_at TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS financial_transactions (
      id TEXT PRIMARY KEY,
      payment_id TEXT REFERENCES payments(id) ON DELETE RESTRICT,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
      transaction_type TEXT NOT NULL CHECK (transaction_type IN ('session_credit', 'refund_debit', 'payout_debit', 'adjustment')),
      gross_cents INTEGER NOT NULL,
      platform_fee_cents INTEGER NOT NULL,
      professional_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'BRL',
      status TEXT NOT NULL DEFAULT 'posted',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS professional_balances (
      id TEXT PRIMARY KEY,
      professional_id TEXT NOT NULL UNIQUE REFERENCES professionals(id) ON DELETE CASCADE,
      available_cents INTEGER NOT NULL DEFAULT 0 CHECK (available_cents >= 0),
      pending_cents INTEGER NOT NULL DEFAULT 0 CHECK (pending_cents >= 0),
      paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payout_requests (
      id TEXT PRIMARY KEY,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      payout_method TEXT NOT NULL,
      payout_details TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      paid_at TEXT,
      admin_notes TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'flagged')),
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      professional_id TEXT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (client_id, professional_id)
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed_cents')),
      discount_value INTEGER NOT NULL CHECK (discount_value > 0),
      usage_limit INTEGER,
      usage_count INTEGER NOT NULL DEFAULT 0,
      expiration_date TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL,
      read_at TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      id TEXT PRIMARY KEY,
      setting_key TEXT NOT NULL UNIQUE,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT,
      event_type TEXT NOT NULL,
      resource_id TEXT,
      signature_valid INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL DEFAULT '{}',
      processing_status TEXT NOT NULL DEFAULT 'processed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_gateways (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      environment TEXT NOT NULL DEFAULT 'sandbox' CHECK (environment IN ('sandbox', 'production')),
      supported_methods TEXT NOT NULL DEFAULT '[]',
      supported_currencies TEXT NOT NULL DEFAULT '["BRL"]',
      split_enabled INTEGER NOT NULL DEFAULT 0,
      compliance_verified INTEGER NOT NULL DEFAULT 0,
      compliance_notes TEXT NOT NULL DEFAULT '',
      encrypted_credentials TEXT NOT NULL DEFAULT '{}',
      last_health_status TEXT NOT NULL DEFAULT 'sandbox_ready',
      last_health_message TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  ensureColumn(db, 'payments', 'professional_id', 'TEXT REFERENCES professionals(id) ON DELETE SET NULL');
  ensureColumn(db, 'payments', 'gateway_environment', "TEXT NOT NULL DEFAULT 'sandbox'");
  ensureColumn(db, 'payments', 'gateway_fee_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'payments', 'platform_fee_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'payments', 'professional_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'payments', 'net_received_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'payments', 'confirmed_at', 'TEXT');
  ensureColumn(db, 'payments', 'cancelled_at', 'TEXT');
  ensureColumn(db, 'payments', 'external_capture_id', 'TEXT');
  ensureColumn(db, 'payments', 'idempotency_key', 'TEXT');
  ensureColumn(db, 'payments', 'provider_refund_id', 'TEXT');
  ensureColumn(db, 'payments', 'refund_reason', 'TEXT');
  ensureColumn(db, 'payments', 'checkout_url', 'TEXT');
  ensureColumn(db, 'payments', 'pix_qr_code', 'TEXT');
  ensureColumn(db, 'payments', 'pix_qr_base64', 'TEXT');
  ensureColumn(db, 'payments', 'commission_percentage_applied', 'REAL');
  ensureColumn(db, 'payments', 'failure_reason', 'TEXT');
  ensureColumn(db, 'payments', 'metadata', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'financial_transactions', 'gateway_fee_cents', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'financial_transactions', 'provider', "TEXT NOT NULL DEFAULT 'mercadopago'");
  ensureColumn(db, 'payout_requests', 'external_reference', 'TEXT');
  ensureColumn(db, 'payout_requests', 'transfer_receipt', 'TEXT');

  // Backfill multi-gateway fields for existing payments
  db.exec(`
    UPDATE payments
    SET professional_id = (SELECT b.professional_id FROM bookings b WHERE b.id = payments.booking_id)
    WHERE professional_id IS NULL;

    UPDATE payments
    SET confirmed_at = paid_at
    WHERE confirmed_at IS NULL AND paid_at IS NOT NULL;

    UPDATE payments
    SET provider = 'mercadopago', gateway_environment = 'sandbox'
    WHERE provider = 'mercadopago_sandbox';
  `);

  seedPlatformDefaultsAndDemo(db);
  ensureDefaultGateways(db);
  return db;
}

function ensureColumn(db: Database.Database, table: string, column: string, ddlType: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddlType}`);
  }
}

function ensureDefaultGateways(db: Database.Database) {
  const upsert = db.prepare(
    `INSERT INTO payment_gateways (
      id, display_name, is_enabled, environment, supported_methods, supported_currencies,
      split_enabled, compliance_verified, compliance_notes, last_health_status, last_health_message
    ) VALUES (?, ?, 1, ?, ?, ?, 0, 0, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`
  );

  const hasMpToken = Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN?.trim());
  const mpEnv =
    hasMpToken && !process.env.MERCADOPAGO_ACCESS_TOKEN!.trim().startsWith('TEST-') && process.env.MERCADOPAGO_ENV !== 'sandbox'
      ? 'production'
      : 'sandbox';
  upsert.run(
    'mercadopago',
    'Mercado Pago',
    mpEnv,
    JSON.stringify(['pix', 'credit_card', 'debit_card']),
    JSON.stringify(['BRL']),
    'Verificar elegibilidade de split/marketplace para intermediação de serviços digitais antes da ativação em produção.',
    hasMpToken ? 'configured' : 'sandbox_local',
    hasMpToken ? 'Credenciais carregadas via ambiente do servidor.' : 'Operando em Sandbox Local (configure o Access Token para API Mercado Pago).'
  );

  const hasPpToken = Boolean(process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim());
  const ppEnv = process.env.PAYPAL_ENV?.trim().toLowerCase() === 'production' ? 'production' : 'sandbox';
  upsert.run(
    'paypal',
    'PayPal',
    ppEnv,
    JSON.stringify(['paypal_account', 'credit_card', 'international']),
    JSON.stringify(['BRL', 'USD', 'EUR']),
    'Verificar aprovação PayPal Commerce Platform / Payouts para intermediação de sessões online e repasses em produção.',
    hasPpToken ? 'configured' : 'sandbox_local',
    hasPpToken ? 'Credenciais carregadas via ambiente do servidor.' : 'Operando em Sandbox Local (configure Client ID e Secret para API PayPal).'
  );
}

function seedPlatformDefaultsAndDemo(db: Database.Database) {
  const initialized = db
    .prepare("SELECT setting_value FROM platform_settings WHERE setting_key = 'initialized'")
    .get() as { setting_value: string } | undefined;

  if (initialized) return;

  const upsertSetting = db.prepare(
    `INSERT INTO platform_settings (id, setting_key, setting_value) VALUES (?, ?, ?)
     ON CONFLICT(setting_key) DO NOTHING`
  );

  const defaultSettings: Record<string, unknown> = {
    initialized: true,
    demo_mode_enabled: true,
    platform_name: 'Aurum Privé',
    global_commission_percentage: 30,
    session_billing_enabled: true,
    per_minute_billing_enabled: true,
    min_booking_lead_minutes: 30,
    cancellation_window_hours: 4,
    late_tolerance_minutes: 5,
    reconnect_grace_seconds: 120,
    minimum_payout_cents: 10000,
    timezone: 'America/Sao_Paulo',
  };

  for (const [k, v] of Object.entries(defaultSettings)) {
    upsertSetting.run(crypto.randomUUID(), k, JSON.stringify(v));
  }

  // Seed Demo Data cleanly marked with is_demo = 1 (can be removed with one click in Admin)
  // Demo accounts use a non-loginable marker hash so authentication always goes through /api/auth/demo-login while demo_mode_enabled=true.
  const demoMarkerHash = 'DEMO_ACCOUNT_NO_PASSWORD';

  const insertTx = db.transaction(() => {
    // 1 Demo Admin
    const adminUserId = 'demo-admin-001';
    db.prepare(
      `INSERT INTO profiles (id, full_name, email, password_hash, phone, user_role, status, is_demo)
       VALUES (?, ?, ?, ?, ?, 'admin', 'active', 1)`
    ).run(adminUserId, 'Diretoria Aurum (Demo)', 'admin@aurumprive.demo', demoMarkerHash, '+55 11 99999-0001');
    db.prepare(`INSERT INTO admin_users (user_id, granted_by, is_demo) VALUES (?, ?, 1)`).run(adminUserId, adminUserId);

    // 4 Demo Professionals
    const pros = [
      {
        userId: 'demo-pro-user-001',
        proId: 'demo-pro-001',
        name: 'Camila Alencar',
        slug: 'camila-alencar',
        email: 'camila@aurumprive.demo',
        category: 'Estratégia Executiva',
        languages: ['Português', 'Inglês'],
        image: '/src/assets/images/prof_camila_alencar_1795309181296.jpg',
        bio: 'Ex-diretora de estratégia corporativa com 14 anos assessorando conselhos e fundadores em rodadas de M&A, reestruturação de receita e negociações de alto impacto.',
        priceSession: 42000,
        priceMinute: 1600,
        duration: 30,
        commission: 25,
        status: 'online',
        featured: 1,
      },
      {
        userId: 'demo-pro-user-002',
        proId: 'demo-pro-002',
        name: 'Rafael Monteiro',
        slug: 'rafael-monteiro',
        email: 'rafael@aurumprive.demo',
        category: 'Gestão Patrimonial',
        languages: ['Português', 'Inglês', 'Espanhol'],
        image: '/src/assets/images/prof_rafael_monteiro_1795309181798.jpg',
        bio: 'Especialista em estruturação patrimonial, planejamento sucessório e alocação internacional para famílias empresárias e executivos C-Level.',
        priceSession: 55000,
        priceMinute: 2000,
        duration: 45,
        commission: 30,
        status: 'online',
        featured: 1,
      },
      {
        userId: 'demo-pro-user-003',
        proId: 'demo-pro-003',
        name: 'Helena Vasconcelos',
        slug: 'helena-vasconcelos',
        email: 'helena@aurumprive.demo',
        category: 'Psicologia & Liderança',
        languages: ['Português', 'Francês'],
        image: '/src/assets/images/prof_helena_vasconcelos_1795309180969.jpg',
        bio: 'Psicóloga clínica e mentora executiva dedicada à alta performance emocional, prevenção de burnout e tomada de decisão sob pressão.',
        priceSession: 36000,
        priceMinute: 1400,
        duration: 30,
        commission: 30,
        status: 'busy',
        featured: 1,
      },
      {
        userId: 'demo-pro-user-004',
        proId: 'demo-pro-004',
        name: 'Lucas Ferreira',
        slug: 'lucas-ferreira',
        email: 'lucas@aurumprive.demo',
        category: 'Direito Internacional',
        languages: ['Português', 'Inglês'],
        image: '/src/assets/images/prof_lucas_ferreira_1795309182480.jpg',
        bio: 'Consultor jurídico especializado em contratos internacionais, residência fiscal, compliance e estruturação societária cross-border.',
        priceSession: 48000,
        priceMinute: 1800,
        duration: 30,
        commission: 28,
        status: 'online',
        featured: 1,
      },
    ];

    for (const p of pros) {
      db.prepare(
        `INSERT INTO profiles (id, full_name, email, password_hash, phone, avatar_url, user_role, status, is_demo)
         VALUES (?, ?, ?, ?, '+55 11 98888-0000', ?, 'professional', 'active', 1)`
      ).run(p.userId, p.name, p.email, demoMarkerHash, p.image);

      db.prepare(
        `INSERT INTO professionals (
          id, user_id, professional_name, slug, bio, category, languages, profile_image, gallery,
          price_per_session_cents, price_per_minute_cents, session_duration, commission_percentage,
          availability_status, is_approved, is_featured, instant_call_enabled, is_demo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1)`
      ).run(
        p.proId,
        p.userId,
        p.name,
        p.slug,
        p.bio,
        p.category,
        JSON.stringify(p.languages),
        p.image,
        JSON.stringify([p.image]),
        p.priceSession,
        p.priceMinute,
        p.duration,
        p.commission,
        p.status,
        p.featured
      );

      db.prepare(
        `INSERT INTO professional_balances (id, professional_id, available_cents, pending_cents, paid_cents)
         VALUES (?, ?, 0, 0, 0)`
      ).run(crypto.randomUUID(), p.proId);

      // Mon-Fri 09:00-19:00 availability
      for (const day of [1, 2, 3, 4, 5]) {
        db.prepare(
          `INSERT INTO professional_availability (id, professional_id, day_of_week, start_time, end_time, is_available)
           VALUES (?, ?, ?, '09:00', '19:00', 1)`
        ).run(crypto.randomUUID(), p.proId, day);
      }
    }

    // 5 Demo Clients
    const clients = [
      { userId: 'demo-cli-user-001', clientId: 'demo-cli-001', name: 'Eduardo Siqueira', email: 'eduardo@cliente.demo' },
      { userId: 'demo-cli-user-002', clientId: 'demo-cli-002', name: 'Mariana Costa', email: 'mariana@cliente.demo' },
      { userId: 'demo-cli-user-003', clientId: 'demo-cli-003', name: 'Beatriz Nogueira', email: 'beatriz@cliente.demo' },
      { userId: 'demo-cli-user-004', clientId: 'demo-cli-004', name: 'Gustavo Ribeiro', email: 'gustavo@cliente.demo' },
      { userId: 'demo-cli-user-005', clientId: 'demo-cli-005', name: 'Fernanda Lemos', email: 'fernanda@cliente.demo' },
    ];

    for (const c of clients) {
      db.prepare(
        `INSERT INTO profiles (id, full_name, email, password_hash, phone, user_role, status, is_demo)
         VALUES (?, ?, ?, ?, '+55 11 97777-0000', 'client', 'active', 1)`
      ).run(c.userId, c.name, c.email, demoMarkerHash);
      db.prepare(`INSERT INTO clients (id, user_id, is_demo) VALUES (?, ?, 1)`).run(c.clientId, c.userId);
    }

    // Sample past completed & upcoming bookings + payments + ledger
    const now = Date.now();
    const dayMs = 86400000;
    const sampleSessions = [
      {
        bookingId: 'demo-book-001',
        callId: 'demo-call-001',
        payId: 'demo-pay-001',
        clientId: 'demo-cli-001',
        proId: 'demo-pro-001',
        daysOffset: -6,
        amount: 42000,
        commission: 25,
        status: 'finalizada',
        method: 'pix',
        rating: 5,
        comment: 'Sessão extremamente objetiva e transformadora para nossa reestruturação societária.',
      },
      {
        bookingId: 'demo-book-002',
        callId: 'demo-call-002',
        payId: 'demo-pay-002',
        clientId: 'demo-cli-002',
        proId: 'demo-pro-002',
        daysOffset: -4,
        amount: 55000,
        commission: 30,
        status: 'finalizada',
        method: 'credit_card',
        rating: 5,
        comment: 'Clareza técnica impecável sobre diversificação internacional e holding patrimonial.',
      },
      {
        bookingId: 'demo-book-003',
        callId: 'demo-call-003',
        payId: 'demo-pay-003',
        clientId: 'demo-cli-003',
        proId: 'demo-pro-003',
        daysOffset: -2,
        amount: 36000,
        commission: 30,
        status: 'finalizada',
        method: 'pix',
        rating: 5,
        comment: 'Ambiente seguro, escuta qualificada e direcionamento prático imediato.',
      },
      {
        bookingId: 'demo-book-004',
        callId: 'demo-call-004',
        payId: 'demo-pay-004',
        clientId: 'demo-cli-004',
        proId: 'demo-pro-004',
        daysOffset: -1,
        amount: 48000,
        commission: 28,
        status: 'finalizada',
        method: 'pix',
        rating: 4,
        comment: 'Excelente análise contratual e segurança jurídica nas recomendações.',
      },
      {
        bookingId: 'demo-book-005',
        callId: 'demo-call-005',
        payId: 'demo-pay-005',
        clientId: 'demo-cli-001',
        proId: 'demo-pro-002',
        daysOffset: 1,
        amount: 55000,
        commission: 30,
        status: 'pagamento_confirmado',
        method: 'pix',
        rating: null,
        comment: '',
      },
    ];

    for (const s of sampleSessions) {
      const scheduledIso = new Date(now + s.daysOffset * dayMs).toISOString();
      const feeCents = Math.round((s.amount * s.commission) / 100);
      const proCents = s.amount - feeCents;

      db.prepare(
        `INSERT INTO bookings (id, client_id, professional_id, scheduled_at, duration_minutes, amount_cents, status, is_demo, created_at)
         VALUES (?, ?, ?, ?, 30, ?, ?, 1, ?)`
      ).run(s.bookingId, s.clientId, s.proId, scheduledIso, s.amount, s.status, scheduledIso);

      db.prepare(
        `INSERT INTO video_calls (id, booking_id, client_id, professional_id, room_name, call_status, started_at, ended_at, duration_seconds, amount_cents, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(
        s.callId,
        s.bookingId,
        s.clientId,
        s.proId,
        `aurum-${s.bookingId}`,
        s.status,
        s.status === 'finalizada' ? scheduledIso : null,
        s.status === 'finalizada' ? new Date(new Date(scheduledIso).getTime() + 1800000).toISOString() : null,
        s.status === 'finalizada' ? 1800 : 0,
        s.amount,
        scheduledIso
      );

      db.prepare(
        `INSERT INTO payments (id, client_id, booking_id, provider, provider_payment_id, amount_cents, currency, status, payment_method, paid_at, is_demo, created_at)
         VALUES (?, ?, ?, 'mercadopago_sandbox', ?, ?, 'BRL', 'approved', ?, ?, 1, ?)`
      ).run(s.payId, s.clientId, s.bookingId, `mp-demo-${s.payId}`, s.amount, s.method, scheduledIso, scheduledIso);

      db.prepare(
        `INSERT INTO financial_transactions (id, payment_id, professional_id, client_id, booking_id, transaction_type, gross_cents, platform_fee_cents, professional_cents, currency, status, is_demo, created_at)
         VALUES (?, ?, ?, ?, ?, 'session_credit', ?, ?, ?, 'BRL', 'posted', 1, ?)`
      ).run(crypto.randomUUID(), s.payId, s.proId, s.clientId, s.bookingId, s.amount, feeCents, proCents, scheduledIso);

      if (s.status === 'finalizada') {
        db.prepare(`UPDATE professional_balances SET available_cents = available_cents + ? WHERE professional_id = ?`).run(
          proCents,
          s.proId
        );
      } else {
        db.prepare(`UPDATE professional_balances SET pending_cents = pending_cents + ? WHERE professional_id = ?`).run(
          proCents,
          s.proId
        );
      }

      if (s.rating) {
        db.prepare(
          `INSERT INTO reviews (id, client_id, professional_id, booking_id, rating, comment, status, is_demo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'published', 1, ?)`
        ).run(crypto.randomUUID(), s.clientId, s.proId, s.bookingId, s.rating, s.comment, scheduledIso);
      }
    }

    // Sample Payout Request
    db.prepare(
      `INSERT INTO payout_requests (id, professional_id, amount_cents, payout_method, payout_details, status, is_demo)
       VALUES ('demo-payout-001', 'demo-pro-001', 15000, 'pix', '{"pixKey":"camila@aurumprive.demo"}', 'pending', 1)`
    ).run();

    // Sample Coupons
    db.prepare(
      `INSERT INTO coupons (id, code, discount_type, discount_value, usage_limit, is_active, is_demo)
       VALUES ('demo-coupon-001', 'AURUM15', 'percentage', 15, 100, 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO coupons (id, code, discount_type, discount_value, usage_limit, is_active, is_demo)
       VALUES ('demo-coupon-002', 'BOASVINDAS', 'fixed_cents', 5000, 50, 1, 1)`
    ).run();

    // Sample Notifications
    db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type, is_demo)
       VALUES (?, 'demo-cli-user-001', 'Sessão confirmada', 'Sua videochamada privada com Rafael Monteiro está confirmada e autorizada.', 'payment_confirmed', 1)`
    ).run(crypto.randomUUID());
    db.prepare(
      `INSERT INTO notifications (id, user_id, title, message, type, is_demo)
       VALUES (?, 'demo-pro-user-002', 'Novo agendamento pago', 'Eduardo Siqueira reservou uma sessão de 45 minutos.', 'new_booking', 1)`
    ).run(crypto.randomUUID());

    // Sample Audit Log
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata, is_demo)
       VALUES (?, ?, 'DEMO_SEED_INITIALIZED', 'platform', 'system', '{"note":"Dados de demonstração inicializados"}', 1)`
    ).run(crypto.randomUUID(), adminUserId);
  });

  insertTx();
}
