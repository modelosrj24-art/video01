import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Calendar, Heart, Star, Video } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { availabilityLabel, DAY_NAMES_PT, formatBRL, formatDateShort } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import type { AvailabilitySlot, ProfessionalProfile, ReviewItem } from '../../types';
import { LuxuryShell } from '../../components/ui/LuxuryShell';
import { ProfileAvatar } from '../../components/ui/RevenueChart';
import { BookingCheckoutModal } from '../../components/ui/BookingCheckoutModal';

export function ProfessionalProfilePage() {
  const { slug } = useParams<{ slug: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [pro, setPro] = useState<ProfessionalProfile | null>(null);
  const [availability, setAvailability] = useState<AvailabilitySlot[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [bookedSlots, setBookedSlots] = useState<string[]>([]);
  const [favorited, setFavorited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [modalMode, setModalMode] = useState<'schedule' | 'instant' | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    apiFetch<{
      professional: ProfessionalProfile;
      availability: AvailabilitySlot[];
      reviews: ReviewItem[];
      bookedSlots: string[];
    }>(`/api/public/professionals/${slug}`)
      .then((res) => {
        setPro(res.professional);
        setAvailability(res.availability);
        setReviews(res.reviews);
        setBookedSlots(res.bookedSlots);
      })
      .catch(() => setPro(null))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleToggleFavorite() {
    if (!user || user.user_role !== 'client' || !pro) {
      navigate('/login');
      return;
    }
    const res = await apiFetch<{ favorited: boolean }>(`/api/client/favorites/${pro.id}`, { method: 'POST' });
    setFavorited(res.favorited);
  }

  function startFlow(mode: 'schedule' | 'instant') {
    if (!user) {
      navigate('/login');
      return;
    }
    if (user.user_role !== 'client') return;
    setModalMode(mode);
  }

  if (loading) {
    return (
      <LuxuryShell>
        <div className="max-w-5xl mx-auto px-6 py-16">
          <div className="h-64 rounded-2xl border border-white/10 bg-[#111115] animate-pulse" />
        </div>
      </LuxuryShell>
    );
  }

  if (!pro) {
    return (
      <LuxuryShell>
        <div className="max-w-3xl mx-auto px-6 py-20 text-center space-y-4">
          <h1 className="font-display text-2xl text-[#F5F2EB]">Profissional não encontrado</h1>
          <Link to="/profissionais" className="inline-block text-sm text-[#E5C97B] hover:underline">
            Voltar ao catálogo
          </Link>
        </div>
      </LuxuryShell>
    );
  }

  const st = availabilityLabel(pro.availability_status);

  return (
    <LuxuryShell>
      <div className="max-w-6xl mx-auto px-6 py-10">
        <Link
          to="/profissionais"
          className="inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-[#E5C97B] mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Voltar aos profissionais</span>
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Main Column */}
          <div className="lg:col-span-8 space-y-8">
            <div className="rounded-2xl border border-white/10 bg-[#111115] p-6 sm:p-8">
              <div className="flex flex-col sm:flex-row sm:items-start gap-6">
                <ProfileAvatar src={pro.profile_image} name={pro.professional_name} className="w-28 h-28" />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className={`text-xs font-medium ${st.colorClass}`}>{st.label}</div>
                      <h1 className="font-display text-3xl font-semibold text-[#F5F2EB] mt-1">
                        {pro.professional_name}
                      </h1>
                      <div className="text-sm text-zinc-400 mt-1">
                        {pro.category} · Idiomas: {pro.languages.join(', ')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleToggleFavorite}
                      aria-label="Favoritar profissional"
                      className={`p-2.5 rounded-lg border transition-colors cursor-pointer ${
                        favorited
                          ? 'border-[#D4AF37] bg-[#D4AF37]/15 text-[#E5C97B]'
                          : 'border-white/10 text-zinc-400 hover:text-white'
                      }`}
                    >
                      <Heart className="w-4 h-4" />
                    </button>
                  </div>

                  <p className="text-sm text-zinc-300 leading-relaxed mt-5">{pro.bio}</p>
                </div>
              </div>
            </div>

            {/* Availability Schedule */}
            <div className="rounded-2xl border border-white/10 bg-[#111115] p-6 sm:p-8">
              <h2 className="font-display text-xl font-semibold text-[#F5F2EB] mb-4">
                Agenda semanal autorizada
              </h2>
              {availability.length === 0 ? (
                <p className="text-xs text-zinc-400">Nenhum horário fixo publicado no momento.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {availability.map((slot) => (
                    <div
                      key={slot.id}
                      className="p-3.5 rounded-xl border border-white/10 bg-[#09090B] flex items-center justify-between"
                    >
                      <span className="text-xs font-medium text-zinc-200">{DAY_NAMES_PT[slot.day_of_week]}</span>
                      <span className="text-xs font-mono tabular-nums text-[#E5C97B]">
                        {slot.start_time} – {slot.end_time}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Reviews */}
            <div className="rounded-2xl border border-white/10 bg-[#111115] p-6 sm:p-8">
              <h2 className="font-display text-xl font-semibold text-[#F5F2EB] mb-4">
                Avaliações verificadas ({reviews.length})
              </h2>
              {reviews.length === 0 ? (
                <p className="text-xs text-zinc-400">Este profissional ainda não possui avaliações públicas.</p>
              ) : (
                <div className="space-y-4">
                  {reviews.map((rev) => (
                    <div key={rev.id} className="pt-4 border-t border-white/10 first:pt-0 first:border-t-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-[#F5F2EB]">{rev.client_name}</span>
                        <span className="text-xs font-mono tabular-nums text-[#E5C97B] flex items-center gap-1">
                          <Star className="w-3.5 h-3.5 fill-[#D4AF37] text-[#D4AF37]" />
                          {rev.rating}.0 · {formatDateShort(rev.created_at)}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 leading-relaxed mt-1.5">{rev.comment}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Sticky Booking Card */}
          <aside className="lg:col-span-4 rounded-2xl border border-white/15 bg-[#111115] p-6 space-y-5 lg:sticky lg:top-24">
            <div>
              <div className="text-xs text-zinc-400">Investimento por sessão</div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-2xl font-semibold font-mono tabular-nums text-[#E5C97B]">
                  {formatBRL(pro.price_per_session_cents)}
                </span>
                <span className="text-xs text-zinc-400">/ {pro.session_duration} minutos</span>
              </div>
              {pro.price_per_minute_cents > 0 && (
                <div className="text-xs text-zinc-400 font-mono tabular-nums mt-1">
                  Ou {formatBRL(pro.price_per_minute_cents)} por minuto
                </div>
              )}
            </div>

            <div className="space-y-2.5 pt-2 border-t border-white/10 text-xs text-zinc-400">
              <div>Atendimento individual em sala privada</div>
              <div>Pagamento validado via webhook antes da chamada</div>
              <div>Sem gravação de áudio ou vídeo por padrão</div>
            </div>

            <div className="space-y-3 pt-2">
              {pro.availability_status === 'online' && pro.instant_call_enabled === 1 && (
                <button
                  type="button"
                  onClick={() => startFlow('instant')}
                  className="w-full py-3 px-4 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] transition-colors flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Video className="w-4 h-4" />
                  <span>Solicitar chamada imediata</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => startFlow('schedule')}
                className="w-full py-3 px-4 rounded-lg border border-white/15 bg-white/5 text-[#F5F2EB] text-sm font-medium hover:bg-white/10 transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <Calendar className="w-4 h-4" />
                <span>Agendar data e horário</span>
              </button>

              {user && user.user_role !== 'client' && (
                <p className="text-[11px] text-amber-400 text-center">
                  Para contratar atendimentos, acesse com uma conta de Cliente.
                </p>
              )}
            </div>
          </aside>
        </div>
      </div>

      {modalMode && (
        <BookingCheckoutModal
          professional={pro}
          mode={modalMode}
          bookedSlots={bookedSlots}
          onClose={() => setModalMode(null)}
        />
      )}
    </LuxuryShell>
  );
}
