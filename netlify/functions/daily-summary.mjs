import { db, telegram, lisbonNow, addDays, dayLabel, slotLabel, itemsLabel } from '../lib/shared.mjs';

// Runs every hour; only sends at the cutoff hour, Lisbon time (handles summer/winter time).
// At the cutoff, orders for the day "lead_days" ahead are final: this is your production list.
export default async () => {
  const supabase = db();
  const { data: s } = await supabase.from('settings').select('*').eq('id', 1).single();
  const now = lisbonNow();
  if (now.hour !== s.cutoff_hour) return;

  const day = addDays(now.date, s.lead_days);
  const { data: status } = await supabase.rpc('day_status', { p_day: day });
  if (!status?.[0]?.capacity) return; // closed day, nothing to bake

  const { data: orders } = await supabase
    .from('orders').select('*').eq('pickup_date', day).eq('status', 'paid').order('slot_hour');

  if (!orders.length) {
    await telegram(`Orders closed for ${dayLabel(day)}: no orders, nothing to bake.`);
    return;
  }

  const totals = {};
  for (const o of orders) {
    for (const [code, q] of Object.entries(o.items)) totals[code] = (totals[code] || 0) + q;
  }
  await telegram(
    [
      `Orders closed for ${dayLabel(day)}. Bake: ${itemsLabel(totals)}`,
      '',
      ...orders.map((o) =>
        `${slotLabel(o.slot_hour)}  ${itemsLabel(o.items)}  ${o.customer_name}, ${o.phone}${o.notes ? `\n   Note: ${o.notes}` : ''}`),
    ].join('\n'),
  );
};

export const config = { schedule: '0 * * * *' };
