-- BASCA ordering system: database setup
-- Run this once in Supabase: SQL Editor -> New query -> paste everything -> Run.
-- All times use Lisbon time (Europe/Lisbon), so summer/winter clock changes are handled.

-- ---------------------------------------------------------------
-- Settings you can edit in the Table Editor (one row only)
-- ---------------------------------------------------------------
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  slots_start_hour int not null default 12,    -- first pickup slot starts 12:00
  slots_end_hour int not null default 20,      -- last pickup slot ends 20:00
  cutoff_hour int not null default 18,         -- orders close at 18:00 ...
  lead_days int not null default 2,            -- ... this many days before pickup
  max_cakes_per_order int not null default 4,
  booking_window_days int not null default 28, -- how far ahead people can book
  hold_minutes int not null default 35         -- cakes held while the customer pays
);
insert into settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------
-- Products and prices (in cents: 2400 = EUR 24.00)
-- ---------------------------------------------------------------
create table if not exists products (
  code text primary key,
  name text not null,
  description text,
  price_cents int not null check (price_cents > 0),
  active boolean not null default true,
  sort int not null default 0
);
insert into products (code, name, description, price_cents, sort) values
  ('S', 'BASCA S', 'Around 1.15kg, for about 6 people', 2400, 1),
  ('L', 'BASCA L', 'Around 2.3kg, for about 12 people', 3600, 2)
on conflict (code) do nothing;

-- ---------------------------------------------------------------
-- Capacity: default cakes per weekday, plus overrides for specific dates
-- weekday: 0 = Sunday, 1 = Monday ... 6 = Saturday
-- ---------------------------------------------------------------
create table if not exists weekly_capacity (
  weekday int primary key check (weekday between 0 and 6),
  day_name text not null,
  cakes int not null default 0 check (cakes >= 0)
);
insert into weekly_capacity (weekday, day_name, cakes) values
  (1, 'Monday', 0), (2, 'Tuesday', 0), (3, 'Wednesday', 4), (4, 'Thursday', 4),
  (5, 'Friday', 4), (6, 'Saturday', 4), (0, 'Sunday', 4)
on conflict (weekday) do nothing;

-- Add a row here to close a day (cakes = 0) or change its capacity.
create table if not exists date_overrides (
  day date primary key,
  cakes int not null check (cakes >= 0),
  note text
);

-- ---------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'expired', 'cancelled', 'refunded')),
  pickup_date date not null,
  slot_hour int not null,
  items jsonb not null,          -- e.g. {"S": 1, "L": 1}
  cakes int not null check (cakes > 0),
  total_cents int not null,
  customer_name text not null,
  email text not null,
  phone text not null,
  nif text,
  notes text,
  stripe_session_id text unique,
  hold_expires_at timestamptz not null,
  paid_at timestamptz
);
create index if not exists orders_day_status on orders (pickup_date, status);

-- Lock everything down: only the website's server functions (service role) can read/write.
alter table settings enable row level security;
alter table products enable row level security;
alter table weekly_capacity enable row level security;
alter table date_overrides enable row level security;
alter table orders enable row level security;

-- ---------------------------------------------------------------
-- Capacity logic
-- ---------------------------------------------------------------
create or replace function lisbon_now() returns timestamp
language sql stable as $$ select (now() at time zone 'Europe/Lisbon') $$;

create or replace function day_capacity(p_day date) returns int
language sql stable as $$
  select coalesce(
    (select cakes from date_overrides where day = p_day),
    (select cakes from weekly_capacity where weekday = extract(dow from p_day)::int),
    0)
$$;

-- Paid orders plus unpaid ones still being held at checkout
create or replace function cakes_taken(p_day date) returns int
language sql stable as $$
  select coalesce(sum(o.cakes), 0)::int from orders o
  where o.pickup_date = p_day
    and (o.status = 'paid' or (o.status = 'pending' and o.hold_expires_at > now()))
$$;

-- Orders for day D close at cutoff_hour (Lisbon) on D minus lead_days
create or replace function day_open_for_orders(p_day date) returns boolean
language sql stable as $$
  select lisbon_now() < ((p_day - s.lead_days)::timestamp + make_interval(hours => s.cutoff_hour))
     and p_day <= lisbon_now()::date + s.booking_window_days
  from settings s where s.id = 1
$$;

create or replace function day_status(p_day date)
returns table (capacity int, taken int)
language sql stable as $$ select day_capacity(p_day), cakes_taken(p_day) $$;

create or replace function get_availability()
returns table (day date, remaining int, open boolean)
language sql stable as $$
  select d::date,
         greatest(day_capacity(d::date) - cakes_taken(d::date), 0),
         day_open_for_orders(d::date) and day_capacity(d::date) - cakes_taken(d::date) > 0
  from settings s,
       generate_series(lisbon_now()::date, lisbon_now()::date + s.booking_window_days, interval '1 day') d
  where s.id = 1
  order by 1
$$;

-- Checks everything and holds the cakes in one step.
-- The lock stops two people grabbing the last cake at the same moment.
create or replace function reserve_order(
  p_pickup_date date, p_slot_hour int, p_items jsonb,
  p_customer_name text, p_email text, p_phone text, p_nif text, p_notes text)
returns table (out_order_id uuid, out_total_cents int, out_cakes int)
language plpgsql as $$
declare
  s settings%rowtype;
  v_cakes int := 0;
  v_total int := 0;
  v_code text;
  v_qty int;
  v_price int;
  v_id uuid;
begin
  select * into s from settings where id = 1;

  for v_code, v_qty in select key, value::int from jsonb_each_text(p_items) loop
    if v_qty < 0 then raise exception 'INVALID_QTY'; end if;
    continue when v_qty = 0;
    select p.price_cents into v_price from products p where p.code = v_code and p.active;
    if v_price is null then raise exception 'UNKNOWN_PRODUCT'; end if;
    v_cakes := v_cakes + v_qty;
    v_total := v_total + v_qty * v_price;
  end loop;

  if v_cakes = 0 then raise exception 'EMPTY_ORDER'; end if;
  if v_cakes > s.max_cakes_per_order then raise exception 'TOO_MANY_CAKES'; end if;
  if p_slot_hour < s.slots_start_hour or p_slot_hour >= s.slots_end_hour then
    raise exception 'INVALID_SLOT';
  end if;

  perform pg_advisory_xact_lock(hashtext('basca-day-' || p_pickup_date::text));

  if not day_open_for_orders(p_pickup_date) then raise exception 'DAY_CLOSED'; end if;
  if day_capacity(p_pickup_date) - cakes_taken(p_pickup_date) < v_cakes then
    raise exception 'NOT_ENOUGH_CAPACITY';
  end if;

  insert into orders (pickup_date, slot_hour, items, cakes, total_cents,
                      customer_name, email, phone, nif, notes, hold_expires_at)
  values (p_pickup_date, p_slot_hour, p_items, v_cakes, v_total,
          p_customer_name, p_email, p_phone, nullif(p_nif, ''), nullif(p_notes, ''),
          now() + make_interval(mins => s.hold_minutes))
  returning id into v_id;

  return query select v_id, v_total, v_cakes;
end $$;

-- Only the server (service role) may call these
revoke execute on function reserve_order(date, int, jsonb, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function get_availability() from public, anon, authenticated;
revoke execute on function day_status(date) from public, anon, authenticated;
grant execute on function reserve_order(date, int, jsonb, text, text, text, text, text) to service_role;
grant execute on function get_availability() to service_role;
grant execute on function day_status(date) to service_role;
