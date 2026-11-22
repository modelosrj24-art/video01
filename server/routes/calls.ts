import { Router } from 'express';
import crypto from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import type Database from 'better-sqlite3';
import { createAuthMiddleware, signRoomToken, logAudit, type AuthenticatedRequest } from '../security.ts';
import type { RealtimeHub } from '../ws.ts';
import { verifyCallFinancialAuthorization, processGatewayRefund } from '../payments/ledger-service.ts';

export function createCallsRouter(db: Database.Database, hub: RealtimeHub): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth);

  type CallAccessResult =
    | { ok: false; error: string; status: 403 | 404 }
    | { ok: true; call: Record<string, unknown>; isClient: boolean; isProfessional: boolean; isAdmin: boolean };

  function loadAuthorizedCall(callId: string, userId: string, userRole: string): CallAccessResult {
    const call = db
      .prepare(
        `SELECT vc.*,
                b.duration_minutes, b.billing_mode, b.scheduled_at, b.is_instant,
                pr.user_id AS pro_user_id, pr.professional_name, pr.profile_image AS pro_image, pr.commission_percentage,
                c.user_id AS client_user_id, cp.full_name AS client_name
         FROM video_calls vc
         JOIN bookings b ON b.id = vc.booking_id
         JOIN professionals pr ON pr.id = vc.professional_id
         JOIN clients c ON c.id = vc.client_id
         JOIN profiles cp ON cp.id = c.user_id
         WHERE vc.id = ?`
      )
      .get(callId) as Record<string, unknown> | undefined;

    if (!call) return { ok: false, error: 'Sala de videochamada não encontrada.', status: 404 };

    const isClient = call.client_user_id === userId;
    const isProfessional = call.pro_user_id === userId;
    const isAdmin = userRole === 'admin';

    if (!isClient && !isProfessional && !isAdmin) {
      return { ok: false, error: 'Acesso negado: você não é participante autorizado desta sala privada.', status: 403 };
    }

    return { ok: true, call, isClient, isProfessional, isAdmin };
  }

  function getSettingNumber(key: string, fallback: number): number {
    const row = db.prepare('SELECT setting_value FROM platform_settings WHERE setting_key = ?').get(key) as
      | { setting_value: string }
      | undefined;
    if (!row) return fallback;
    try {
      const parsed = Number(JSON.parse(row.setting_value));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function computeRemainingSeconds(call: Record<string, unknown>): {
    contractedSeconds: number;
    elapsedSeconds: number;
    remainingSeconds: number;
  } {
    const contractedSeconds = Math.max(60, Number(call.duration_minutes || 30) * 60);
    if (!call.started_at) {
      return { contractedSeconds, elapsedSeconds: 0, remainingSeconds: contractedSeconds };
    }
    const startedMs = new Date(String(call.started_at)).getTime();
    if (Number.isNaN(startedMs)) {
      return { contractedSeconds, elapsedSeconds: 0, remainingSeconds: contractedSeconds };
    }
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
    const remainingSeconds = Math.max(0, contractedSeconds - elapsedSeconds);
    return { contractedSeconds, elapsedSeconds, remainingSeconds };
  }

  function recordCallEvent(
    videoCallId: string,
    userId: string | null,
    eventType: string,
    metadata: Record<string, unknown> = {}
  ) {
    db.prepare(
      `INSERT INTO call_events (id, video_call_id, user_id, event_type, metadata)
       VALUES (?, ?, ?, ?, ?)`
    ).run(crypto.randomUUID(), videoCallId, userId, eventType, JSON.stringify(metadata));
  }

  function finalizeCallAtomically(
    call: Record<string, unknown>,
    actorUserId: string,
    reason: 'ended_by_participant' | 'duration_expired'
  ): number {
    if (call.call_status === 'finalizada') {
      return Number(call.duration_seconds || 0);
    }

    const contractedSeconds = Math.max(60, Number(call.duration_minutes || 30) * 60);
    const startedMs = call.started_at ? new Date(String(call.started_at)).getTime() : Date.now();
    const rawElapsed = Math.max(1, Math.floor((Date.now() - startedMs) / 1000));
    const durationSeconds = Math.min(contractedSeconds, rawElapsed);

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE video_calls
         SET call_status = 'finalizada', ended_at = datetime('now'), duration_seconds = ?
         WHERE id = ?`
      ).run(durationSeconds, call.id);

      db.prepare(`UPDATE bookings SET status = 'finalizada', updated_at = datetime('now') WHERE id = ?`).run(
        call.booking_id
      );

      const ledger = db
        .prepare("SELECT professional_cents FROM financial_transactions WHERE booking_id = ? AND transaction_type = 'session_credit'")
        .get(call.booking_id) as { professional_cents: number } | undefined;

      if (ledger && ledger.professional_cents > 0) {
        db.prepare(
          `UPDATE professional_balances
           SET pending_cents = MAX(0, pending_cents - ?),
               available_cents = available_cents + ?,
               updated_at = datetime('now')
           WHERE professional_id = ?`
        ).run(ledger.professional_cents, ledger.professional_cents, call.professional_id);
      }

      recordCallEvent(String(call.id), actorUserId, reason === 'duration_expired' ? 'duration_expired' : 'ended', {
        durationSeconds,
        reason,
      });

      logAudit(db, actorUserId, 'CALL_ENDED', 'video_call', String(call.id), { durationSeconds, reason });
    });
    tx();

    hub.notifyUser(String(call.client_user_id), { type: 'call:status', data: { callId: call.id, status: 'finalizada' } });
    hub.notifyUser(String(call.pro_user_id), { type: 'call:status', data: { callId: call.id, status: 'finalizada' } });
    hub.closeRoom(String(call.id), reason);

    return durationSeconds;
  }

  function buildIceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
    const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    const turnUrl = process.env.WEBRTC_TURN_URL?.trim();
    const turnUser = process.env.WEBRTC_TURN_USERNAME?.trim();
    const turnCred = process.env.WEBRTC_TURN_CREDENTIAL?.trim();
    if (turnUrl && turnUser && turnCred) {
      servers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
    }
    return servers;
  }

  router.get('/:id', (req: AuthenticatedRequest, res) => {
    const access = loadAuthorizedCall(req.params.id, req.auth!.userId, req.auth!.role);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const timing = computeRemainingSeconds(access.call);
    const reconnectGraceSeconds = getSettingNumber('reconnect_grace_seconds', 120);
    const events = db
      .prepare('SELECT id, event_type, metadata, created_at FROM call_events WHERE video_call_id = ? ORDER BY created_at DESC LIMIT 30')
      .all(access.call.id);

    res.json({
      call: access.call,
      participantRole: access.isProfessional ? 'professional' : access.isClient ? 'client' : 'admin',
      contractedDurationSeconds: timing.contractedSeconds,
      remainingSeconds: timing.remainingSeconds,
      reconnectGraceSeconds,
      events,
    });
  });

  router.get('/:id/logs', (req: AuthenticatedRequest, res) => {
    const access = loadAuthorizedCall(req.params.id, req.auth!.userId, req.auth!.role);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    const events = db
      .prepare(
        `SELECT ce.id, ce.event_type, ce.metadata, ce.created_at, p.full_name AS actor_name
         FROM call_events ce
         LEFT JOIN profiles p ON p.id = ce.user_id
         WHERE ce.video_call_id = ?
         ORDER BY ce.created_at DESC`
      )
      .all(access.call.id);

    res.json({ events });
  });

  router.post('/:id/token', async (req: AuthenticatedRequest, res) => {
    const access = loadAuthorizedCall(req.params.id, req.auth!.userId, req.auth!.role);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    if (access.isAdmin) {
      res.status(403).json({ error: 'Administradores auditam metadados, mas não ingressam em salas privadas 1:1.' });
      return;
    }

    const { call } = access;
    const allowedStatuses = [
      'pagamento_confirmado',
      'aguardando_profissional',
      'aguardando_cliente',
      'iniciando',
      'em_andamento',
    ];
    if (!allowedStatuses.includes(String(call.call_status))) {
      res.status(403).json({ error: `Sala bloqueada. Status atual: ${call.call_status}` });
      return;
    }

    const authCheck = verifyCallFinancialAuthorization(db, String(call.id));
    if (!authCheck.authorized) {
      res.status(403).json({ error: authCheck.reason });
      return;
    }

    const timing = computeRemainingSeconds(call);
    if (call.started_at && timing.remainingSeconds <= 0) {
      finalizeCallAtomically(call, req.auth!.userId, 'duration_expired');
      res.status(403).json({ error: 'O tempo contratado desta sessão já foi encerrado.' });
      return;
    }

    const ttlSeconds = Math.max(300, timing.remainingSeconds + 300);
    const roomToken = signRoomToken({
      callId: String(call.id),
      userId: req.auth!.userId,
      role: access.isProfessional ? 'professional' : 'client',
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    });

    // LiveKit server credentials stay strictly in server process.env and never leave the backend
    const lkUrl = process.env.LIVEKIT_URL?.trim();
    const lkKey = process.env.LIVEKIT_API_KEY?.trim();
    const lkSecret = process.env.LIVEKIT_API_SECRET?.trim();

    let livekitToken: string | null = null;
    if (lkUrl && lkKey && lkSecret) {
      const at = new AccessToken(lkKey, lkSecret, {
        identity: req.auth!.userId,
        name: access.isProfessional ? String(call.professional_name) : String(call.client_name),
        metadata: JSON.stringify({ role: access.isProfessional ? 'professional' : 'client', callId: call.id }),
        ttl: ttlSeconds,
      });
      at.addGrant({
        roomJoin: true,
        room: String(call.room_name),
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
      livekitToken = await at.toJwt();
    }

    const provider = livekitToken ? 'livekit' : 'webrtc_ws';
    recordCallEvent(String(call.id), req.auth!.userId, 'token_issued', {
      provider,
      role: access.isProfessional ? 'professional' : 'client',
    });
    logAudit(db, req.auth!.userId, 'CALL_ROOM_TOKEN_ISSUED', 'video_call', String(call.id), { provider });

    res.json({
      roomName: call.room_name,
      roomToken,
      provider,
      livekit: livekitToken ? { url: lkUrl, token: livekitToken } : null,
      iceServers: buildIceServers(),
      contractedDurationSeconds: timing.contractedSeconds,
      remainingSeconds: timing.remainingSeconds,
      reconnectGraceSeconds: getSettingNumber('reconnect_grace_seconds', 120),
    });
  });

  router.post('/:id/state', (req: AuthenticatedRequest, res) => {
    const access = loadAuthorizedCall(req.params.id, req.auth!.userId, req.auth!.role);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }

    if (access.isAdmin) {
      res.status(403).json({ error: 'Use o painel administrativo para gerenciar encerramentos administrativos.' });
      return;
    }

    const { call, isProfessional } = access;
    const action = String(req.body?.action || '');

    if (action === 'accept' && isProfessional) {
      const authCheck = verifyCallFinancialAuthorization(db, String(call.id));
      if (!authCheck.authorized) {
        res.status(403).json({ error: authCheck.reason });
        return;
      }
      db.prepare(`UPDATE video_calls SET call_status = 'aguardando_cliente' WHERE id = ?`).run(call.id);
      recordCallEvent(String(call.id), req.auth!.userId, 'accepted_by_professional');
      hub.notifyUser(String(call.client_user_id), {
        type: 'call:status',
        data: { callId: call.id, status: 'aguardando_cliente', message: `${call.professional_name} aceitou sua chamada.` },
      });
      res.json({ ok: true, call_status: 'aguardando_cliente' });
      return;
    }

    if (action === 'decline' && isProfessional) {
      db.prepare(`UPDATE video_calls SET call_status = 'recusada', ended_at = datetime('now') WHERE id = ?`).run(call.id);
      db.prepare(`UPDATE bookings SET status = 'cancelada', cancellation_reason = 'Recusada pelo profissional' WHERE id = ?`).run(
        call.booking_id
      );
      recordCallEvent(String(call.id), req.auth!.userId, 'declined_by_professional');
      const approvedPay = db
        .prepare("SELECT id FROM payments WHERE booking_id = ? AND status = 'approved' LIMIT 1")
        .get(call.booking_id) as { id: string } | undefined;
      if (approvedPay) {
        void processGatewayRefund(db, hub, {
          paymentId: approvedPay.id,
          actorUserId: req.auth!.userId,
          reason: 'Estorno automático: profissional recusou a chamada imediata',
        }).catch(() => {});
      }
      hub.notifyUser(String(call.client_user_id), {
        type: 'call:status',
        data: { callId: call.id, status: 'recusada' },
      });
      res.json({ ok: true, call_status: 'recusada', refunded: Boolean(approvedPay) });
      return;
    }

    if (action === 'start') {
      if (['finalizada', 'cancelada', 'recusada', 'expirou'].includes(String(call.call_status))) {
        res.status(409).json({ error: 'Chamada já encerrada.' });
        return;
      }

      const authCheck = verifyCallFinancialAuthorization(db, String(call.id));
      if (!authCheck.authorized) {
        res.status(403).json({ error: authCheck.reason });
        return;
      }

      // Preserve original started_at so reconnecting never resets the contracted timer
      const startedAt = call.started_at ? String(call.started_at) : new Date().toISOString();
      const wasAlreadyStarted = Boolean(call.started_at);

      db.prepare(`UPDATE video_calls SET call_status = 'em_andamento', started_at = ? WHERE id = ?`).run(startedAt, call.id);
      db.prepare(`UPDATE bookings SET status = 'em_andamento' WHERE id = ?`).run(call.booking_id);

      recordCallEvent(
        String(call.id),
        req.auth!.userId,
        wasAlreadyStarted ? 'rejoined' : 'started',
        { role: isProfessional ? 'professional' : 'client' }
      );
      if (!wasAlreadyStarted) {
        logAudit(db, req.auth!.userId, 'CALL_STARTED', 'video_call', String(call.id), { startedAt });
      }

      const timing = computeRemainingSeconds({ ...call, started_at: startedAt });
      res.json({
        ok: true,
        call_status: 'em_andamento',
        started_at: startedAt,
        remainingSeconds: timing.remainingSeconds,
        contractedDurationSeconds: timing.contractedSeconds,
      });
      return;
    }

    if (action === 'reconnect') {
      if (['finalizada', 'cancelada', 'recusada', 'expirou'].includes(String(call.call_status))) {
        res.json({ ok: false, call_status: call.call_status, remainingSeconds: 0 });
        return;
      }
      const timing = computeRemainingSeconds(call);
      if (call.started_at && timing.remainingSeconds <= 0) {
        const durationSeconds = finalizeCallAtomically(call, req.auth!.userId, 'duration_expired');
        res.json({ ok: true, call_status: 'finalizada', duration_seconds: durationSeconds, remainingSeconds: 0 });
        return;
      }
      recordCallEvent(String(call.id), req.auth!.userId, 'reconnected', {
        remainingSeconds: timing.remainingSeconds,
      });
      logAudit(db, req.auth!.userId, 'CALL_RECONNECTED', 'video_call', String(call.id), {
        remainingSeconds: timing.remainingSeconds,
      });
      res.json({
        ok: true,
        call_status: call.call_status,
        remainingSeconds: timing.remainingSeconds,
        contractedDurationSeconds: timing.contractedSeconds,
      });
      return;
    }

    if (action === 'heartbeat') {
      if (call.call_status === 'finalizada') {
        res.json({ ok: true, call_status: 'finalizada', remainingSeconds: 0 });
        return;
      }
      const timing = computeRemainingSeconds(call);
      if (call.started_at && timing.remainingSeconds <= 0) {
        const durationSeconds = finalizeCallAtomically(call, req.auth!.userId, 'duration_expired');
        res.json({ ok: true, call_status: 'finalizada', duration_seconds: durationSeconds, remainingSeconds: 0 });
        return;
      }
      res.json({
        ok: true,
        call_status: call.call_status,
        remainingSeconds: timing.remainingSeconds,
        elapsedSeconds: timing.elapsedSeconds,
      });
      return;
    }

    if (action === 'end') {
      const reason = req.body?.reason === 'duration_expired' ? 'duration_expired' : 'ended_by_participant';
      const durationSeconds = finalizeCallAtomically(call, req.auth!.userId, reason);
      res.json({ ok: true, call_status: 'finalizada', duration_seconds: durationSeconds, remainingSeconds: 0 });
      return;
    }

    res.status(400).json({ error: 'Ação de chamada inválida.' });
  });

  return router;
}
