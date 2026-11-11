import { db, stripe, json, dayLabel, slotLabel } from '../lib/shared.mjs';

const ERRORS = {
  NOT_ENOUGH_CAPACITY: [409, 'Someone just booked the last cakes for that day. Pick another day.'],
  DAY_CLOSED: [409, 'Orders for that day have closed. Pick another day.'],
  TOO_MANY_CAKES: [400, 'That is more cakes than one order allows.'],
  EMPTY_ORDER: [400, 'Add at least one cake.'],
  INVALID_SLOT: [400, 'Pick a pickup time.'],
  UNKNOWN_PRODUCT: [400, 'One of the cakes is no longer available. Reload the page.'],
  INVALID_QTY: [400, 'Check the cake quantities.'],
};

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// POST /api/create-checkout -> holds the cakes, then sends the customer to Stripe
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }

  const date = clean(body.date, 10);
  const slot = Number(body.slot);
  const name = clean(body.name, 80);
  const email = clean(body.email, 120).toLowerCase();
  const phone = clean(body.phone, 30);
  const nif = clean(body.nif, 20).replace(/\s/g, '');
  const notes = clean(body.notes, 300);
  const items = {};
  for (const [code, qty] of Object.entries(body.items || {})) {
    const n = Number(qty);
    if (/^[A-Z]{1,4}$/.test(code) && Number.isInteger(n) && n >= 0 && n <= 20) items[code] = n;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Pick a pickup day.' }, 400);
  if (!Number.isInteger(slot)) return json({ error: 'Pick a pickup time.' }, 400);
  if (name.length < 2) return json({ error: 'Add your name.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Check your email address.' }, 400);
  if (phone.replace(/\D/g, '').length < 9) return json({ error: 'Check your phone number.' }, 400);
  if (nif && !/^\d{9}$/.test(nif)) return json({ error: 'A Portuguese NIF has 9 digits.' }, 400);

  const supabase = db();

  // 1. Check capacity and hold the cakes
  const { data: reserved, error: reserveError } = await supabase.rpc('reserve_order', {
    p_pickup_date: date, p_slot_hour: slot, p_items: items,
    p_customer_name: name, p_email: email, p_phone: phone, p_nif: nif, p_notes: notes,
  });
  if (reserveError) {
    const key = Object.keys(ERRORS).find((k) => reserveError.message?.includes(k));
    if (key) return json({ error: ERRORS[key][1], code: key }, ERRORS[key][0]);
    console.error(reserveError);
    return json({ error: 'Something went wrong. Try again in a minute.' }, 500);
  }
  const orderId = reserved[0].out_order_id;

  // 2. Create the Stripe payment page
  try {
    const { data: products } = await supabase.from('products').select('code,name,price_cents');
    const pickup = `Pickup ${dayLabel(date)}, ${slotLabel(slot)}, Alcântara`;
    const origin = new URL(req.url).origin;

    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items: products
        .filter((p) => items[p.code] > 0)
        .map((p) => ({
          quantity: items[p.code],
          price_data: {
            currency: 'eur',
            unit_amount: p.price_cents,
            product_data: { name: p.name, description: pickup },
          },
        })),
      customer_email: email,
      client_reference_id: orderId,
      metadata: { order_id: orderId },
      payment_intent_data: { metadata: { order_id: orderId }, description: `BASCA order: ${pickup}` },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      locale: 'auto',
      custom_text: {
        submit: { message: `${pickup}. You'll see the pickup address as soon as you've paid.` },
      },
      success_url: `${origin}/order-confirmed.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/order.html?cancelled=${orderId}`,
    });

    await supabase.from('orders').update({ stripe_session_id: session.id }).eq('id', orderId);
    return json({ url: session.url });
  } catch (err) {
    console.error(err);
    await supabase.from('orders').update({ status: 'cancelled' }).eq('id', orderId);
    return json({ error: 'Payment could not be started. Try again in a minute.' }, 502);
  }
};

export const config = { path: '/api/create-checkout' };
