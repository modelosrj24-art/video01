import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Calendar, Lock, ShieldCheck, Video } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { availabilityLabel, formatBRL } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import type { ProfessionalProfile } from '../../types';
import { LuxuryShell } from '../../components/ui/LuxuryShell';
import { ProfileAvatar } from '../../components/ui/RevenueChart';
import { BookingCheckoutModal } from '../../components/ui/BookingCheckoutModal';

export function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [professionals, setProfessionals] = useState<ProfessionalProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPro, setSelectedPro] = useState<{ pro: ProfessionalProfile; mode: 'schedule' | 'instant' } | null>(null);

  useEffect(() => {
    apiFetch<{ professionals: ProfessionalProfile[] }>('/api/public/professionals')
      .then((res) => setProfessionals(res.professionals.slice(0, 4)))
      .catch(() => setProfessionals([]))
      .finally(() => setLoading(false));
  }, []);

  function handleAction(pro: ProfessionalProfile, mode: 'schedule' | 'instant') {
    if (!user) {
      navigate('/login');
      return;
    }
    if (user.user_role !== 'client') {
      navigate(`/profissional/${pro.slug}`);
      return;
    }
    setSelectedPro({ pro, mode });
  }

  return (
    <LuxuryShell>
      {/* Hero Section */}
      <section className="relative border-b border-white/10 overflow-hidden">
        <div className="max-w-7xl mx-auto px-6 py-16 lg:py-24 grid grid-cols-1 lg:grid-cols-12 gap-12 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center space-y-6">
            <div className="text-xs font-medium tracking-wider text-[#E5C97B] uppercase">
              Atendimento Privado Credenciado
            </div>
            <h1 className="font-display text-4xl sm:text-5xl lg:text-[3.5rem] font-semibold leading-[1.1] tracking-tight text-[#F5F2EB] text-balance">
              Conexões exclusivas. Conversas privadas. Experiências personalizadas.
            </h1>
            <p className="text-base text-zinc-300 leading-relaxed max-w-xl">
              Escolha o profissional, reserve seu momento e tenha uma experiência individual em um ambiente privado,
              seguro e exclusivo — com salas protegidas por token temporário e pagamento verificado.
            </p>
            <div className="flex flex-wrap items-center gap-4 pt-2">
              <Link
                to="/profissionais"
                className="inline-flex items-center gap-2 px-6 py-3.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] transition-colors whitespace-nowrap"
              >
                <span>Conhecer profissionais</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                to={user ? '/cliente/dashboard' : '/cadastro'}
                className="inline-flex items-center gap-2 px-6 py-3.5 rounded-lg border border-white/15 text-sm font-medium text-[#F5F2EB] hover:bg-white/5 transition-colors whitespace-nowrap"
              >
                {user ? 'Acessar meu painel' : 'Criar conta gratuita'}
              </Link>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="relative h-72 sm:h-96 lg:h-full min-h-[380px] rounded-2xl overflow-hidden border border-white/10 bg-[#111115]">
              <img
                src="/src/assets/images/hero_private_lounge_1795309181828.jpg"
                alt="Ambiente privado e sofisticado Aurum Privé"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#09090B]/90 via-[#09090B]/20 to-transparent" />
              <div className="absolute bottom-6 left-6 right-6 flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="text-xs text-[#E5C97B]">Salas WebRTC 1:1</div>
                  <div className="font-display text-xl font-medium text-[#F5F2EB] mt-0.5">
                    Sigilo operacional e áudio/vídeo dedicados
                  </div>
                </div>
                <div className="text-xs text-zinc-300 font-mono tabular-nums">
                  Criptografia ponta a ponta · Sem gravação padrão
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Featured Professionals Section */}
      <section className="max-w-7xl mx-auto px-6 py-20 border-b border-white/10">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-10">
          <div>
            <h2 className="font-display text-3xl font-semibold text-[#F5F2EB] tracking-tight">
              Profissionais em destaque
            </h2>
            <p className="text-sm text-zinc-400 mt-2">
              Especialistas selecionados e aprovados pela curadoria da plataforma.
            </p>
          </div>
          <Link
            to="/profissionais"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[#E5C97B] hover:underline whitespace-nowrap"
          >
            <span>Ver catálogo completo</span>
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-96 rounded-2xl border border-white/10 bg-[#111115] animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {professionals.map((pro) => {
              const statusInfo = availabilityLabel(pro.availability_status);
              return (
                <article
                  key={pro.id}
                  className="rounded-2xl border border-white/10 bg-[#111115] p-5 flex flex-col justify-between hover:border-[#D4AF37]/40 transition-colors"
                >
                  <div>
                    <div className="flex items-start gap-4">
                      <ProfileAvatar src={pro.profile_image} name={pro.professional_name} className="w-16 h-16" />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-base font-semibold text-[#F5F2EB] truncate">{pro.professional_name}</h3>
                        <div className="text-xs text-zinc-400 mt-0.5 truncate">{pro.category}</div>
                        <div className={`text-xs font-medium mt-1.5 ${statusInfo.colorClass}`}>
                          {statusInfo.label}
                        </div>
                      </div>
                    </div>

                    <p className="text-xs text-zinc-400 leading-relaxed mt-4 line-clamp-3">{pro.bio}</p>
                  </div>

                  <div className="mt-5 pt-4 border-t border-white/10 space-y-4">
                    <div className="flex items-baseline justify-between">
                      <div>
                        <span className="text-base font-semibold font-mono tabular-nums text-[#E5C97B]">
                          {formatBRL(pro.price_per_session_cents)}
                        </span>
                        <span className="text-xs text-zinc-500"> · {pro.session_duration} min</span>
                      </div>
                      {pro.rating_avg && (
                        <span className="text-xs font-mono tabular-nums text-zinc-400">
                          {Number(pro.rating_avg).toFixed(1)} / 5.0
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Link
                        to={`/profissional/${pro.slug}`}
                        className="text-center py-2 px-3 rounded-lg border border-white/15 text-xs font-medium text-zinc-200 hover:bg-white/5 transition-colors"
                      >
                        Ver perfil
                      </Link>
                      {pro.availability_status === 'online' && pro.instant_call_enabled ? (
                        <button
                          type="button"
                          onClick={() => handleAction(pro, 'instant')}
                          className="py-2 px-3 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] transition-colors cursor-pointer"
                        >
                          Conversar agora
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleAction(pro, 'schedule')}
                          className="py-2 px-3 rounded-lg bg-white/10 text-[#F5F2EB] text-xs font-medium hover:bg-white/15 transition-colors cursor-pointer"
                        >
                          Agendar
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* How It Works */}
      <section className="max-w-7xl mx-auto px-6 py-20 border-b border-white/10">
        <div className="max-w-2xl mb-12">
          <h2 className="font-display text-3xl font-semibold text-[#F5F2EB] tracking-tight">
            Como funciona a experiência
          </h2>
          <p className="text-sm text-zinc-400 mt-2">
            Quatro etapas objetivas para garantir disponibilidade confirmada e acesso exclusivo à sala privada.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {[
            {
              step: '01. Escolha seu profissional',
              desc: 'Filtre por especialidade, idioma, disponibilidade imediata ou agenda programada.',
            },
            {
              step: '02. Selecione o atendimento',
              desc: 'Defina chamada imediata ou horário reservado e a duração ideal para a sua necessidade.',
            },
            {
              step: '03. Realize o pagamento',
              desc: 'Checkout integrado com validação de webhook no servidor antes da liberação da sala.',
            },
            {
              step: '04. Acesse sua sala privada',
              desc: 'Entre com token temporário individual em ambiente de vídeo e áudio sem gravação padrão.',
            },
          ].map((item) => (
            <div key={item.step} className="space-y-3 pt-4 border-t border-white/15">
              <h3 className="text-base font-semibold text-[#E5C97B]">{item.step}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Security & Privacy */}
      <section className="max-w-7xl mx-auto px-6 py-20">
        <div className="rounded-2xl border border-white/10 bg-[#111115] p-8 lg:p-12 grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
          <div className="lg:col-span-5 space-y-4">
            <h2 className="font-display text-3xl font-semibold text-[#F5F2EB] tracking-tight">
              Privacidade e controle como arquitetura
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Cada sala de videochamada é isolada por identificador único e tokens temporários emitidos exclusivamente
              pelo servidor após confirmação financeira.
            </p>
          </div>
          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5F2EB]">
                <Lock className="w-4 h-4 text-[#D4AF37]" />
                <span>Salas individuais privadas</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Somente o cliente pagante e o profissional designado recebem credenciais para ingressar na chamada.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5F2EB]">
                <Video className="w-4 h-4 text-[#D4AF37]" />
                <span>Sem gravação por padrão</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Áudio e vídeo trafegam em tempo real sem armazenamento automático de mídia na plataforma.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5F2EB]">
                <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
                <span>Pagamentos auditados</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Liberação de acesso vinculada à confirmação real de pagamento e registro em ledger financeiro imutável.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5F2EB]">
                <Calendar className="w-4 h-4 text-[#D4AF37]" />
                <span>Cronômetro e tolerância</span>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Controle exato do tempo contratado, reconexão assistida e cálculo automático de duração real.
              </p>
            </div>
          </div>
        </div>
      </section>

      {selectedPro && (
        <BookingCheckoutModal
          professional={selectedPro.pro}
          mode={selectedPro.mode}
          onClose={() => setSelectedPro(null)}
        />
      )}
    </LuxuryShell>
  );
}
