// Supabase Edge Function: livekit-token
// Issues short-lived LiveKit room tokens strictly to verified call participants after payment confirmation.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { AccessToken } from 'npm:livekit-server-sdk@2';

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

    const { callId } = await req.json();
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: call } = await adminClient
      .from('video_calls')
      .select('*, client:clients!inner(user_id), professional:professionals!inner(user_id)')
      .eq('id', callId)
      .single();

    if (!call) return new Response(JSON.stringify({ error: 'Sala não encontrada' }), { status: 404, headers: corsHeaders });

    const isParticipant = call.client.user_id === user.id || call.professional.user_id === user.id;
    if (!isParticipant) return new Response(JSON.stringify({ error: 'Acesso negado à sala privada' }), { status: 403, headers: corsHeaders });

    const allowedStatuses = ['pagamento_confirmado', 'aguardando_profissional', 'aguardando_cliente', 'iniciando', 'em_andamento'];
    if (!allowedStatuses.includes(call.call_status)) {
      return new Response(JSON.stringify({ error: 'Chamada não autorizada para ingresso' }), { status: 403, headers: corsHeaders });
    }

    const apiKey = Deno.env.get('LIVEKIT_API_KEY')!;
    const apiSecret = Deno.env.get('LIVEKIT_API_SECRET')!;
    const at = new AccessToken(apiKey, apiSecret, {
      identity: user.id,
      ttl: '1h',
    });
    at.addGrant({ roomJoin: true, room: call.room_name, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();
    return new Response(JSON.stringify({ token, roomName: call.room_name, url: Deno.env.get('LIVEKIT_URL') }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
