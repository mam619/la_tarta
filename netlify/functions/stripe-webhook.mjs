import { db, stripe, json, markPaid } from '../lib/shared.mjs';

// POST /api/stripe-webhook -> Stripe tells us when a payment succeeds, fails or times out
export default async (req) => {
  const signature = req.headers.get('stripe-signature');
  const payload = await req.text();
  let event;
  try {
    event = stripe().webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed', err.message);
    return json({ error: 'Invalid signature' }, 400);
  }

  const session = event.data.object;
  const orderId = session.metadata?.order_id;
  if (!orderId) return json({ received: true });
  const supabase = db();

  switch (event.type) {
    case 'checkout.session.completed':
      if (session.payment_status === 'paid') {
        await markPaid(orderId, session.id);
      } else {
        // Payment still being confirmed (e.g. MB WAY): keep the cakes held for a day
        await supabase.from('orders')
          .update({ hold_expires_at: new Date(Date.now() + 24 * 3600e3).toISOString() })
          .eq('id', orderId).eq('status', 'pending');
      }
      break;
    case 'checkout.session.async_payment_succeeded':
      await markPaid(orderId, session.id);
      break;
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      await supabase.from('orders')
        .update({ status: event.type.endsWith('expired') ? 'expired' : 'cancelled' })
        .eq('id', orderId).eq('status', 'pending');
      break;
  }
  return json({ received: true });
};

export const config = { path: '/api/stripe-webhook' };
