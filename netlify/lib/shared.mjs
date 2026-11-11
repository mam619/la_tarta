import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

export const db = () =>
  createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

export const stripe = () => new Stripe(env('STRIPE_SECRET_KEY'));

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

// ---- Dates (pickup dates are plain calendar dates, e.g. "2026-11-14") ----
const asUtcDate = (isoDay) => new Date(`${isoDay}T00:00:00Z`);

export const dayLabel = (isoDay) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }).format(asUtcDate(isoDay));

export const slotLabel = (hour) =>
  `${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00`;

// Current date and hour in Lisbon, whatever the server's time zone or the season
export const lisbonNow = () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

export const addDays = (isoDay, n) => {
  const d = asUtcDate(isoDay);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const euros = (cents) => `€${(cents / 100).toFixed(2).replace('.00', '')}`;

export const itemsLabel = (items) =>
  Object.entries(items).filter(([, q]) => q > 0).map(([code, q]) => `${q}× ${code}`).join(', ');

// ---- Telegram ----
export const telegram = async (text) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('Telegram not configured, skipping message');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('Telegram error', res.status, await res.text());
};

// ---- Mark an order paid (used by the Stripe webhook and the confirmation page) ----
// Safe to call twice: only the first call changes the order and sends the alert.
export const markPaid = async (orderId, sessionId) => {
  const supabase = db();
  const { data, error } = await supabase
    .from('orders')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('stripe_session_id', sessionId)
    .in('status', ['pending', 'expired'])
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!data) return null; // already paid, nothing to do

  const { data: status } = await supabase.rpc('day_status', { p_day: data.pickup_date });
  const day = status?.[0];
  const over = day && day.taken > day.capacity;

  await telegram(
    [
      `New order: ${dayLabel(data.pickup_date)}, ${slotLabel(data.slot_hour)}`,
      `${itemsLabel(data.items)} · ${euros(data.total_cents)}`,
      '',
      data.customer_name,
      data.phone,
      data.email,
      data.nif ? `NIF ${data.nif}` : null,
      data.notes ? `Note: ${data.notes}` : null,
      '',
      day ? `Day booked: ${day.taken} of ${day.capacity} cakes` : null,
      over ? 'WARNING: this day is now over capacity (payment arrived after the hold ran out).' : null,
    ].filter((line) => line !== null).join('\n'),
  );
  return data;
};
