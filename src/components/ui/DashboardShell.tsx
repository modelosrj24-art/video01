import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Bell, LogOut, Menu, Video, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export interface SidebarItem {
  to: string;
  label: string;
  icon: React.ReactNode;
}

interface DashboardShellProps {
  title: string;
  breadcrumb: string;
  items: SidebarItem[];
  children: React.ReactNode;
  headerAction?: React.ReactNode;
}

export function DashboardShell({ title, breadcrumb, items, children, headerAction }: DashboardShellProps) {
  const { user, logout, liveAlert, dismissAlert } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenu, setMobileMenu] = useState(false);

  const notificationsPath =
    user?.user_role === 'professional'
      ? '/profissional/notificacoes'
      : user?.user_role === 'client'
        ? '/cliente/notificacoes'
        : '/admin/notificacoes';

  return (
    <div className="min-h-screen bg-[#09090B] text-[#F5F2EB] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-white/10 bg-[#0E0E12]">
        <div className="h-16 px-6 flex items-center justify-between border-b border-white/10">
          <Link to="/" className="font-display text-lg font-semibold tracking-tight text-[#F5F2EB]">
            Aurum Privé
          </Link>
        </div>

        <div className="px-6 py-4 border-b border-white/5">
          <div className="text-sm font-medium text-[#F5F2EB] truncate">{user?.full_name}</div>
          <div className="text-xs text-zinc-400 mt-0.5">
            {user?.user_role === 'admin'
              ? 'Administrador Principal'
              : user?.user_role === 'professional'
                ? 'Ambiente do Profissional'
                : 'Portal do Cliente'}
            {user?.is_demo ? ' · Modo Demo' : ''}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {items.map((item) => {
            const active = location.pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-[#D4AF37]/15 text-[#E5C97B] font-medium border border-[#D4AF37]/30'
                    : 'text-zinc-400 hover:text-[#F5F2EB] hover:bg-white/5'
                }`}
              >
                <span className="w-4 h-4 shrink-0">{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/10 space-y-1">
          <Link
            to="/profissionais"
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs text-zinc-400 hover:text-[#F5F2EB] hover:bg-white/5"
          >
            Catálogo público
          </Link>
          <button
            type="button"
            onClick={() => {
              logout();
              navigate('/login');
            }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-400 hover:text-red-400 hover:bg-white/5 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenu && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/75" onClick={() => setMobileMenu(false)} />
          <aside className="relative z-10 w-72 max-w-[82vw] bg-[#0E0E12] border-r border-white/10 flex flex-col">
            <div className="h-16 px-5 flex items-center justify-between border-b border-white/10">
              <span className="font-display text-lg font-semibold">Aurum Privé</span>
              <button
                type="button"
                onClick={() => setMobileMenu(false)}
                className="p-2 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
              {items.map((item) => {
                const active = location.pathname === item.to;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileMenu(false)}
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                      active ? 'bg-[#D4AF37]/15 text-[#E5C97B] font-medium' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <span className="w-4 h-4 shrink-0">{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
            <div className="p-3 border-t border-white/10">
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate('/login');
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-400 hover:text-red-400 cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                <span>Sair</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 border-b border-white/10 bg-[#09090B]/90 backdrop-blur-md px-5 lg:px-8 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenu(true)}
              aria-label="Menu"
              className="lg:hidden p-2 rounded-lg border border-white/10 text-zinc-300 cursor-pointer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <div className="text-xs text-zinc-500 truncate">{breadcrumb}</div>
              <h1 className="text-base font-semibold text-[#F5F2EB] truncate">{title}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {headerAction}
            <Link
              to={notificationsPath}
              aria-label="Notificações"
              className="p-2.5 rounded-lg border border-white/10 text-zinc-300 hover:text-[#E5C97B] hover:border-[#D4AF37]/40 transition-colors"
            >
              <Bell className="w-4 h-4" />
            </Link>
          </div>
        </header>

        {liveAlert && (
          <div className="mx-5 lg:mx-8 mt-4 p-4 rounded-xl border border-[#D4AF37]/40 bg-[#18181D] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Video className="w-5 h-5 text-[#D4AF37] shrink-0" />
              <div>
                <div className="text-sm font-medium text-[#F5F2EB]">{liveAlert.title}</div>
                {liveAlert.clientName && (
                  <div className="text-xs text-zinc-400">Solicitação de: {liveAlert.clientName}</div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {liveAlert.callId && (
                <button
                  type="button"
                  onClick={() => {
                    const id = liveAlert.callId;
                    dismissAlert();
                    navigate(`/sala/${id}`);
                  }}
                  className="px-4 py-2 text-xs font-semibold bg-[#D4AF37] text-[#09090B] rounded-lg hover:bg-[#E5C97B] cursor-pointer"
                >
                  Acessar sala
                </button>
              )}
              <button
                type="button"
                onClick={dismissAlert}
                className="px-3 py-2 text-xs text-zinc-400 hover:text-white cursor-pointer"
              >
                Dispensar
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 p-5 lg:p-8 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
