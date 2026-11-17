import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Reads a setting, tolerating stray spaces or quotes pasted in by accident
const clean = (value) => (value || '').trim().replace(/^["']|["']$/g, '').trim();
const env = (name) => {
  const value = clean(process.env[name]);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};
const optionalEnv = (name, fallback = '') => clean(process.env[name]) || fallback;

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

export const PICKUP_PUBLIC = 'Rua das Fontainhas, Alcântara';

export const euros = (cents) => `€${(cents / 100).toFixed(2).replace('.00', '')}`;

export const itemsLabel = (items) =>
  Object.entries(items).filter(([, q]) => q > 0)
    .map(([code, q]) => (q === 1 ? `Size ${code}` : `${q}× Size ${code}`)).join(', ');

// ---- Telegram ----
export const telegram = async (text) => {
  const token = optionalEnv('TELEGRAM_BOT_TOKEN').replace(/^bot/i, '');
  const chatId = optionalEnv('TELEGRAM_CHAT_ID');
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
  const booked = (status || []).map((r) => `${r.code} ${r.taken}/${r.capacity}`).join(', ');
  const over = (status || []).some((r) => r.taken > r.capacity);

  const alert = telegram(
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
      booked ? `Day booked: ${booked}` : null,
      over ? 'WARNING: this day is now over capacity (payment arrived after the hold ran out).' : null,
    ].filter((line) => line !== null).join('\n'),
  );

  const email = sendConfirmationEmail(data).catch(async (err) => {
    console.error('Confirmation email failed', err);
    await telegram(`Confirmation email to ${data.email} failed: ${err.message}`);
  });
  await Promise.allSettled([alert, email]);
  return data;
};

// ---- Customer confirmation email (sent from Gmail) ----
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const sendConfirmationEmail = async (order) => {
  const user = optionalEnv('GMAIL_USER');
  const pass = optionalEnv('GMAIL_APP_PASSWORD').replace(/\s/g, '');
  if (!user || !pass) {
    console.warn('Gmail not configured, skipping confirmation email');
    return;
  }
  const brand = optionalEnv('BRAND_NAME', 'La Tarta');
  const address = optionalEnv('PICKUP_ADDRESS', `${PICKUP_PUBLIC}, Lisboa`);
  const when = `${dayLabel(order.pickup_date)}, ${slotLabel(order.slot_hour)}`;
  const firstName = order.customer_name.split(' ')[0];
  const cakes = itemsLabel(order.items);
  const total = euros(order.total_cents);

  const text = [
    `Hi ${firstName},`,
    '',
    `Your order is confirmed. Here are the details:`,
    '',
    `Pickup: ${when}`,
    `Address: ${address}`,
    `Cake: ${cakes}`,
    `Paid: ${total}`,
    order.notes ? `Your note: ${order.notes}` : null,
    '',
    'Need to change something? Just reply to this email.',
    '',
    brand,
  ].filter((line) => line !== null).join('\n');

  const site = optionalEnv('SITE_URL', 'https://latartalisboa.com');
  const brown = '#6E3A1F';
  const soft = '#8A5A3C';
  const row = (label, value) =>
    `<tr><td style="padding:10px 16px 10px 0;color:${soft};vertical-align:top;font-size:15px;border-top:1px solid #E8DCCB;white-space:nowrap">${label}</td>` +
    `<td style="padding:10px 0;color:${brown};font-weight:700;font-size:15px;border-top:1px solid #E8DCCB">${escapeHtml(value)}</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<style>:root{color-scheme:light only;supported-color-schemes:light;}</style>
</head>
<body style="margin:0;padding:0;background:#ffffff">
  <div style="max-width:520px;margin:0 auto;padding:28px 20px;font-family:Arial,Helvetica,sans-serif;color:${brown}">
    <table role="presentation" style="border-collapse:collapse;margin:0 0 24px"><tr>
      <td style="vertical-align:middle"><img src="${site}/apple-touch-icon.png" width="44" height="44" alt="" style="display:block;border:0;border-radius:22px"></td>
      <td style="padding-left:12px;vertical-align:middle;font-size:22px;font-weight:800;color:${brown}">${escapeHtml(brand)}</td>
    </tr></table>
    <img src="${site}/email-hero.jpg" width="480" alt="A slice of ${escapeHtml(brand)} Basque cheesecake" style="display:block;width:100%;max-width:480px;height:auto;border:0;margin:0 0 24px">
    <p style="font-size:24px;font-weight:800;margin:0 0 8px;line-height:1.25;color:${brown}">Thank you, ${escapeHtml(firstName)}.<br>Your order is booked.</p>
    <p style="font-size:16px;margin:0 0 22px;color:${soft}">Here are your pickup details.</p>
    <p style="font-size:13px;letter-spacing:1px;text-transform:uppercase;margin:0 0 4px;color:${soft}">Pickup</p>
    <p style="font-size:21px;font-weight:800;margin:0 0 18px;line-height:1.3;color:${brown}">${escapeHtml(dayLabel(order.pickup_date))}<br>${escapeHtml(slotLabel(order.slot_hour))}</p>
    <table role="presentation" style="border-collapse:collapse;width:100%;border-bottom:1px solid #E8DCCB">
      ${row('Address', address)}
      ${row('Cake', cakes)}
      ${row('Paid', total)}
      ${order.notes ? row('Your note', order.notes) : ''}
    </table>
    <p style="font-size:15px;margin:24px 0 0;color:${soft}">Need to change something? Just reply to this email.</p>
    <p style="font-size:15px;margin:8px 0 0;color:${soft}">${escapeHtml(brand)} · <a href="${site}" style="color:${brown}">${site.replace('https://', '')}</a></p>
  </div>
</body></html>`;

  const nodemailer = (await import('nodemailer')).default;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  await transporter.sendMail({
    from: `"${brand}" <${user}>`,
    to: order.email,
    subject: `Your ${brand} order: ${when}`,
    text,
    html,
  });
};


// ---- Plain email to yourself (daily summary) ----
export const emailOwner = async (subject, text) => {
  const user = optionalEnv('GMAIL_USER');
  const pass = optionalEnv('GMAIL_APP_PASSWORD').replace(/\s/g, '');
  if (!user || !pass) return;
  const nodemailer = (await import('nodemailer')).default;
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transporter.sendMail({ from: `"${optionalEnv('BRAND_NAME', 'La Tarta')} orders" <${user}>`, to: user, subject, text });
};
