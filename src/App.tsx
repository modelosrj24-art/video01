import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import type { UserRole } from './types';
import { HomePage } from './pages/public/HomePage';
import { ProfessionalsPage } from './pages/public/ProfessionalsPage';
import { ProfessionalProfilePage } from './pages/public/ProfessionalProfilePage';
import { HowItWorksPage, LegalPage } from './pages/public/LegalPages';
import { AuthPage } from './pages/public/AuthPages';
import { VideoCallRoomPage } from './pages/call/VideoCallRoomPage';
import { ClientPortal } from './pages/client/ClientPortal';
import { ProfessionalPortal } from './pages/professional/ProfessionalPortal';
import { AdminPortal } from './pages/admin/AdminPortal';

function RequireRole({ roles, children }: { roles: UserRole[]; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.user_role)) {
    const home =
      user.user_role === 'admin'
        ? '/admin/dashboard'
        : user.user_role === 'professional'
          ? '/profissional/dashboard'
          : '/cliente/dashboard';
    return <Navigate to={home} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Public Routes */}
          <Route path="/" element={<HomePage />} />
          <Route path="/profissionais" element={<ProfessionalsPage />} />
          <Route path="/profissional/:slug" element={<ProfessionalProfilePage />} />
          <Route path="/como-funciona" element={<HowItWorksPage />} />
          <Route path="/login" element={<AuthPage initialMode="login" />} />
          <Route path="/cadastro" element={<AuthPage initialMode="register" />} />
          <Route path="/recuperar-senha" element={<AuthPage initialMode="forgot" />} />
          <Route path="/termos" element={<LegalPage type="terms" />} />
          <Route path="/privacidade" element={<LegalPage type="privacy" />} />
          <Route path="/suporte" element={<LegalPage type="support" />} />

          {/* Private Video Call Room */}
          <Route
            path="/sala/:callId"
            element={
              <RequireRole roles={['client', 'professional']}>
                <VideoCallRoomPage />
              </RequireRole>
            }
          />

          {/* Client Portal */}
          <Route
            path="/cliente/dashboard"
            element={
              <RequireRole roles={['client']}>
                <ClientPortal section="dashboard" />
              </RequireRole>
            }
          />
          <Route
            path="/cliente/perfil"
            element={
              <RequireRole roles={['client']}>
                <ClientPortal section="profile" />
              </RequireRole>
            }
          />
          <Route
            path="/cliente/favoritos"
            element={
              <RequireRole roles={['client']}>
                <ClientPortal section="favorites" />
              </RequireRole>
            }
          />
          <Route
            path="/cliente/agendamentos"
            element={
              <RequireRole roles={['client']}>
                <ClientPortal section="bookings" />
              </RequireRole>
            }
          />
          <Route
            path="/cliente/chamadas"
            element={
              <RequireRole roles={['client']}>
                <ClientPortal section="calls" />
              </RequireRole>
            }
          />
          <Route
            path="/cliente/pagamentos"
            element={
              <RequireRole roles={['client']}>
                <ClientPortal section="payments" />
              </RequireRole>
            }
          />
          <Route
            path="/cliente/notificacoes"
            element={
              <RequireRole roles={['client']}>
                <ClientPortal section="notifications" />
              </RequireRole>
            }
          />

          {/* Professional Portal */}
          <Route
            path="/profissional/dashboard"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="dashboard" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/perfil"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="profile" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/agenda"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="agenda" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/disponibilidade"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="agenda" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/chamadas"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="calls" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/clientes"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="clients" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/financeiro"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="financials" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/comissoes"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="financials" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/saques"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="payouts" />
              </RequireRole>
            }
          />
          <Route
            path="/profissional/notificacoes"
            element={
              <RequireRole roles={['professional']}>
                <ProfessionalPortal section="notifications" />
              </RequireRole>
            }
          />

          {/* Admin Portal */}
          <Route
            path="/admin/dashboard"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="dashboard" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/profissionais"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="professionals" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/clientes"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="clients" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/agendamentos"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="bookings" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/chamadas"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="calls" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/pagamentos"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="payments" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/gateways"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="gateways" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/financeiro"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="financials" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/comissoes"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="commissions" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/repasses"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="payouts" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/saques"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="payouts" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/cupons"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="coupons" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/avaliacoes"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="reviews" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/relatorios"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="reports" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/notificacoes"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="notifications" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/configuracoes"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="settings" />
              </RequireRole>
            }
          />
          <Route
            path="/admin/auditoria"
            element={
              <RequireRole roles={['admin']}>
                <AdminPortal section="audit" />
              </RequireRole>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
