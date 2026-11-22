import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { apiFetch, getAuthToken, setAuthToken } from '../lib/api';
import type { AuthUser } from '../types';

interface LiveAlert {
  id: string;
  type: string;
  title: string;
  callId?: string;
  clientName?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  liveAlert: LiveAlert | null;
  dismissAlert: () => void;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (payload: { fullName: string; email: string; password: string; phone: string }) => Promise<AuthUser>;
  demoLogin: (role: 'admin' | 'professional' | 'client') => Promise<AuthUser>;
  bootstrapAdmin: (payload: { fullName: string; email: string; password: string; passcode: string }) => Promise<AuthUser>;
  refreshUser: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveAlert, setLiveAlert] = useState<LiveAlert | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const token = getAuthToken();
    if (!user || !token) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'call:incoming' || msg.type === 'notification:new' || msg.type === 'call:status') {
          setLiveAlert({
            id: String(Date.now()),
            type: msg.type,
            title: msg.data?.title || msg.data?.message || 'Atualização em tempo real',
            callId: msg.data?.callId,
            clientName: msg.data?.clientName,
          });
        }
      } catch {
        // Ignore non-JSON messages
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [user?.id]);

  async function refreshUser() {
    if (!getAuthToken()) {
      setUser(null);
      return;
    }
    try {
      const res = await apiFetch<{ user: AuthUser }>('/api/auth/me');
      setUser(res.user);
    } catch {
      setAuthToken(null);
      setUser(null);
    }
  }

  async function login(email: string, password: string) {
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setAuthToken(res.token);
      setUser(res.user);
      return res.user;
    } finally {
      setLoading(false);
    }
  }

  async function register(payload: { fullName: string; email: string; password: string; phone: string }) {
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAuthToken(res.token);
      setUser(res.user);
      return res.user;
    } finally {
      setLoading(false);
    }
  }

  async function demoLogin(role: 'admin' | 'professional' | 'client') {
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/demo-login', {
        method: 'POST',
        body: JSON.stringify({ role }),
      });
      setAuthToken(res.token);
      setUser(res.user);
      return res.user;
    } finally {
      setLoading(false);
    }
  }

  async function bootstrapAdmin(payload: { fullName: string; email: string; password: string; passcode: string }) {
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string; user: AuthUser }>('/api/auth/bootstrap-admin', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAuthToken(res.token);
      setUser(res.user);
      return res.user;
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setAuthToken(null);
    setUser(null);
    wsRef.current?.close();
    wsRef.current = null;
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        liveAlert,
        dismissAlert: () => setLiveAlert(null),
        login,
        register,
        demoLogin,
        bootstrapAdmin,
        refreshUser,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return ctx;
}
