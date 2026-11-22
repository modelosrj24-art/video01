import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { LuxuryShell } from '../../components/ui/LuxuryShell';

interface SetupStatus {
  demoModeEnabled: boolean;
  hasRealAdmin: boolean;
  canBootstrapAdmin: boolean;
  envPasscodeRequired: boolean;
}

export function AuthPage({ initialMode = 'login' }: { initialMode?: 'login' | 'register' | 'forgot' }) {
  const { login, register, demoLogin, bootstrapAdmin } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'bootstrap'>(initialMode);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [passcode, setPasscode] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    setMode(initialMode);
    setError('');
    setSuccessMsg('');
  }, [initialMode]);

  useEffect(() => {
    apiFetch<SetupStatus>('/api/auth/setup-status')
      .then(setSetupStatus)
      .catch(() => setSetupStatus(null));
  }, []);

  function redirectByRole(role: string) {
    if (role === 'admin') navigate('/admin/dashboard');
    else if (role === 'professional') navigate('/profissional/dashboard');
    else navigate('/cliente/dashboard');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccessMsg('');
    setLoading(true);
    try {
      if (mode === 'login') {
        const u = await login(email, password);
        redirectByRole(u.user_role);
      } else if (mode === 'register') {
        const u = await register({ fullName, email, password, phone });
        redirectByRole(u.user_role);
      } else if (mode === 'bootstrap') {
        const u = await bootstrapAdmin({ fullName, email, password, passcode });
        redirectByRole(u.user_role);
      } else {
        const res = await apiFetch<{ message: string }>('/api/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        setSuccessMsg(res.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na autenticação.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDemoAccess(role: 'admin' | 'professional' | 'client') {
    setError('');
    setLoading(true);
    try {
      const u = await demoLogin(role);
      redirectByRole(u.user_role);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Modo demonstração indisponível.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <LuxuryShell>
      <div className="max-w-5xl mx-auto px-6 py-12 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        {/* Auth Card */}
        <div className="lg:col-span-7 rounded-2xl border border-white/10 bg-[#111115] p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-white/10">
            <div>
              <h1 className="font-display text-2xl sm:text-3xl font-semibold text-[#F5F2EB]">
                {mode === 'login'
                  ? 'Acessar plataforma'
                  : mode === 'register'
                    ? 'Criar conta de cliente'
                    : mode === 'bootstrap'
                      ? 'Configurar Administrador Principal'
                      : 'Recuperar senha'}
              </h1>
              <p className="text-xs text-zinc-400 mt-1">
                {mode === 'register'
                  ? 'Profissionais são credenciados exclusivamente pelo administrador.'
                  : 'Autenticação segura com verificação de perfil no servidor.'}
              </p>
            </div>
          </div>

          {error && (
            <div className="mt-4 p-3 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="mt-4 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-300">
              {successMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {(mode === 'register' || mode === 'bootstrap') && (
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Nome completo</label>
                <input
                  required
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">E-mail</label>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nome@empresa.com"
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
              />
            </div>

            {mode === 'register' && (
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">Telefone (opcional)</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+55 11 99999-9999"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            )}

            {mode !== 'forgot' && (
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Senha {mode !== 'login' && '(mínimo 8 caracteres)'}
                </label>
                <input
                  required
                  type="password"
                  minLength={mode === 'login' ? 1 : 8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            )}

            {mode === 'bootstrap' && setupStatus?.envPasscodeRequired && (
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Código de autorização (ADMIN_BOOTSTRAP_PASSCODE)
                </label>
                <input
                  required
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] disabled:opacity-50 transition-colors cursor-pointer"
            >
              {loading
                ? 'Processando...'
                : mode === 'login'
                  ? 'Entrar'
                  : mode === 'register'
                    ? 'Criar conta'
                    : mode === 'bootstrap'
                      ? 'Registrar Administrador Principal'
                      : 'Enviar instruções'}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
            {mode === 'login' ? (
              <>
                <button type="button" onClick={() => setMode('forgot')} className="hover:text-[#E5C97B] cursor-pointer">
                  Esqueci minha senha
                </button>
                <Link to="/cadastro" className="text-[#E5C97B] hover:underline">
                  Não tem conta? Cadastre-se
                </Link>
              </>
            ) : (
              <Link to="/login" onClick={() => setMode('login')} className="text-[#E5C97B] hover:underline">
                Já possui conta? Fazer login
              </Link>
            )}
          </div>
        </div>

        {/* Demo Mode & First-Run Admin Column */}
        <div className="lg:col-span-5 space-y-6">
          {setupStatus?.demoModeEnabled && (
            <div className="rounded-2xl border border-[#D4AF37]/30 bg-[#111115] p-6 space-y-4">
              <div>
                <div className="text-xs font-semibold text-[#E5C97B]">Modo de Demonstração Ativo</div>
                <h2 className="font-display text-xl font-semibold text-[#F5F2EB] mt-1">
                  Avaliar painéis por perfil
                </h2>
                <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
                  Acesse contas fictícias sinalizadas como Demonstração sem expor senhas fixas. Você pode remover todos os
                  dados demo a qualquer momento no painel administrativo.
                </p>
              </div>

              <div className="space-y-2.5">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleDemoAccess('admin')}
                  className="w-full py-2.5 px-4 rounded-lg border border-[#D4AF37]/40 bg-[#D4AF37]/10 text-left hover:bg-[#D4AF37]/20 transition-colors cursor-pointer"
                >
                  <div className="text-xs font-semibold text-[#E5C97B]">Entrar como Administrador (Demo)</div>
                  <div className="text-[11px] text-zinc-400">Controle total: profissionais, ledger, saques e auditoria</div>
                </button>

                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleDemoAccess('professional')}
                  className="w-full py-2.5 px-4 rounded-lg border border-white/15 bg-[#09090B] text-left hover:border-white/30 transition-colors cursor-pointer"
                >
                  <div className="text-xs font-semibold text-[#F5F2EB]">Entrar como Profissional (Demo)</div>
                  <div className="text-[11px] text-zinc-400">Camila Alencar · Agenda, chamadas, CRM e saques</div>
                </button>

                <button
                  type="button"
                  disabled={loading}
                  onClick={() => handleDemoAccess('client')}
                  className="w-full py-2.5 px-4 rounded-lg border border-white/15 bg-[#09090B] text-left hover:border-white/30 transition-colors cursor-pointer"
                >
                  <div className="text-xs font-semibold text-[#F5F2EB]">Entrar como Cliente (Demo)</div>
                  <div className="text-[11px] text-zinc-400">Eduardo Siqueira · Agendamentos, pagamentos e sala</div>
                </button>
              </div>
            </div>
          )}

          {setupStatus?.canBootstrapAdmin && (
            <div className="rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
                <span>Primeiro Acesso de Produção</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Nenhum administrador real foi registrado ainda. Crie a conta proprietária principal para operar fora do
                modo de demonstração.
              </p>
              <button
                type="button"
                onClick={() => setMode(mode === 'bootstrap' ? 'login' : 'bootstrap')}
                className="w-full py-2.5 px-4 rounded-lg border border-white/15 text-xs font-medium text-[#F5F2EB] hover:bg-white/5 cursor-pointer"
              >
                {mode === 'bootstrap' ? 'Voltar ao login comum' : 'Configurar Administrador Principal'}
              </button>
            </div>
          )}
        </div>
      </div>
    </LuxuryShell>
  );
}
