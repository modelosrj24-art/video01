import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';

// Ephemeral in-memory fallback if SESSION_SECRET env var is not configured
const EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');

function getSessionSecret(): string {
  return process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16
    ? process.env.SESSION_SECRET.trim()
    : EPHEMERAL_SECRET;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== keyBuf.length) return false;
  return crypto.timingSafeEqual(derived, keyBuf);
}

export interface SessionPayload {
  userId: string;
  role: 'admin' | 'professional' | 'client';
  email: string;
  exp: number;
}

export function signToken(payload: Omit<SessionPayload, 'exp'>, ttlSeconds = 60 * 60 * 12): string {
  const fullPayload: SessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyToken(token: string): SessionPayload | null {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function signRoomToken(payload: { callId: string; userId: string; role: string; exp: number }): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(`room:${encoded}`).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyRoomToken(token: string): { callId: string; userId: string; role: string; exp: number } | null {
  if (!token || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(`room:${encoded}`).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function signSandboxWebhook(paymentId: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(`sandbox-webhook:${paymentId}`).digest('hex');
}

export function verifySandboxWebhook(paymentId: string, signature: string): boolean {
  const expected = signSandboxWebhook(paymentId);
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface AuthenticatedRequest extends Request {
  auth?: SessionPayload;
}

export function createAuthMiddleware(db: Database.Database) {
  return function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Autenticação necessária.' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Sessão inválida ou expirada.' });
      return;
    }

    const user = db.prepare('SELECT id, user_role, status FROM profiles WHERE id = ?').get(payload.userId) as
      | { id: string; user_role: 'admin' | 'professional' | 'client'; status: string }
      | undefined;

    if (!user || user.status === 'blocked' || user.status === 'suspended') {
      res.status(403).json({ error: 'Conta indisponível ou bloqueada.' });
      return;
    }

    // Double check admin privilege against dedicated admin_users table
    if (user.user_role === 'admin') {
      const adminRecord = db.prepare('SELECT user_id FROM admin_users WHERE user_id = ?').get(user.id);
      if (!adminRecord) {
        res.status(403).json({ error: 'Privilégio administrativo não autorizado.' });
        return;
      }
    }

    req.auth = { ...payload, role: user.user_role };
    next();
  };
}

export function requireRole(...roles: Array<'admin' | 'professional' | 'client'>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'Acesso negado para este perfil.' });
      return;
    }
    next();
  };
}

export function logAudit(
  db: Database.Database,
  actorUserId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
  isDemo = 0
) {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, entity_type, entity_id, metadata, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), actorUserId, action, entityType, entityId, JSON.stringify(metadata), isDemo);
}
