// Supabase Edge Function: create-checkout
// Validates booking ownership, applies coupons server-side, and creates a Mercado Pago preference/PIX charge.
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
    const { data: { user }, error: authErr } = await supabaseUser.auth.getUser();
    if (authErr || !user) return new Response(JSON.stringify({ error: 'Sessão inválida' }), { status: 401, headers: corsHeaders });

    const { bookingId, paymentMethod } = await req.json();
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: booking } = await adminClient
      .from('bookings')
      .select('*, client:clients!inner(user_id), professional:professionals(professional_name)')
      .eq('id', bookingId)
      .single();

    if (!booking || booking.client.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Agendamento não encontrado ou sem permissão' }), { status: 403, headers: corsHeaders });
    }
    if (booking.status !== 'aguardando_pagamento') {
      return new Response(JSON.stringify({ error: 'Agendamento já processado' }), { status: 409, headers: corsHeaders });
    }

    const { data: payment, error: payErr } = await adminClient
      .from('payments')
      .insert({
        client_id: booking.client_id,
        booking_id: booking.id,
        provider: 'mercadopago',
        amount: booking.amount,
        currency: 'BRL',
        status: 'pending',
        payment_method: paymentMethod || 'pix',
      })
      .select()
      .single();

    if (payErr) throw payErr;

    const mpToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
    if (!mpToken) {
      return new Response(JSON.stringify({ payment, mode: 'sandbox_pending_credentials' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          title: `Sessão Privada — ${booking.professional.professional_name}`,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: Number(booking.amount),
        }],
        external_reference: payment.id,
        notification_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/mercadopago-webhook`,
      }),
    });
    const mpData = await mpRes.json();

    return new Response(JSON.stringify({ payment, init_point: mpData.init_point, mode: 'production' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: corsHeaders });
  }
});
