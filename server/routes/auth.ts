import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  hashPassword,
  verifyPassword,
  signToken,
  createAuthMiddleware,
  logAudit,
  type AuthenticatedRequest,
} from '../security.ts';

const registerSchema = z.object({
  fullName: z.string().min(2, 'Nome completo obrigatório').max(120),
  email: z.string().email('E-mail inválido').max(180),
  password: z.string().min(8, 'A senha deve ter pelo menos 8 caracteres').max(128),
  phone: z.string().max(30).optional().default(''),
});

const loginSchema = z.object({
  email: z.string().email('E-mail inválido'),
  password: z.string().min(1, 'Senha obrigatória'),
});

const bootstrapSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  passcode: z.string().optional().default(''),
});

export function createAuthRouter(db: Database.Database): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);

  function getDemoEnabled(): boolean {
    const row = db
      .prepare("SELECT setting_value FROM platform_settings WHERE setting_key = 'demo_mode_enabled'")
      .get() as { setting_value: string } | undefined;
    return row ? JSON.parse(row.setting_value) === true : false;
  }

  function hasRealAdmin(): boolean {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM admin_users WHERE is_demo = 0').get() as { cnt: number };
    return row.cnt > 0;
  }

  function buildAuthUserResponse(userId: string) {
    const profile = db
      .prepare(
        `SELECT id, full_name, email, phone, avatar_url, user_role, status, is_demo, created_at
         FROM profiles WHERE id = ?`
      )
      .get(userId) as Record<string, unknown> | undefined;

    if (!profile) return null;

    let professional = null;
    let client = null;
    if (profile.user_role === 'professional') {
      professional = db.prepare('SELECT * FROM professionals WHERE user_id = ?').get(userId);
    } else if (profile.user_role === 'client') {
      client = db.prepare('SELECT * FROM clients WHERE user_id = ?').get(userId);
    }

    return { ...profile, professional, client };
  }

  router.get('/setup-status', (_req, res) => {
    const demoModeEnabled = getDemoEnabled();
    const realAdminExists = hasRealAdmin();
    const envPasscodeRequired = Boolean(process.env.ADMIN_BOOTSTRAP_PASSCODE?.trim());
    res.json({
      demoModeEnabled,
      hasRealAdmin: realAdminExists,
      canBootstrapAdmin: !realAdminExists,
      envPasscodeRequired,
    });
  });

  router.post('/register', (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos' });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM profiles WHERE email = ?').get(email);
    if (existing) {
      res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
      return;
    }

    const userId = crypto.randomUUID();
    const clientId = crypto.randomUUID();
    const passwordHash = hashPassword(parsed.data.password);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO profiles (id, full_name, email, password_hash, phone, user_role, status, is_demo)
         VALUES (?, ?, ?, ?, ?, 'client', 'active', 0)`
      ).run(userId, parsed.data.fullName.trim(), email, passwordHash, parsed.data.phone.trim());

      db.prepare(`INSERT INTO clients (id, user_id, is_demo) VALUES (?, ?, 0)`).run(clientId, userId);
      logAudit(db, userId, 'CLIENT_REGISTERED', 'profile', userId, { email });
    });
    tx();

    const token = signToken({ userId, role: 'client', email });
    res.status(201).json({ token, user: buildAuthUserResponse(userId) });
  });

  router.post('/login', (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Credenciais inválidas' });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const user = db
      .prepare('SELECT id, email, password_hash, user_role, status FROM profiles WHERE email = ?')
      .get(email) as
      | { id: string; email: string; password_hash: string; user_role: 'admin' | 'professional' | 'client'; status: string }
      | undefined;

    if (!user || user.password_hash === 'DEMO_ACCOUNT_NO_PASSWORD' || !verifyPassword(parsed.data.password, user.password_hash)) {
      res.status(401).json({ error: 'E-mail ou senha incorretos.' });
      return;
    }

    if (user.status === 'blocked' || user.status === 'suspended') {
      res.status(403).json({ error: 'Esta conta está suspensa ou bloqueada.' });
      return;
    }

    if (user.user_role === 'admin') {
      const adminRec = db.prepare('SELECT user_id FROM admin_users WHERE user_id = ?').get(user.id);
      if (!adminRec) {
        res.status(403).json({ error: 'Permissão administrativa não verificada.' });
        return;
      }
    }

    const token = signToken({ userId: user.id, role: user.user_role, email: user.email });
    logAudit(db, user.id, 'USER_LOGIN', 'profile', user.id, { role: user.user_role });
    res.json({ token, user: buildAuthUserResponse(user.id) });
  });

  router.post('/demo-login', (req, res) => {
    if (!getDemoEnabled()) {
      res.status(403).json({ error: 'O modo de demonstração foi desativado pelo administrador.' });
      return;
    }

    const roleSchema = z.object({ role: z.enum(['admin', 'professional', 'client']) });
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Perfil de demonstração inválido.' });
      return;
    }

    const demoUser = db
      .prepare("SELECT id, email, user_role FROM profiles WHERE user_role = ? AND is_demo = 1 AND status = 'active' LIMIT 1")
      .get(parsed.data.role) as { id: string; email: string; user_role: 'admin' | 'professional' | 'client' } | undefined;

    if (!demoUser) {
      res.status(404).json({ error: 'Conta de demonstração não encontrada.' });
      return;
    }

    const token = signToken({ userId: demoUser.id, role: demoUser.user_role, email: demoUser.email });
    logAudit(db, demoUser.id, 'DEMO_LOGIN', 'profile', demoUser.id, { role: demoUser.user_role }, 1);
    res.json({ token, user: buildAuthUserResponse(demoUser.id) });
  });

  router.post('/bootstrap-admin', (req, res) => {
    if (hasRealAdmin()) {
      res.status(403).json({ error: 'Um administrador principal já foi configurado.' });
      return;
    }

    const parsed = bootstrapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
      return;
    }

    const envPasscode = process.env.ADMIN_BOOTSTRAP_PASSCODE?.trim();
    if (envPasscode) {
      const a = Buffer.from(parsed.data.passcode);
      const b = Buffer.from(envPasscode);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(403).json({ error: 'Código de autorização administrativo inválido.' });
        return;
      }
    }

    const email = parsed.data.email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM profiles WHERE email = ?').get(email);
    if (existing) {
      res.status(409).json({ error: 'Este e-mail já está em uso.' });
      return;
    }

    const userId = crypto.randomUUID();
    const passwordHash = hashPassword(parsed.data.password);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO profiles (id, full_name, email, password_hash, user_role, status, is_demo)
         VALUES (?, ?, ?, ?, 'admin', 'active', 0)`
      ).run(userId, parsed.data.fullName.trim(), email, passwordHash);
      db.prepare(`INSERT INTO admin_users (user_id, granted_by, is_demo) VALUES (?, ?, 0)`).run(userId, userId);
      logAudit(db, userId, 'ADMIN_BOOTSTRAPPED', 'profile', userId, { email });
    });
    tx();

    const token = signToken({ userId, role: 'admin', email });
    res.status(201).json({ token, user: buildAuthUserResponse(userId) });
  });

  router.post('/forgot-password', (req, res) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Informe um e-mail válido.' });
      return;
    }
    logAudit(db, null, 'PASSWORD_RESET_REQUESTED', 'profile', null, { email: parsed.data.email.toLowerCase() });
    res.json({
      message: 'Se o e-mail estiver cadastrado, as instruções de recuperação foram enviadas com segurança.',
    });
  });

  router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
    const user = buildAuthUserResponse(req.auth!.userId);
    if (!user) {
      res.status(404).json({ error: 'Usuário não encontrado.' });
      return;
    }
    res.json({ user });
  });

  router.patch('/profile', requireAuth, (req: AuthenticatedRequest, res) => {
    const schema = z.object({
      fullName: z.string().min(2).max(120),
      phone: z.string().max(30).optional().default(''),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Dados inválidos.' });
      return;
    }

    db.prepare(
      `UPDATE profiles SET full_name = ?, phone = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(parsed.data.fullName.trim(), parsed.data.phone.trim(), req.auth!.userId);

    logAudit(db, req.auth!.userId, 'PROFILE_UPDATED', 'profile', req.auth!.userId);
    res.json({ user: buildAuthUserResponse(req.auth!.userId) });
  });

  return router;
}
