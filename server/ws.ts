import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import type { Server } from 'http';
import type Database from 'better-sqlite3';
import { verifyToken, verifyRoomToken } from './security.ts';

interface ClientSocket extends WebSocket {
  userId?: string;
  role?: string;
  roomId?: string;
  displayName?: string;
}

export class RealtimeHub {
  private wss: WebSocketServer;
  private db: Database.Database;
  private userSockets = new Map<string, Set<ClientSocket>>();
  private roomSockets = new Map<string, Set<ClientSocket>>();

  constructor(server: Server, db: Database.Database) {
    this.db = db;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: ClientSocket, req) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const authToken = url.searchParams.get('token');
      const roomToken = url.searchParams.get('roomToken');

      if (roomToken) {
        const roomPayload = verifyRoomToken(roomToken);
        if (!roomPayload) {
          ws.close(4001, 'Token de sala inválido ou expirado');
          return;
        }

        // Verify participant belongs to this exclusive call and call is active
        const callRecord = db
          .prepare(
            `SELECT vc.id, vc.call_status, pr.user_id AS pro_user_id, c.user_id AS client_user_id
             FROM video_calls vc
             JOIN professionals pr ON pr.id = vc.professional_id
             JOIN clients c ON c.id = vc.client_id
             WHERE vc.id = ?`
          )
          .get(roomPayload.callId) as
          | { id: string; call_status: string; pro_user_id: string; client_user_id: string }
          | undefined;

        if (
          !callRecord ||
          (callRecord.pro_user_id !== roomPayload.userId && callRecord.client_user_id !== roomPayload.userId)
        ) {
          ws.close(4003, 'Participante não autorizado para esta sala privada');
          return;
        }

        if (['finalizada', 'cancelada', 'recusada', 'expirou'].includes(callRecord.call_status)) {
          ws.close(4004, 'Esta videochamada já foi encerrada');
          return;
        }

        const profile = db.prepare('SELECT full_name FROM profiles WHERE id = ?').get(roomPayload.userId) as
          | { full_name: string }
          | undefined;

        ws.userId = roomPayload.userId;
        ws.role = roomPayload.role;
        ws.roomId = roomPayload.callId;
        ws.displayName = profile?.full_name || 'Participante';

        const joined = this.joinRoom(ws, roomPayload.callId);
        if (!joined) {
          ws.close(4003, 'Sala exclusiva lotada (máximo 2 participantes)');
          return;
        }

        this.recordCallEvent(roomPayload.callId, roomPayload.userId, 'joined', { role: roomPayload.role });
      } else if (authToken) {
        const userPayload = verifyToken(authToken);
        if (!userPayload) {
          ws.close(4001, 'Sessão inválida');
          return;
        }
        ws.userId = userPayload.userId;
        ws.role = userPayload.role;
        this.registerUserSocket(ws, userPayload.userId);
      } else {
        ws.close(4001, 'Autenticação exigida');
        return;
      }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(ws, msg);
        } catch {
          // Ignore malformed JSON frames
        }
      });

      ws.on('close', () => {
        if (ws.userId) {
          this.userSockets.get(ws.userId)?.delete(ws);
        }
        if (ws.roomId) {
          const room = this.roomSockets.get(ws.roomId);
          if (room) {
            room.delete(ws);
            this.recordCallEvent(ws.roomId, ws.userId || null, 'peer_disconnected', { role: ws.role });
            this.broadcastRoom(ws.roomId, {
              type: 'room:peer-left',
              userId: ws.userId,
              displayName: ws.displayName,
              participantCount: room.size,
              participants: Array.from(room).map((s) => ({
                userId: s.userId,
                role: s.role,
                displayName: s.displayName,
              })),
            });
          }
        }
      });
    });
  }

  private recordCallEvent(videoCallId: string, userId: string | null, eventType: string, metadata: Record<string, unknown> = {}) {
    try {
      this.db
        .prepare(
          `INSERT INTO call_events (id, video_call_id, user_id, event_type, metadata)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(crypto.randomUUID(), videoCallId, userId, eventType, JSON.stringify(metadata));
    } catch {
      // Non-fatal if call row removed
    }
  }

  private registerUserSocket(ws: ClientSocket, userId: string) {
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(ws);
  }

  private joinRoom(ws: ClientSocket, roomId: string): boolean {
    if (!this.roomSockets.has(roomId)) {
      this.roomSockets.set(roomId, new Set());
    }
    const room = this.roomSockets.get(roomId)!;
    // Evict stale socket from the exact same userId on reconnect
    for (const existing of room) {
      if (existing.userId === ws.userId && existing !== ws) {
        existing.roomId = undefined; // prevent close handler from triggering peer-left
        existing.close(4002, 'Reconectado em outra sessão');
        room.delete(existing);
      }
    }

    // Enforce exclusive 1:1 room cap (at most 2 distinct users)
    if (room.size >= 2) {
      return false;
    }

    room.add(ws);

    const peers = Array.from(room).map((s) => ({
      userId: s.userId,
      role: s.role,
      displayName: s.displayName,
    }));

    this.broadcastRoom(roomId, {
      type: 'room:presence',
      participants: peers,
      participantCount: room.size,
    });
    return true;
  }

  private handleMessage(ws: ClientSocket, msg: { type: string; payload?: unknown }) {
    if (!ws.roomId) return;
    if (
      msg.type === 'webrtc:offer' ||
      msg.type === 'webrtc:answer' ||
      msg.type === 'webrtc:ice-candidate' ||
      msg.type === 'webrtc:renegotiate' ||
      msg.type === 'room:media-state' ||
      msg.type === 'room:chat-ping' ||
      msg.type === 'call:ended'
    ) {
      this.broadcastRoom(
        ws.roomId,
        {
          type: msg.type,
          fromUserId: ws.userId,
          fromRole: ws.role,
          fromName: ws.displayName,
          payload: msg.payload,
        },
        ws
      );
    }
  }

  private broadcastRoom(roomId: string, data: unknown, exclude?: ClientSocket) {
    const room = this.roomSockets.get(roomId);
    if (!room) return;
    const serialized = JSON.stringify(data);
    for (const client of room) {
      if (client !== exclude && client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  public closeRoom(roomId: string, reason = 'ended') {
    const room = this.roomSockets.get(roomId);
    if (!room) return;
    this.broadcastRoom(roomId, { type: 'call:ended', reason });
    for (const client of room) {
      client.roomId = undefined;
      if (client.readyState === WebSocket.OPEN) {
        client.close(1000, 'Chamada finalizada');
      }
    }
    this.roomSockets.delete(roomId);
  }

  public notifyUser(userId: string, event: { type: string; data: unknown }) {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    const serialized = JSON.stringify(event);
    for (const client of sockets) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }
}
