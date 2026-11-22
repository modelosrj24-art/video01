import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export function LuxuryShell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const dashboardPath =
    user?.user_role === 'admin'
      ? '/admin/dashboard'
      : user?.user_role === 'professional'
        ? '/profissional/dashboard'
        : '/cliente/dashboard';

  const navLinks = [
    { to: '/', label: 'Início' },
    { to: '/profissionais', label: 'Profissionais' },
    { to: '/como-funciona', label: 'Como funciona' },
    { to: '/suporte', label: 'Suporte' },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-[#09090B] text-[#F5F2EB]">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#09090B]/95 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line brand wordmark */}
          <Link
            to="/"
            className="font-display text-xl font-semibold tracking-tight text-[#F5F2EB] whitespace-nowrap shrink-0"
          >
            Aurum Privé
          </Link>

          {/* Zone 2: Clean typographic navigation links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-400">
            {navLinks.map((item) => {
              const active = location.pathname === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={`transition-colors whitespace-nowrap shrink-0 py-1 ${
                    active ? 'text-[#E5C97B] border-b border-[#D4AF37]' : 'hover:text-[#F5F2EB]'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            {!user ? (
              <>
                <Link to="/login" className="hover:text-[#F5F2EB] transition-colors whitespace-nowrap shrink-0 py-1">
                  Entrar
                </Link>
                <Link to="/cadastro" className="hover:text-[#F5F2EB] transition-colors whitespace-nowrap shrink-0 py-1">
                  Criar conta
                </Link>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate('/');
                }}
                className="hover:text-[#F5F2EB] transition-colors whitespace-nowrap shrink-0 py-1 cursor-pointer"
              >
                Sair
              </button>
            )}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="flex items-center gap-3 shrink-0">
            {user ? (
              <Link
                to={dashboardPath}
                className="hidden md:inline-flex items-center justify-center px-5 py-2.5 text-xs font-semibold tracking-wide bg-[#D4AF37] text-[#09090B] rounded-lg hover:bg-[#E5C97B] transition-colors whitespace-nowrap shrink-0"
              >
                Meu Painel
              </Link>
            ) : (
              <Link
                to="/profissionais"
                className="hidden md:inline-flex items-center justify-center px-5 py-2.5 text-xs font-semibold tracking-wide bg-[#D4AF37] text-[#09090B] rounded-lg hover:bg-[#E5C97B] transition-colors whitespace-nowrap shrink-0"
              >
                Encontrar profissional
              </Link>
            )}

            <button
              type="button"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label="Abrir menu"
              className="md:hidden p-2.5 rounded-lg border border-white/10 text-zinc-300 hover:text-white cursor-pointer"
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="md:hidden border-t border-white/10 bg-[#111115] px-6 py-4 space-y-3">
            {navLinks.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                className="block py-2 text-sm text-zinc-200 hover:text-[#E5C97B]"
              >
                {item.label}
              </Link>
            ))}
            {!user ? (
              <div className="pt-2 border-t border-white/10 flex flex-col gap-2">
                <Link
                  to="/login"
                  onClick={() => setMobileOpen(false)}
                  className="py-2 text-sm text-zinc-200 hover:text-[#E5C97B]"
                >
                  Entrar
                </Link>
                <Link
                  to="/cadastro"
                  onClick={() => setMobileOpen(false)}
                  className="py-2 text-sm text-zinc-200 hover:text-[#E5C97B]"
                >
                  Criar conta
                </Link>
                <Link
                  to="/profissionais"
                  onClick={() => setMobileOpen(false)}
                  className="mt-1 text-center px-4 py-2.5 text-xs font-semibold bg-[#D4AF37] text-[#09090B] rounded-lg"
                >
                  Encontrar profissional
                </Link>
              </div>
            ) : (
              <div className="pt-2 border-t border-white/10 flex flex-col gap-2">
                <Link
                  to={dashboardPath}
                  onClick={() => setMobileOpen(false)}
                  className="text-center px-4 py-2.5 text-xs font-semibold bg-[#D4AF37] text-[#09090B] rounded-lg"
                >
                  Meu Painel
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    logout();
                    setMobileOpen(false);
                    navigate('/');
                  }}
                  className="py-2 text-left text-sm text-zinc-400"
                >
                  Sair
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      <main className="flex-1">{children}</main>

      {/* Quiet Editorial Footer */}
      <footer className="border-t border-white/10 bg-[#09090B]">
        <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="space-y-3">
            <div className="font-display text-lg font-semibold text-[#F5F2EB]">Aurum Privé</div>
            <p className="text-xs leading-relaxed text-zinc-400">
              Conexões privadas individuais por videochamada criptografada entre clientes e especialistas credenciados.
            </p>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="font-semibold text-zinc-200">Plataforma</div>
            <div className="flex flex-col gap-2 text-zinc-400">
              <Link to="/profissionais" className="hover:text-[#E5C97B] transition-colors">
                Catálogo de profissionais
              </Link>
              <Link to="/como-funciona" className="hover:text-[#E5C97B] transition-colors">
                Como funciona
              </Link>
              <Link to="/login" className="hover:text-[#E5C97B] transition-colors">
                Acessar conta
              </Link>
              <Link to="/cadastro" className="hover:text-[#E5C97B] transition-colors">
                Criar conta de cliente
              </Link>
            </div>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="font-semibold text-zinc-200">Conformidade & Segurança</div>
            <div className="flex flex-col gap-2 text-zinc-400">
              <Link to="/termos" className="hover:text-[#E5C97B] transition-colors">
                Termos de uso
              </Link>
              <Link to="/privacidade" className="hover:text-[#E5C97B] transition-colors">
                Política de privacidade
              </Link>
              <Link to="/termos#cancelamento" className="hover:text-[#E5C97B] transition-colors">
                Política de cancelamento
              </Link>
            </div>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="font-semibold text-zinc-200">Atendimento</div>
            <div className="flex flex-col gap-2 text-zinc-400">
              <Link to="/suporte" className="hover:text-[#E5C97B] transition-colors">
                Central de suporte
              </Link>
              <span>concierge@aurumprive.com.br</span>
              <span>São Paulo · Brasil</span>
            </div>
          </div>
        </div>

        <div className="border-t border-white/5 py-5 px-6 max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
          <span>© {new Date().getFullYear()} Aurum Privé. Todos os direitos reservados.</span>
          <span>Chamadas individuais privadas sem gravação por padrão.</span>
        </div>
      </footer>
    </div>
  );
}
