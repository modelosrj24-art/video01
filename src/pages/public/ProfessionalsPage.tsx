import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { availabilityLabel, formatBRL } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import type { ProfessionalProfile } from '../../types';
import { LuxuryShell } from '../../components/ui/LuxuryShell';
import { ProfileAvatar } from '../../components/ui/RevenueChart';
import { BookingCheckoutModal } from '../../components/ui/BookingCheckoutModal';

export function ProfessionalsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [professionals, setProfessionals] = useState<ProfessionalProfile[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [maxPriceBRL, setMaxPriceBRL] = useState('');
  const [instantOnly, setInstantOnly] = useState(false);

  const [selectedPro, setSelectedPro] = useState<{ pro: ProfessionalProfile; mode: 'schedule' | 'instant' } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (category !== 'all') params.set('category', category);
    if (status !== 'all') params.set('status', status);
    if (instantOnly) params.set('instantOnly', 'true');
    if (maxPriceBRL && Number(maxPriceBRL) > 0) {
      params.set('maxPriceCents', String(Math.round(Number(maxPriceBRL) * 100)));
    }

    setLoading(true);
    apiFetch<{ professionals: ProfessionalProfile[]; categories: string[] }>(`/api/public/professionals?${params.toString()}`)
      .then((res) => {
        setProfessionals(res.professionals);
        setCategories(res.categories);
      })
      .catch(() => setProfessionals([]))
      .finally(() => setLoading(false));
  }, [search, category, status, instantOnly, maxPriceBRL]);

  function openBooking(pro: ProfessionalProfile, mode: 'schedule' | 'instant') {
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
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="max-w-2xl mb-8">
          <h1 className="font-display text-3xl sm:text-4xl font-semibold text-[#F5F2EB] tracking-tight">
            Catálogo de Profissionais
          </h1>
          <p className="text-sm text-zinc-400 mt-2">
            Pesquise por nome, especialidade, disponibilidade imediata ou faixa de investimento.
          </p>
        </div>

        {/* Filter Bar */}
        <div className="rounded-xl border border-white/10 bg-[#111115] p-4 mb-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-center">
          <div className="relative lg:col-span-2">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Buscar por nome ou especialidade..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2.5 rounded-lg bg-[#09090B] border border-white/10 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-[#D4AF37]"
            />
          </div>

          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-3 py-2.5 rounded-lg bg-[#09090B] border border-white/10 text-sm text-zinc-200 focus:outline-none focus:border-[#D4AF37]"
          >
            <option value="all">Todas as categorias</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2.5 rounded-lg bg-[#09090B] border border-white/10 text-sm text-zinc-200 focus:outline-none focus:border-[#D4AF37]"
          >
            <option value="all">Qualquer status</option>
            <option value="online">Online agora</option>
            <option value="busy">Em atendimento</option>
            <option value="offline">Apenas agendamento</option>
          </select>

          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              placeholder="Máx. R$"
              value={maxPriceBRL}
              onChange={(e) => setMaxPriceBRL(e.target.value)}
              className="w-24 px-3 py-2.5 rounded-lg bg-[#09090B] border border-white/10 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-[#D4AF37]"
            />
            <button
              type="button"
              onClick={() => setInstantOnly(!instantOnly)}
              className={`flex-1 py-2.5 px-3 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                instantOnly
                  ? 'border-[#D4AF37] bg-[#D4AF37]/15 text-[#E5C97B]'
                  : 'border-white/10 bg-[#09090B] text-zinc-400 hover:text-white'
              }`}
            >
              Imediato
            </button>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-72 rounded-2xl border border-white/10 bg-[#111115] animate-pulse" />
            ))}
          </div>
        ) : professionals.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-[#111115] p-12 text-center space-y-3">
            <div className="text-base font-medium text-[#F5F2EB]">Nenhum profissional encontrado</div>
            <p className="text-xs text-zinc-400">Ajuste os filtros de busca ou limpe as seleções aplicadas.</p>
            <button
              type="button"
              onClick={() => {
                setSearch('');
                setCategory('all');
                setStatus('all');
                setMaxPriceBRL('');
                setInstantOnly(false);
              }}
              className="px-4 py-2 rounded-lg border border-white/15 text-xs text-zinc-200 hover:bg-white/5 cursor-pointer"
            >
              Limpar filtros
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {professionals.map((pro) => {
              const st = availabilityLabel(pro.availability_status);
              return (
                <article
                  key={pro.id}
                  className="rounded-2xl border border-white/10 bg-[#111115] p-6 flex flex-col justify-between hover:border-[#D4AF37]/40 transition-colors"
                >
                  <div>
                    <div className="flex items-start gap-4">
                      <ProfileAvatar src={pro.profile_image} name={pro.professional_name} className="w-16 h-16" />
                      <div className="min-w-0 flex-1">
                        <h2 className="text-lg font-semibold text-[#F5F2EB] truncate">{pro.professional_name}</h2>
                        <div className="text-xs text-zinc-400 mt-0.5">
                          {pro.category} · {pro.languages.join(', ')}
                        </div>
                        <div className={`text-xs font-medium mt-1.5 ${st.colorClass}`}>{st.label}</div>
                      </div>
                    </div>
                    <p className="text-sm text-zinc-400 leading-relaxed mt-4 line-clamp-3">{pro.bio}</p>
                  </div>

                  <div className="mt-6 pt-4 border-t border-white/10 space-y-4">
                    <div className="flex items-baseline justify-between">
                      <div>
                        <span className="text-lg font-semibold font-mono tabular-nums text-[#E5C97B]">
                          {formatBRL(pro.price_per_session_cents)}
                        </span>
                        <span className="text-xs text-zinc-500"> / {pro.session_duration} min</span>
                      </div>
                      {pro.price_per_minute_cents > 0 && (
                        <span className="text-xs font-mono tabular-nums text-zinc-400">
                          {formatBRL(pro.price_per_minute_cents)}/min
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <Link
                        to={`/profissional/${pro.slug}`}
                        className="flex-1 text-center py-2.5 px-3 rounded-lg border border-white/15 text-xs font-medium text-zinc-200 hover:bg-white/5 transition-colors"
                      >
                        Ver perfil
                      </Link>
                      <button
                        type="button"
                        onClick={() => openBooking(pro, 'schedule')}
                        className="flex-1 py-2.5 px-3 rounded-lg bg-white/10 text-[#F5F2EB] text-xs font-medium hover:bg-white/15 transition-colors cursor-pointer"
                      >
                        Agendar
                      </button>
                      {pro.availability_status === 'online' && pro.instant_call_enabled === 1 && (
                        <button
                          type="button"
                          onClick={() => openBooking(pro, 'instant')}
                          className="flex-1 py-2.5 px-3 rounded-lg bg-[#D4AF37] text-[#09090B] text-xs font-semibold hover:bg-[#E5C97B] transition-colors cursor-pointer"
                        >
                          Chamar agora
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

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
