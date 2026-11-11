import { db, stripe, json, markPaid } from '../lib/shared.mjs';

// GET /api/order-status?session_id=... -> details for the confirmation page
export default async (req) => {
  const sessionId = new URL(req.url).searchParams.get('session_id') || '';
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json({ error: 'Order not found.' }, 404);

  const supabase = db();
  const { data: order } = await supabase
    .from('orders').select('*').eq('stripe_session_id', sessionId).maybeSingle();
  if (!order) return json({ error: 'Order not found.' }, 404);

  let status = order.status;
  if (status !== 'paid') {
    // The webhook may not have arrived yet: ask Stripe directly
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') {
      await markPaid(order.id, sessionId);
      status = 'paid';
    } else if (session.status === 'complete') {
      status = 'processing'; // e.g. MB WAY still being confirmed
    }
  }

  const base = {
    status,
    date: order.pickup_date,
    slot: order.slot_hour,
    items: order.items,
    total: order.total_cents,
    name: order.customer_name.split(' ')[0],
  };
  // The pickup address is only shown once the order is paid
  if (status === 'paid') base.pickupAddress = process.env.PICKUP_ADDRESS || null;
  return json(base);
};

export const config = { path: '/api/order-status' };
