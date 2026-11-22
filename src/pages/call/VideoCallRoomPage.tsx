import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  Clock,
  Mic,
  MicOff,
  PhoneOff,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Video,
  VideoOff,
} from 'lucide-react';
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
  type LocalTrack,
  type RemoteTrack,
} from 'livekit-client';
import { apiFetch } from '../../lib/api';
import { formatDurationSeconds } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';

interface CallMetadata {
  id: string;
  booking_id: string;
  room_name: string;
  call_status: string;
  duration_minutes: number;
  duration_seconds?: number | null;
  started_at: string | null;
  ended_at?: string | null;
  professional_name: string;
  client_name: string;
  pro_image: string | null;
}

interface CallEventLog {
  id: string;
  event_type: string;
  metadata: string;
  created_at: string;
  actor_name?: string | null;
}

interface TokenResponse {
  roomName: string;
  roomToken: string;
  provider: 'livekit' | 'webrtc_ws';
  livekit: { url: string; token: string } | null;
  iceServers: RTCIceServer[];
  contractedDurationSeconds: number;
  remainingSeconds: number;
  reconnectGraceSeconds: number;
}

type ConnStatus = 'conectando' | 'aguardando_par' | 'conectado' | 'reconectando' | 'finalizada';

const EVENT_LABELS: Record<string, string> = {
  token_issued: 'Token de sala emitido',
  joined: 'Participante ingressou na sala',
  started: 'Sessão iniciada',
  rejoined: 'Retorno à sessão ativa',
  reconnected: 'Reconexão executada',
  peer_disconnected: 'Participante desconectado',
  ended: 'Chamada encerrada',
  duration_expired: 'Tempo contratado esgotado',
  accepted_by_professional: 'Aceita pelo profissional',
  declined_by_professional: 'Recusada pelo profissional',
};

export function VideoCallRoomPage() {
  const { callId } = useParams<{ callId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [call, setCall] = useState<CallMetadata | null>(null);
  const [participantRole, setParticipantRole] = useState<'client' | 'professional'>('client');
  const [providerMode, setProviderMode] = useState<'livekit' | 'webrtc_ws'>('webrtc_ws');
  const [error, setError] = useState('');
  const [hardwareWarning, setHardwareWarning] = useState('');
  const [loading, setLoading] = useState(true);

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [remoteMicOn, setRemoteMicOn] = useState(true);
  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const [connState, setConnState] = useState<ConnStatus>('conectando');
  const [peerPresent, setPeerPresent] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);

  // Device selection
  const [showDevices, setShowDevices] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState('');
  const [selectedVideoId, setSelectedVideoId] = useState('');

  // Call logs & post-call review
  const [callEvents, setCallEvents] = useState<CallEventLog[]>([]);
  const [showReview, setShowReview] = useState(false);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [reviewSaved, setReviewSaved] = useState(false);

  // DOM & connection refs
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const localLivekitTracksRef = useRef<LocalTrack[]>([]);
  const livekitRoomRef = useRef<Room | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const endingRef = useRef(false);
  const mountedRef = useRef(true);
  const autoReconnectAttemptRef = useRef(0);
  const reconnectFnRef = useRef<(() => Promise<void>) | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!mountedRef.current) return;
      setAudioInputs(devices.filter((d) => d.kind === 'audioinput'));
      setVideoInputs(devices.filter((d) => d.kind === 'videoinput'));
    } catch {
      // Ignore enumerate failure when blocked
    }
  }, []);

  const cleanupMediaAndSockets = useCallback(() => {
    // Stop WebRTC P2P stream
    localStreamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
    localStreamRef.current = null;

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    // Stop LiveKit local tracks & disconnect room
    localLivekitTracksRef.current.forEach((track) => {
      try {
        track.detach();
        track.stop();
      } catch {
        // ignore
      }
    });
    localLivekitTracksRef.current = [];

    if (livekitRoomRef.current) {
      try {
        livekitRoomRef.current.disconnect(true);
      } catch {
        // ignore
      }
      livekitRoomRef.current = null;
    }

    // Close PeerConnection
    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
    pendingIceRef.current = [];

    // Close WebSocket
    if (wsRef.current) {
      try {
        wsRef.current.onclose = null;
        wsRef.current.onmessage = null;
        wsRef.current.close(1000, 'Encerrando conexão local');
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
  }, []);

  const loadLogs = useCallback(async () => {
    if (!callId) return;
    try {
      const res = await apiFetch<{ events: CallEventLog[] }>(`/api/calls/${callId}/logs`);
      if (mountedRef.current) setCallEvents(res.events || []);
    } catch {
      // Non-fatal
    }
  }, [callId]);

  const handleFinalizeLocally = useCallback(
    async (role: 'client' | 'professional') => {
      endingRef.current = true;
      cleanupMediaAndSockets();
      if (!mountedRef.current) return;
      setConnState('finalizada');
      setPeerPresent(false);
      await loadLogs();
      if (role === 'client') setShowReview(true);
    },
    [cleanupMediaAndSockets, loadLogs]
  );

  const acquireLocalStream = useCallback(
    async (audioDeviceId?: string, videoDeviceId?: string): Promise<MediaStream | null> => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setHardwareWarning('Este navegador não oferece suporte a câmera/microfone WebRTC neste contexto.');
        return null;
      }

      const audioConstraint: boolean | MediaTrackConstraints = audioDeviceId
        ? { deviceId: { exact: audioDeviceId }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true };
      const videoConstraint: boolean | MediaTrackConstraints = videoDeviceId
        ? { deviceId: { exact: videoDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } };

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraint,
          audio: audioConstraint,
        });
        setHardwareWarning('');
        setCamOn(true);
        setMicOn(true);
        await refreshDevices();
        return stream;
      } catch {
        // Fallback to real microphone only if camera is unavailable/denied
        try {
          const audioOnly = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: audioConstraint,
          });
          setHardwareWarning('Câmera indisponível ou bloqueada pelo navegador. Transmitindo apenas áudio real.');
          setCamOn(false);
          setMicOn(true);
          await refreshDevices();
          return audioOnly;
        } catch {
          setHardwareWarning(
            'Permissão de câmera e microfone negada ou dispositivo ausente. Autorize o acesso no navegador e clique em reconectar.'
          );
          setCamOn(false);
          setMicOn(false);
          return null;
        }
      }
    },
    [refreshDevices]
  );

  const connectSession = useCallback(
    async (isReconnect = false) => {
      if (!callId || !user || endingRef.current) return;

      if (isReconnect) {
        setReconnecting(true);
        setConnState('reconectando');
        cleanupMediaAndSockets();
      } else {
        setLoading(true);
        setError('');
      }

      try {
        const info = await apiFetch<{
          call: CallMetadata;
          participantRole: 'client' | 'professional' | 'admin';
          remainingSeconds: number;
          events?: CallEventLog[];
        }>(`/api/calls/${callId}`);

        if (!mountedRef.current) return;

        if (info.participantRole === 'admin') {
          setError('Administradores não ingressam em salas privadas 1:1.');
          setLoading(false);
          setReconnecting(false);
          return;
        }

        const role = info.participantRole;
        setCall(info.call);
        setParticipantRole(role);
        setRemainingSeconds(info.remainingSeconds);
        if (info.events) setCallEvents(info.events);

        // If call already finished, render post-call summary without requesting room token
        if (['finalizada', 'cancelada', 'recusada', 'expirou'].includes(info.call.call_status)) {
          await handleFinalizeLocally(role);
          setLoading(false);
          setReconnecting(false);
          return;
        }

        if (isReconnect) {
          const recRes = await apiFetch<{ ok: boolean; call_status: string; remainingSeconds: number }>(
            `/api/calls/${callId}/state`,
            {
              method: 'POST',
              body: JSON.stringify({ action: 'reconnect' }),
            }
          );
          if (!mountedRef.current) return;
          setRemainingSeconds(recRes.remainingSeconds);
          if (recRes.call_status === 'finalizada') {
            await handleFinalizeLocally(role);
            setLoading(false);
            setReconnecting(false);
            return;
          }
          setReconnectCount((c) => c + 1);
        }

        const tokenRes = await apiFetch<TokenResponse>(`/api/calls/${callId}/token`, {
          method: 'POST',
        });
        if (!mountedRef.current) return;

        setProviderMode(tokenRes.provider);
        setRemainingSeconds(tokenRes.remainingSeconds);

        // Start/rejoin call in backend (preserves original started_at across reconnects)
        const startRes = await apiFetch<{ remainingSeconds: number; started_at: string }>(
          `/api/calls/${callId}/state`,
          {
            method: 'POST',
            body: JSON.stringify({ action: 'start' }),
          }
        );
        if (!mountedRef.current) return;
        setRemainingSeconds(startRes.remainingSeconds);

        // Connect authenticated WebSocket room channel for signaling, presence, and instant termination
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${window.location.host}/ws?roomToken=${encodeURIComponent(tokenRes.roomToken)}`);
        wsRef.current = ws;

        ws.onclose = (ev) => {
          if (!mountedRef.current || endingRef.current) return;
          // 1000 = normal close, 4002 = replaced by newer socket, 4004 = room ended
          if (ev.code === 4004) {
            void handleFinalizeLocally(role);
            return;
          }
          if (ev.code !== 1000 && ev.code !== 4002 && autoReconnectAttemptRef.current < 3) {
            autoReconnectAttemptRef.current += 1;
            setConnState('reconectando');
            setTimeout(() => {
              if (mountedRef.current && !endingRef.current) {
                void reconnectFnRef.current?.();
              }
            }, 1500 * autoReconnectAttemptRef.current);
          }
        };

        // Branch 1: Real LiveKit SFU when backend issued a signed LiveKit JWT
        if (tokenRes.provider === 'livekit' && tokenRes.livekit?.url && tokenRes.livekit?.token) {
          const room = new Room({
            adaptiveStream: true,
            dynacast: true,
          });
          livekitRoomRef.current = room;

          room.on(RoomEvent.ConnectionStateChanged, (state) => {
            if (!mountedRef.current || endingRef.current) return;
            if (state === ConnectionState.Connecting) setConnState('conectando');
            else if (state === ConnectionState.Reconnecting) setConnState('reconectando');
            else if (state === ConnectionState.Connected) {
              autoReconnectAttemptRef.current = 0;
              setConnState(room.remoteParticipants.size > 0 ? 'conectado' : 'aguardando_par');
            }
          });

          room.on(RoomEvent.ParticipantConnected, () => {
            if (!mountedRef.current) return;
            setPeerPresent(true);
            setConnState('conectado');
          });

          room.on(RoomEvent.ParticipantDisconnected, () => {
            if (!mountedRef.current) return;
            const hasPeers = room.remoteParticipants.size > 0;
            setPeerPresent(hasPeers);
            if (!hasPeers && !endingRef.current) {
              setConnState('aguardando_par');
            }
          });

          room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
            if (!mountedRef.current) return;
            setPeerPresent(true);
            setConnState('conectado');
            if (track.kind === Track.Kind.Video && remoteVideoRef.current) {
              track.attach(remoteVideoRef.current);
              setRemoteCamOn(!track.isMuted);
            } else if (track.kind === Track.Kind.Audio && remoteAudioRef.current) {
              track.attach(remoteAudioRef.current);
              setRemoteMicOn(!track.isMuted);
            }
          });

          room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
            track.detach();
            if (track.kind === Track.Kind.Video) setRemoteCamOn(false);
          });

          room.on(RoomEvent.TrackMuted, (pub) => {
            if (!pub.isLocal) {
              if (pub.kind === Track.Kind.Audio) setRemoteMicOn(false);
              if (pub.kind === Track.Kind.Video) setRemoteCamOn(false);
            }
          });

          room.on(RoomEvent.TrackUnmuted, (pub) => {
            if (!pub.isLocal) {
              if (pub.kind === Track.Kind.Audio) setRemoteMicOn(true);
              if (pub.kind === Track.Kind.Video) setRemoteCamOn(true);
            }
          });

          await room.connect(tokenRes.livekit.url, tokenRes.livekit.token);
          if (!mountedRef.current) {
            room.disconnect(true);
            return;
          }

          setPeerPresent(room.remoteParticipants.size > 0);
          setConnState(room.remoteParticipants.size > 0 ? 'conectado' : 'aguardando_par');

          // Acquire and publish real hardware camera + microphone tracks
          try {
            const tracks = await createLocalTracks({
              audio: selectedAudioId ? { deviceId: selectedAudioId } : true,
              video: selectedVideoId ? { deviceId: selectedVideoId } : true,
            });
            localLivekitTracksRef.current = tracks;
            for (const track of tracks) {
              await room.localParticipant.publishTrack(track);
              if (track.kind === Track.Kind.Video && localVideoRef.current) {
                track.attach(localVideoRef.current);
              }
            }
            setHardwareWarning('');
            setMicOn(true);
            setCamOn(true);
            await refreshDevices();
          } catch {
            // Try audio-only real LiveKit track fallback
            try {
              const audioTracks = await createLocalTracks({ audio: true, video: false });
              localLivekitTracksRef.current = audioTracks;
              for (const track of audioTracks) {
                await room.localParticipant.publishTrack(track);
              }
              setHardwareWarning('Câmera indisponível no navegador. Transmitindo apenas áudio real via LiveKit.');
              setMicOn(true);
              setCamOn(false);
            } catch {
              setHardwareWarning(
                'Não foi possível acessar câmera/microfone. Verifique as permissões do navegador e reconecte.'
              );
              setMicOn(false);
              setCamOn(false);
            }
          }

          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'call:ended') {
                void handleFinalizeLocally(role);
              } else if (msg.type === 'room:media-state' && msg.payload) {
                if (typeof msg.payload.micOn === 'boolean') setRemoteMicOn(msg.payload.micOn);
                if (typeof msg.payload.camOn === 'boolean') setRemoteCamOn(msg.payload.camOn);
              }
            } catch {
              // ignore
            }
          };
        } else {
          // Branch 2: Real WebRTC P2P + authenticated WS signaling
          const stream = await acquireLocalStream(selectedAudioId || undefined, selectedVideoId || undefined);
          if (!mountedRef.current) {
            stream?.getTracks().forEach((t) => t.stop());
            return;
          }

          localStreamRef.current = stream;
          if (localVideoRef.current && stream) {
            localVideoRef.current.srcObject = stream;
          }

          const pc = new RTCPeerConnection({
            iceServers: tokenRes.iceServers?.length
              ? tokenRes.iceServers
              : [{ urls: 'stun:stun.l.google.com:19302' }],
          });
          pcRef.current = pc;

          if (stream) {
            stream.getTracks().forEach((track) => pc.addTrack(track, stream));
          } else {
            // Add recvonly transceivers so peer media can still be received even if local hardware is blocked
            pc.addTransceiver('audio', { direction: 'recvonly' });
            pc.addTransceiver('video', { direction: 'recvonly' });
          }

          pc.ontrack = (ev) => {
            if (!mountedRef.current) return;
            const remoteStream = ev.streams[0] || new MediaStream([ev.track]);
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = remoteStream;
            }
            setPeerPresent(true);
            setConnState('conectado');
            autoReconnectAttemptRef.current = 0;
          };

          pc.onicecandidate = (ev) => {
            if (ev.candidate && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'webrtc:ice-candidate', payload: ev.candidate }));
            }
          };

          pc.onconnectionstatechange = () => {
            if (!mountedRef.current || endingRef.current) return;
            if (pc.connectionState === 'connected') {
              autoReconnectAttemptRef.current = 0;
              setConnState('conectado');
            } else if (pc.connectionState === 'disconnected') {
              setConnState('reconectando');
            } else if (pc.connectionState === 'failed') {
              setConnState('reconectando');
              if (role === 'client' && ws.readyState === WebSocket.OPEN) {
                void pc.createOffer({ iceRestart: true }).then(async (offer) => {
                  await pc.setLocalDescription(offer);
                  ws.send(JSON.stringify({ type: 'webrtc:offer', payload: offer }));
                });
              }
            }
          };

          const flushIceQueue = async () => {
            while (pendingIceRef.current.length > 0 && pc.remoteDescription) {
              const candidate = pendingIceRef.current.shift()!;
              try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
              } catch {
                // Ignore stale ICE
              }
            }
          };

          ws.onopen = () => {
            if (!mountedRef.current) return;
            setConnState('aguardando_par');
            ws.send(
              JSON.stringify({
                type: 'room:media-state',
                payload: { micOn: Boolean(stream?.getAudioTracks().length), camOn: Boolean(stream?.getVideoTracks().length) },
              })
            );
          };

          ws.onmessage = async (event) => {
            try {
              const msg = JSON.parse(event.data);
              if (msg.type === 'room:presence') {
                const count = Number(msg.participantCount || 0);
                setPeerPresent(count >= 2);
                if (count >= 2 && role === 'client') {
                  const offer = await pc.createOffer();
                  await pc.setLocalDescription(offer);
                  ws.send(JSON.stringify({ type: 'webrtc:offer', payload: offer }));
                } else if (count >= 2 && role === 'professional' && !pc.remoteDescription) {
                  ws.send(JSON.stringify({ type: 'webrtc:renegotiate' }));
                }
              } else if (msg.type === 'webrtc:renegotiate' && role === 'client') {
                const offer = await pc.createOffer({ iceRestart: true });
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({ type: 'webrtc:offer', payload: offer }));
              } else if (msg.type === 'webrtc:offer' && msg.payload) {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
                await flushIceQueue();
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: 'webrtc:answer', payload: answer }));
                setPeerPresent(true);
                setConnState('conectado');
              } else if (msg.type === 'webrtc:answer' && msg.payload) {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
                await flushIceQueue();
                setPeerPresent(true);
                setConnState('conectado');
              } else if (msg.type === 'webrtc:ice-candidate' && msg.payload) {
                if (pc.remoteDescription) {
                  try {
                    await pc.addIceCandidate(new RTCIceCandidate(msg.payload));
                  } catch {
                    // Ignore stale candidate
                  }
                } else {
                  pendingIceRef.current.push(msg.payload);
                }
              } else if (msg.type === 'room:media-state' && msg.payload) {
                if (typeof msg.payload.micOn === 'boolean') setRemoteMicOn(msg.payload.micOn);
                if (typeof msg.payload.camOn === 'boolean') setRemoteCamOn(msg.payload.camOn);
              } else if (msg.type === 'room:peer-left') {
                setPeerPresent(false);
                if (!endingRef.current) setConnState('aguardando_par');
              } else if (msg.type === 'call:ended') {
                await handleFinalizeLocally(role);
              }
            } catch {
              // Ignore malformed signaling messages
            }
          };
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Acesso negado à sala privada.');
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setReconnecting(false);
        }
      }
    },
    [
      acquireLocalStream,
      callId,
      cleanupMediaAndSockets,
      handleFinalizeLocally,
      refreshDevices,
      selectedAudioId,
      selectedVideoId,
      user,
    ]
  );

  useEffect(() => {
    reconnectFnRef.current = () => connectSession(true);
  }, [connectSession]);

  useEffect(() => {
    mountedRef.current = true;
    endingRef.current = false;
    autoReconnectAttemptRef.current = 0;
    void connectSession(false);

    return () => {
      mountedRef.current = false;
      cleanupMediaAndSockets();
    };
  }, [callId, user?.id]);

  const handleEndCall = useCallback(
    async (reason: 'ended_by_participant' | 'duration_expired' = 'ended_by_participant') => {
      if (!callId || endingRef.current) return;
      endingRef.current = true;

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(JSON.stringify({ type: 'call:ended', payload: { reason } }));
        } catch {
          // ignore
        }
      }

      try {
        await apiFetch(`/api/calls/${callId}/state`, {
          method: 'POST',
          body: JSON.stringify({ action: 'end', reason }),
        });
      } catch {
        // Ignore if already ended on peer side
      }

      cleanupMediaAndSockets();
      if (!mountedRef.current) return;
      setConnState('finalizada');
      setPeerPresent(false);
      await loadLogs();

      if (participantRole === 'client') {
        setShowReview(true);
      }
    },
    [callId, cleanupMediaAndSockets, loadLogs, participantRole]
  );

  // Local 1s countdown + server heartbeat every 25s to enforce authoritative duration
  useEffect(() => {
    if (!call || connState === 'finalizada' || error) return;

    const timer = setInterval(() => {
      setRemainingSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          void handleEndCall('duration_expired');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    const heartbeat = setInterval(async () => {
      if (!callId || endingRef.current) return;
      try {
        const hb = await apiFetch<{ call_status: string; remainingSeconds: number }>(`/api/calls/${callId}/state`, {
          method: 'POST',
          body: JSON.stringify({ action: 'heartbeat' }),
        });
        if (!mountedRef.current) return;
        if (hb.call_status === 'finalizada') {
          await handleFinalizeLocally(participantRole);
        } else if (typeof hb.remainingSeconds === 'number') {
          setRemainingSeconds(hb.remainingSeconds);
        }
      } catch {
        // Non-fatal network blip
      }
    }, 25000);

    return () => {
      clearInterval(timer);
      clearInterval(heartbeat);
    };
  }, [call?.id, callId, connState, error, handleEndCall, handleFinalizeLocally, participantRole]);

  async function toggleMic() {
    const next = !micOn;
    if (providerMode === 'livekit' && livekitRoomRef.current) {
      const audioTrack = localLivekitTracksRef.current.find((t) => t.kind === Track.Kind.Audio);
      if (audioTrack) {
        if (next) await audioTrack.unmute();
        else await audioTrack.mute();
      } else {
        await livekitRoomRef.current.localParticipant.setMicrophoneEnabled(next);
      }
    } else {
      const tracks = localStreamRef.current?.getAudioTracks() || [];
      tracks.forEach((t) => {
        t.enabled = next;
      });
    }
    setMicOn(next);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'room:media-state', payload: { micOn: next, camOn } }));
    }
  }

  async function toggleCam() {
    const next = !camOn;
    if (providerMode === 'livekit' && livekitRoomRef.current) {
      const videoTrack = localLivekitTracksRef.current.find((t) => t.kind === Track.Kind.Video);
      if (videoTrack) {
        if (next) await videoTrack.unmute();
        else await videoTrack.mute();
      } else {
        await livekitRoomRef.current.localParticipant.setCameraEnabled(next);
      }
    } else {
      const tracks = localStreamRef.current?.getVideoTracks() || [];
      tracks.forEach((t) => {
        t.enabled = next;
      });
    }
    setCamOn(next);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'room:media-state', payload: { micOn, camOn: next } }));
    }
  }

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    if (!call) return;
    await apiFetch(`/api/client/bookings/${call.booking_id}/review`, {
      method: 'POST',
      body: JSON.stringify({ rating, comment }),
    });
    setReviewSaved(true);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#09090B] text-[#F5F2EB] flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <div className="font-display text-2xl">Preparando sala privada...</div>
          <div className="text-xs text-zinc-400">Validando token de sessão, autorização de pagamento e mídia</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#09090B] text-[#F5F2EB] flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-red-500/30 bg-[#111115] p-8 text-center space-y-4">
          <h1 className="font-display text-2xl text-red-300">Acesso não autorizado</h1>
          <p className="text-sm text-zinc-400">{error}</p>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="px-5 py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold cursor-pointer"
          >
            Voltar
          </button>
        </div>
      </div>
    );
  }

  const peerName = participantRole === 'client' ? call?.professional_name : call?.client_name;

  return (
    <div className="min-h-screen bg-[#060608] text-[#F5F2EB] flex flex-col">
      {/* Hidden audio tag for LiveKit remote audio subscription */}
      <audio ref={remoteAudioRef} autoPlay className="hidden" />

      {/* Top Call Bar */}
      <header className="h-16 px-4 sm:px-6 border-b border-white/10 bg-[#09090B]/95 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <ShieldCheck className="w-5 h-5 text-[#D4AF37] shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">Sala Privada · {peerName}</div>
            <div className="text-[11px] text-zinc-400 truncate">
              {connState === 'conectado'
                ? 'Conectado em tempo real'
                : connState === 'aguardando_par'
                  ? 'Aguardando ingresso do participante autorizado'
                  : connState === 'reconectando'
                    ? 'Reconectando mídia e sinalização...'
                    : connState === 'finalizada'
                      ? 'Sessão encerrada'
                      : 'Iniciando sala...'}
              {providerMode === 'livekit' ? ' · LiveKit SFU' : ' · WebRTC P2P'}
              {reconnectCount > 0 && ` · ${reconnectCount} reconexão(ões)`}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          {peerPresent && connState !== 'finalizada' && (
            <div className="hidden sm:flex items-center gap-2 text-[11px] text-zinc-400 border-r border-white/10 pr-4">
              {remoteMicOn ? (
                <Mic className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <MicOff className="w-3.5 h-3.5 text-red-400" />
              )}
              <span>{remoteMicOn ? 'Áudio remoto ativo' : 'Áudio remoto mudo'}</span>
            </div>
          )}

          <div className="text-right">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider flex items-center justify-end gap-1">
              <Clock className="w-3 h-3" />
              <span>Tempo restante</span>
            </div>
            <div
              className={`font-mono tabular-nums text-lg font-semibold ${
                remainingSeconds <= 60 ? 'text-red-400' : 'text-[#E5C97B]'
              }`}
            >
              {formatDurationSeconds(remainingSeconds)}
            </div>
          </div>
        </div>
      </header>

      {/* Hardware / Permission Notice */}
      {hardwareWarning && connState !== 'finalizada' && (
        <div className="bg-amber-500/10 border-b border-amber-500/25 px-4 sm:px-6 py-2.5 flex items-center justify-between gap-3 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
            <span>{hardwareWarning}</span>
          </div>
          <button
            type="button"
            onClick={() => void connectSession(true)}
            disabled={reconnecting}
            className="px-3 py-1 rounded bg-amber-400/20 hover:bg-amber-400/30 text-amber-100 font-medium shrink-0 cursor-pointer"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* Main Video Stage */}
      <main className="flex-1 relative p-4 sm:p-6 flex items-center justify-center overflow-hidden">
        <div className="relative w-full max-w-6xl h-[calc(100vh-11.5rem)] rounded-2xl border border-white/10 bg-[#111115] overflow-hidden flex items-center justify-center">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={`w-full h-full object-cover ${peerPresent && remoteCamOn ? 'block' : 'hidden'}`}
          />

          {(!peerPresent || !remoteCamOn) && connState !== 'finalizada' && (
            <div className="text-center px-6 space-y-3">
              <div className="w-16 h-16 rounded-full border border-[#D4AF37]/40 bg-[#D4AF37]/10 text-[#E5C97B] flex items-center justify-center mx-auto font-display text-2xl">
                {peerName?.[0] || 'A'}
              </div>
              <div className="font-display text-xl text-[#F5F2EB]">{peerName}</div>
              <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                {peerPresent
                  ? 'Participante conectado com câmera desligada no momento.'
                  : 'Sala exclusiva autenticada. Aguardando a conexão do outro participante autorizado.'}
              </p>
            </div>
          )}

          {connState === 'finalizada' && (
            <div className="w-full max-w-2xl max-h-full overflow-y-auto p-6 text-center space-y-5">
              <div>
                <div className="font-display text-2xl text-[#F5F2EB]">Videochamada finalizada</div>
                <p className="text-xs text-zinc-400 mt-1">
                  Duração registrada e repasse financeiro atualizados com integridade no banco de dados.
                </p>
              </div>

              {showReview && !reviewSaved && (
                <form onSubmit={submitReview} className="max-w-sm mx-auto space-y-3 pt-1 text-left">
                  <div className="text-xs font-medium text-zinc-200">Avaliar atendimento</div>
                  <select
                    value={rating}
                    onChange={(e) => setRating(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                  >
                    {[5, 4, 3, 2, 1].map((r) => (
                      <option key={r} value={r}>
                        {r} estrelas
                      </option>
                    ))}
                  </select>
                  <textarea
                    required
                    rows={3}
                    placeholder="Compartilhe sua experiência..."
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                  />
                  <button
                    type="submit"
                    className="w-full py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
                  >
                    Enviar avaliação
                  </button>
                </form>
              )}
              {reviewSaved && <div className="text-xs text-emerald-400">Avaliação registrada com sucesso.</div>}

              {callEvents.length > 0 && (
                <div className="text-left rounded-xl border border-white/10 bg-[#09090B]/70 p-4 space-y-2">
                  <div className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold">
                    Registro auditável da chamada
                  </div>
                  <div className="divide-y divide-white/5 max-h-44 overflow-y-auto">
                    {callEvents.map((ev) => (
                      <div key={ev.id} className="py-1.5 flex items-center justify-between gap-3 text-xs">
                        <span className="text-zinc-200">
                          {EVENT_LABELS[ev.event_type] || ev.event_type}
                          {ev.actor_name ? ` · ${ev.actor_name}` : ''}
                        </span>
                        <span className="font-mono tabular-nums text-[11px] text-zinc-500 shrink-0">
                          {new Date(ev.created_at).toLocaleTimeString('pt-BR')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <button
                  type="button"
                  onClick={() => navigate(participantRole === 'client' ? '/cliente/chamadas' : '/profissional/chamadas')}
                  className="px-5 py-2.5 rounded-lg border border-white/15 text-xs text-zinc-200 hover:bg-white/5 cursor-pointer"
                >
                  Voltar ao painel
                </button>
              </div>
            </div>
          )}

          {/* Local Picture-in-Picture Video */}
          {connState !== 'finalizada' && (
            <div className="absolute bottom-4 right-4 w-36 sm:w-52 aspect-video rounded-xl overflow-hidden border border-white/20 bg-[#09090B] shadow-xl flex items-center justify-center">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className={`w-full h-full object-cover ${camOn ? 'block' : 'hidden'}`}
              />
              {!camOn && (
                <div className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                  <VideoOff className="w-3.5 h-3.5" />
                  <span>Câmera desligada</span>
                </div>
              )}
              <div className="absolute bottom-1.5 left-2 text-[10px] text-white/85 bg-black/65 px-1.5 py-0.5 rounded flex items-center gap-1">
                <span>Você</span>
                {!micOn && <MicOff className="w-2.5 h-2.5 text-red-400" />}
              </div>
            </div>
          )}

          {/* Device Selection Drawer */}
          {showDevices && connState !== 'finalizada' && (
            <div className="absolute bottom-4 left-4 w-72 rounded-xl border border-white/15 bg-[#09090B]/95 p-4 space-y-3 shadow-2xl">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-200">Dispositivos de mídia</span>
                <button
                  type="button"
                  onClick={() => setShowDevices(false)}
                  className="text-[11px] text-zinc-400 hover:text-white cursor-pointer"
                >
                  Fechar
                </button>
              </div>
              <div className="space-y-1">
                <label className="block text-[11px] text-zinc-400">Microfone</label>
                <select
                  value={selectedAudioId}
                  onChange={(e) => setSelectedAudioId(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#141419] border border-white/10 text-xs text-white"
                >
                  <option value="">Padrão do sistema</option>
                  {audioInputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microfone ${d.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="block text-[11px] text-zinc-400">Câmera</label>
                <select
                  value={selectedVideoId}
                  onChange={(e) => setSelectedVideoId(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded bg-[#141419] border border-white/10 text-xs text-white"
                >
                  <option value="">Padrão do sistema</option>
                  {videoInputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Câmera ${d.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowDevices(false);
                  void connectSession(true);
                }}
                className="w-full py-2 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold cursor-pointer"
              >
                Aplicar e reconectar mídia
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Bottom Controls */}
      {connState !== 'finalizada' && (
        <footer className="h-20 border-t border-white/10 bg-[#09090B] px-4 sm:px-6 flex items-center justify-center gap-3 sm:gap-4">
          <button
            type="button"
            onClick={() => void toggleMic()}
            aria-label={micOn ? 'Desligar microfone' : 'Ligar microfone'}
            title={micOn ? 'Desligar microfone' : 'Ligar microfone'}
            className={`p-3.5 rounded-full border transition-colors cursor-pointer ${
              micOn ? 'border-white/15 bg-[#18181D] text-white' : 'border-red-500/40 bg-red-500/20 text-red-300'
            }`}
          >
            {micOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          </button>

          <button
            type="button"
            onClick={() => void toggleCam()}
            aria-label={camOn ? 'Desligar câmera' : 'Ligar câmera'}
            title={camOn ? 'Desligar câmera' : 'Ligar câmera'}
            className={`p-3.5 rounded-full border transition-colors cursor-pointer ${
              camOn ? 'border-white/15 bg-[#18181D] text-white' : 'border-red-500/40 bg-red-500/20 text-red-300'
            }`}
          >
            {camOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
          </button>

          <button
            type="button"
            onClick={() => {
              void refreshDevices();
              setShowDevices((v) => !v);
            }}
            aria-label="Selecionar câmera e microfone"
            title="Selecionar câmera e microfone"
            className="p-3.5 rounded-full border border-white/15 bg-[#18181D] text-zinc-300 hover:text-white cursor-pointer"
          >
            <Settings2 className="w-5 h-5" />
          </button>

          <button
            type="button"
            disabled={reconnecting}
            onClick={() => void connectSession(true)}
            aria-label="Reconectar chamada"
            title="Reconectar chamada sem sair da sala"
            className="p-3.5 rounded-full border border-white/15 bg-[#18181D] text-zinc-300 hover:text-white disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-5 h-5 ${reconnecting ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => void handleEndCall('ended_by_participant')}
            className="px-5 sm:px-6 py-3 rounded-full bg-red-600 text-white text-sm font-semibold hover:bg-red-500 flex items-center gap-2 cursor-pointer"
          >
            <PhoneOff className="w-4 h-4" />
            <span>Encerrar chamada</span>
          </button>
        </footer>
      )}
    </div>
  );
}
