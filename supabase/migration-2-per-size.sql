-- La Tarta ordering: capacity per size (run once, after schema.sql)
-- Supabase: SQL Editor -> New query -> paste everything -> Run.
-- Changes: capacity is now set per size (Size S / Size L), one cake per order,
-- cake names become "Size S" and "Size L". Existing orders are kept.

-- Old versions of the capacity functions
drop function if exists get_availability();
drop function if exists day_status(date);
drop function if exists cakes_taken(date);
drop function if exists day_capacity(date);
drop function if exists reserve_order(date, int, jsonb, text, text, text, text, text);

-- ---------------------------------------------------------------
-- Usual cakes per weekday, per size (0 = closed)
-- ---------------------------------------------------------------
drop table if exists weekly_capacity;
create table weekly_capacity (
  weekday int primary key check (weekday between 0 and 6),
  day_name text not null,
  size_s int not null default 0 check (size_s >= 0),
  size_l int not null default 0 check (size_l >= 0)
);
insert into weekly_capacity (weekday, day_name, size_s, size_l) values
  (1, 'Monday', 0, 0), (2, 'Tuesday', 0, 0), (3, 'Wednesday', 2, 2), (4, 'Thursday', 2, 2),
  (5, 'Friday', 2, 2), (6, 'Saturday', 2, 2), (0, 'Sunday', 2, 2);

-- One-off changes for a specific date. To close a day: add it with size_s = 0 and size_l = 0.
drop table if exists date_overrides;
create table date_overrides (
  day date primary key,
  size_s int not null default 0 check (size_s >= 0),
  size_l int not null default 0 check (size_l >= 0),
  note text
);

alter table weekly_capacity enable row level security;
alter table date_overrides enable row level security;
grant all on weekly_capacity, date_overrides to service_role;

update settings set max_cakes_per_order = 1 where id = 1;
update products set name = 'Size S' where code = 'S';
update products set name = 'Size L' where code = 'L';

-- ---------------------------------------------------------------
-- Capacity logic, per size
-- ---------------------------------------------------------------
create or replace function day_capacity(p_day date, p_code text) returns int
language sql stable as $$
  select coalesce(
    (select case p_code when 'S' then o.size_s when 'L' then o.size_l else 0 end
       from date_overrides o where o.day = p_day),
    (select case p_code when 'S' then w.size_s when 'L' then w.size_l else 0 end
       from weekly_capacity w where w.weekday = extract(dow from p_day)::int),
    0)
$$;

-- Paid orders plus unpaid ones still being held at checkout
create or replace function cakes_taken(p_day date, p_code text) returns int
language sql stable as $$
  select coalesce(sum(coalesce((o.items ->> p_code)::int, 0)), 0)::int from orders o
  where o.pickup_date = p_day
    and (o.status = 'paid' or (o.status = 'pending' and o.hold_expires_at > now()))
$$;

create or replace function day_status(p_day date)
returns table (code text, capacity int, taken int)
language sql stable as $$
  select c, day_capacity(p_day, c), cakes_taken(p_day, c)
  from unnest(array['S', 'L']) as c
$$;

create or replace function get_availability()
returns table (day date, remaining jsonb, open boolean)
language sql stable as $$
  with days as (
    select g::date as d
    from settings s,
         generate_series(lisbon_now()::date, lisbon_now()::date + s.booking_window_days, interval '1 day') g
    where s.id = 1
  ), left_over as (
    select d,
           greatest(day_capacity(d, 'S') - cakes_taken(d, 'S'), 0) as rs,
           greatest(day_capacity(d, 'L') - cakes_taken(d, 'L'), 0) as rl
    from days
  )
  select d, jsonb_build_object('S', rs, 'L', rl), day_open_for_orders(d) and (rs + rl) > 0
  from left_over
  order by d
$$;

-- Checks everything and holds the cake in one step.
-- The lock stops two people grabbing the last cake of a size at the same moment.
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
  for v_code, v_qty in select key, value::int from jsonb_each_text(p_items) loop
    continue when v_qty = 0;
    if day_capacity(p_pickup_date, v_code) - cakes_taken(p_pickup_date, v_code) < v_qty then
      raise exception 'NOT_ENOUGH_CAPACITY';
    end if;
  end loop;

  insert into orders (pickup_date, slot_hour, items, cakes, total_cents,
                      customer_name, email, phone, nif, notes, hold_expires_at)
  values (p_pickup_date, p_slot_hour, p_items, v_cakes, v_total,
          p_customer_name, p_email, p_phone, nullif(p_nif, ''), nullif(p_notes, ''),
          now() + make_interval(mins => s.hold_minutes))
  returning id into v_id;

  return query select v_id, v_total, v_cakes;
end $$;

revoke execute on function reserve_order(date, int, jsonb, text, text, text, text, text) from public, anon, authenticated;
revoke execute on function get_availability() from public, anon, authenticated;
revoke execute on function day_status(date) from public, anon, authenticated;
grant execute on function reserve_order(date, int, jsonb, text, text, text, text, text) to service_role;
grant execute on function get_availability() to service_role;
grant execute on function day_status(date) to service_role;
grant execute on function day_capacity(date, text) to service_role;
grant execute on function cakes_taken(date, text) to service_role;
