import { db, stripe, json } from '../lib/shared.mjs';

// POST /api/cancel-checkout -> customer came back from Stripe without paying: free the cakes now
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const { orderId } = await req.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/i.test(orderId || '')) return json({ ok: true });

  const supabase = db();
  const { data: order } = await supabase
    .from('orders').select('id,status,stripe_session_id').eq('id', orderId).maybeSingle();
  if (!order || order.status !== 'pending') return json({ ok: true });

  if (order.stripe_session_id) {
    try {
      await stripe().checkout.sessions.expire(order.stripe_session_id);
    } catch {
      // Already paid or expired: never cancel in that case
      return json({ ok: true });
    }
  }
  await supabase.from('orders').update({ status: 'cancelled' }).eq('id', orderId).eq('status', 'pending');
  return json({ ok: true });
};

export const config = { path: '/api/cancel-checkout' };
