// Supabase Edge Function: manage-call & payout-workflow stubs
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

    const { callId, action } = await req.json();
    const adminClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: call } = await adminClient
      .from('video_calls')
      .select('*, client:clients!inner(user_id), professional:professionals!inner(user_id)')
      .eq('id', callId)
      .single();

    if (!call || (call.client.user_id !== user.id && call.professional.user_id !== user.id)) {
      return new Response(JSON.stringify({ error: 'Sem permissão' }), { status: 403, headers: corsHeaders });
    }

    const now = new Date().toISOString();
    if (action === 'start') {
      await adminClient.from('video_calls').update({ call_status: 'em_andamento', started_at: call.started_at || now }).eq('id', callId);
    } else if (action === 'end') {
      const durationSec = call.started_at ? Math.max(0, Math.floor((Date.now() - new Date(call.started_at).getTime()) / 1000)) : 0;
      await adminClient.from('video_calls').update({ call_status: 'finalizada', ended_at: now, duration_seconds: durationSec }).eq('id', callId);
      await adminClient.from('bookings').update({ status: 'finalizada' }).eq('id', call.booking_id);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
