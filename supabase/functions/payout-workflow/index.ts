// Supabase Edge Function: payout-workflow
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Não autorizado' }), { status: 401, headers: corsHeaders });

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await supabaseUser.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: 'Sessão inválida' }), { status: 401, headers: corsHeaders });

    const { action, amount, payoutMethod, payoutDetails, payoutId, adminNotes } = await req.json();
    const adminClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    if (action === 'request') {
      const { data: pro } = await adminClient.from('professionals').select('id').eq('user_id', user.id).single();
      if (!pro) return new Response(JSON.stringify({ error: 'Profissional não encontrado' }), { status: 403, headers: corsHeaders });
      const { data: bal } = await adminClient.from('professional_balances').select('*').eq('professional_id', pro.id).single();
      if (!bal || Number(bal.available_balance) < Number(amount)) {
        return new Response(JSON.stringify({ error: 'Saldo disponível insuficiente' }), { status: 400, headers: corsHeaders });
      }
      await adminClient.from('payout_requests').insert({
        professional_id: pro.id,
        amount: Number(amount),
        payout_method: payoutMethod,
        payout_details: payoutDetails || {},
        status: 'pending',
      });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Admin actions
    const { data: isAdmin } = await adminClient.from('admin_users').select('user_id').eq('user_id', user.id).single();
    if (!isAdmin) return new Response(JSON.stringify({ error: 'Acesso administrativo exigido' }), { status: 403, headers: corsHeaders });

    if (action === 'approve') {
      await adminClient.from('payout_requests').update({ status: 'approved', approved_at: new Date().toISOString(), admin_notes: adminNotes }).eq('id', payoutId);
    } else if (action === 'reject') {
      await adminClient.from('payout_requests').update({ status: 'rejected', admin_notes: adminNotes }).eq('id', payoutId);
    } else if (action === 'mark_paid') {
      await adminClient.from('payout_requests').update({ status: 'paid', paid_at: new Date().toISOString(), admin_notes: adminNotes }).eq('id', payoutId);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
