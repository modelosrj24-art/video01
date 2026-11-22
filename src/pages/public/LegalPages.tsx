import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LuxuryShell } from '../../components/ui/LuxuryShell';

export function HowItWorksPage() {
  return (
    <LuxuryShell>
      <div className="max-w-4xl mx-auto px-6 py-16 space-y-12">
        <div className="space-y-3">
          <h1 className="font-display text-4xl font-semibold text-[#F5F2EB]">Como funciona a Aurum Privé</h1>
          <p className="text-base text-zinc-400 leading-relaxed">
            Arquitetura pensada para conectar clientes e profissionais credenciados com segurança financeira, controle de
            agenda e salas privadas individuais.
          </p>
        </div>

        <div className="space-y-8">
          {[
            {
              title: '01. Curadoria e aprovação administrativa',
              body: 'Profissionais não se autocadastram livremente. Cada especialista passa pela aprovação do Administrador Principal, que define categorias, comissões e limites operacionais.',
            },
            {
              title: '02. Agendamento sem conflito ou chamada imediata',
              body: 'Quando o profissional está online e habilitado, você pode iniciar uma chamada imediata. Caso contrário, escolha data e horário disponíveis na agenda sem risco de reserva duplicada.',
            },
            {
              title: '03. Pagamento verificado no backend',
              body: 'O acesso à sala só é liberado após confirmação real do pagamento via webhook autenticado. Cada operação gera registro imutável no ledger financeiro com cálculo exato da comissão e do repasse.',
            },
            {
              title: '04. Sala privada temporária e sem gravação',
              body: 'Os participantes recebem tokens individuais emitidos pelo servidor. O cronômetro acompanha o tempo contratado e nenhuma mídia é gravada por padrão.',
            },
          ].map((sec) => (
            <div key={sec.title} className="pt-6 border-t border-white/10 space-y-2">
              <h2 className="text-lg font-semibold text-[#E5C97B]">{sec.title}</h2>
              <p className="text-sm text-zinc-300 leading-relaxed">{sec.body}</p>
            </div>
          ))}
        </div>

        <div>
          <Link
            to="/profissionais"
            className="inline-flex px-6 py-3 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B]"
          >
            Explorar profissionais
          </Link>
        </div>
      </div>
    </LuxuryShell>
  );
}

export function LegalPage({ type }: { type: 'terms' | 'privacy' | 'support' }) {
  const [sent, setSent] = useState(false);

  if (type === 'support') {
    return (
      <LuxuryShell>
        <div className="max-w-3xl mx-auto px-6 py-16 space-y-8">
          <div>
            <h1 className="font-display text-3xl font-semibold text-[#F5F2EB]">Suporte & Concierge</h1>
            <p className="text-sm text-zinc-400 mt-2">
              Canal direto para dúvidas sobre pagamentos, agendamentos, estornos ou credenciamento de profissionais.
            </p>
          </div>
          {sent ? (
            <div className="p-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-300">
              Solicitação registrada com sucesso. Nossa equipe responderá para o e-mail informado.
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSent(true);
              }}
              className="rounded-2xl border border-white/10 bg-[#111115] p-6 space-y-4"
            >
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Seu nome</label>
                <input
                  required
                  type="text"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">E-mail de contato</label>
                <input
                  required
                  type="email"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-300 mb-1.5">Assunto e detalhes</label>
                <textarea
                  required
                  rows={4}
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#09090B] border border-white/15 text-sm text-white"
                />
              </div>
              <button
                type="submit"
                className="px-6 py-2.5 rounded-lg bg-[#D4AF37] text-[#09090B] text-sm font-semibold hover:bg-[#E5C97B] cursor-pointer"
              >
                Enviar mensagem
              </button>
            </form>
          )}
        </div>
      </LuxuryShell>
    );
  }

  return (
    <LuxuryShell>
      <div className="max-w-3xl mx-auto px-6 py-16 space-y-6">
        <h1 className="font-display text-3xl font-semibold text-[#F5F2EB]">
          {type === 'terms' ? 'Termos de Uso e Política de Cancelamento' : 'Política de Privacidade e LGPD'}
        </h1>
        {type === 'terms' ? (
          <div className="space-y-4 text-sm text-zinc-300 leading-relaxed">
            <p>
              1. A plataforma Aurum Privé atua como intermediadora tecnológica de salas privadas de videochamada entre
              clientes autenticados e profissionais credenciados pela administração.
            </p>
            <p id="cancelamento">
              2. Cancelamentos e Estornos: Cancelamentos solicitados dentro da janela mínima configurada pela
              plataforma são elegíveis a estorno integral auditado pelo administrador.
            </p>
            <p>
              3. Conduta: O compartilhamento de tokens de acesso ou tentativa de gravação não autorizada acarreta
              bloqueio imediato da conta.
            </p>
          </div>
        ) : (
          <div className="space-y-4 text-sm text-zinc-300 leading-relaxed">
            <p>
              1. Coleta Mínima: Armazenamos apenas dados cadastrais essenciais, registros financeiros obrigatórios e logs
              de auditoria para segurança operacional.
            </p>
            <p>
              2. Videochamadas sem Gravação: Nenhuma chamada de áudio ou vídeo é gravada ou armazenada por padrão nos
              servidores da plataforma.
            </p>
            <p>
              3. Isolamento de Dados: Observações privadas de atendimento pertencem exclusivamente ao profissional
              responsável e ao administrador para fins de conformidade.
            </p>
          </div>
        )}
      </div>
    </LuxuryShell>
  );
}
