import { db, telegram, emailOwner, lisbonNow, addDays, dayLabel, slotLabel, itemsLabel, euros } from '../lib/shared.mjs';

// Runs every hour; only sends at the cutoff hour, Lisbon time (handles summer/winter time).
// At the cutoff, orders for the day "lead_days" ahead are final: this is your production list.
export default async () => {
  const supabase = db();
  const { data: s } = await supabase.from('settings').select('*').eq('id', 1).single();
  const now = lisbonNow();
  if (now.hour !== s.cutoff_hour) return;

  const day = addDays(now.date, s.lead_days);
  const { data: status } = await supabase.rpc('day_status', { p_day: day });
  if (!(status || []).some((r) => r.capacity > 0)) return; // closed day, nothing to bake

  const { data: orders } = await supabase
    .from('orders').select('*').eq('pickup_date', day).eq('status', 'paid').order('slot_hour');

  const title = `Orders closed for ${dayLabel(day)}`;
  let text;
  if (!orders.length) {
    text = `${title}: no orders, nothing to bake.`;
  } else {
    const totals = {};
    let revenue = 0;
    for (const o of orders) {
      revenue += o.total_cents;
      for (const [code, q] of Object.entries(o.items)) totals[code] = (totals[code] || 0) + q;
    }
    text = [
      `${title}. Bake: ${itemsLabel(totals)} (${euros(revenue)} paid)`,
      '',
      ...orders.map((o) => [
        `${slotLabel(o.slot_hour)}  ${itemsLabel(o.items)}  ${euros(o.total_cents)}`,
        `   ${o.customer_name}, ${o.phone}, ${o.email}`,
        o.nif ? `   NIF ${o.nif}` : null,
        o.notes ? `   Note: ${o.notes}` : null,
      ].filter(Boolean).join('\n')),
    ].join('\n');
  }

  await Promise.allSettled([
    telegram(text),
    emailOwner(`${title}`, text).catch((err) => console.error('Summary email failed', err)),
  ]);
};

export const config = { schedule: '0 * * * *' };
