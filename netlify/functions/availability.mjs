import { db, json } from '../lib/shared.mjs';

// GET /api/availability -> products, rules and which days can be booked
export default async () => {
  const supabase = db();
  const [settings, products, days] = await Promise.all([
    supabase.from('settings').select('*').eq('id', 1).single(),
    supabase.from('products').select('code,name,description,price_cents').eq('active', true).order('sort'),
    supabase.rpc('get_availability'),
  ]);
  const error = settings.error || products.error || days.error;
  if (error) {
    console.error(error);
    return json({ error: 'Could not load availability. Try again in a minute.' }, 500);
  }
  const s = settings.data;
  return json({
    rules: {
      maxCakes: s.max_cakes_per_order,
      slotsStart: s.slots_start_hour,
      slotsEnd: s.slots_end_hour,
      cutoffHour: s.cutoff_hour,
      leadDays: s.lead_days,
    },
    products: products.data,
    days: days.data.map((d) => ({ date: d.day, remaining: d.remaining, open: d.open })),
  });
};

export const config = { path: '/api/availability' };
