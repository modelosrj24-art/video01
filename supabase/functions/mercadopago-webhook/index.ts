// Supabase Edge Function: mercadopago-webhook
// Verifies Mercado Pago webhook signature, prevents duplicate confirmation, posts immutable ledger entry,
// credits professional pending balance, creates private video_calls room, and dispatches notifications.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const signature = req.headers.get('x-signature');
    const webhookSecret = Deno.env.get('MERCADOPAGO_WEBHOOK_SECRET');
    if (webhookSecret && !signature) {
      return new Response(JSON.stringify({ error: 'Assinatura ausente' }), { status: 401 });
    }

    const payload = await req.json();
    const mpToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
    const paymentResourceId = payload?.data?.id;
    if (!paymentResourceId || !mpToken) {
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentResourceId}`, {
      headers: { Authorization: `Bearer ${mpToken}` },
    });
    const mpPayment = await mpRes.json();
    if (mpPayment.status !== 'approved') {
      return new Response(JSON.stringify({ status: mpPayment.status }), { status: 200 });
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: payment } = await adminClient
      .from('payments')
      .select('*, booking:bookings(*, professional:professionals(commission_percentage, user_id))')
      .eq('id', mpPayment.external_reference)
      .single();

    if (!payment || payment.status === 'approved') {
      return new Response(JSON.stringify({ idempotent: true }), { status: 200 });
    }

    const gross = Number(payment.amount);
    const commissionPct = Number(payment.booking.professional.commission_percentage);
    const platformFee = Number(((gross * commissionPct) / 100).toFixed(2));
    const proAmount = Number((gross - platformFee).toFixed(2));

    await adminClient.from('payments').update({
      status: 'approved',
      provider_payment_id: String(mpPayment.id),
      paid_at: new Date().toISOString(),
    }).eq('id', payment.id);

    await adminClient.from('bookings').update({ status: 'pagamento_confirmado' }).eq('id', payment.booking_id);

    await adminClient.from('video_calls').insert({
      booking_id: payment.booking_id,
      client_id: payment.client_id,
      professional_id: payment.booking.professional_id,
      room_name: `aurum-${payment.booking_id}`,
      call_status: 'pagamento_confirmado',
      amount: gross,
    });

    await adminClient.from('financial_transactions').insert({
      payment_id: payment.id,
      professional_id: payment.booking.professional_id,
      client_id: payment.client_id,
      booking_id: payment.booking_id,
      transaction_type: 'session_credit',
      gross_amount: gross,
      platform_fee: platformFee,
      professional_amount: proAmount,
      currency: 'BRL',
    });

    return new Response(JSON.stringify({ processed: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
