-- An order ships to its own name and number, and says when that number has
-- another name or a refusal was made good (2026-11-02).
--
-- Until now an order had no name, phone or address of its own: every screen
-- showed the customer record it was matched to, and a Shopify order is matched
-- on the Shopify customer, then the phone, and only fills that record's
-- blanks. So #1532, placed by one person on another customer's number, showed
-- that customer's name and address; and #1487 showed its customer's old number
-- while Shopify had the one the courier needed.
--
-- So an order now holds who it ships to: what Shopify sent, what was typed at
-- the till, or what was corrected on the order. The customer record stays the
-- person, for their history.
--
-- Two signals ride on that, for the packing queue and the order:
--  * a number used under another name says so before the parcel leaves;
--  * a refusal is shown with what came after it. #1442's customer refused
--    an L on 2026-10-21, then took and paid for an XL on W2610-00049, typed
--    under the same name on a second number. "Refused once before" on their
--    next order was true, and left that out.

alter table public.orders
  add column ship_name          text,
  add column ship_phone         text,
  add column ship_address_line1 text,
  add column ship_address_line2 text,
  add column ship_city          text,
  add column ship_governorate   text,
  -- The ship-to as Shopify last sent it. A later version from Shopify replaces
  -- the order's ship-to only when this changed, so a correction typed here
  -- survives Shopify sending the old one again with a tag or a payment.
  add column ship_from_shopify  jsonb,
  -- name_key(ship_name), kept by the trigger below so orders can be found by
  -- name without working it out for every order on every read.
  add column ship_name_key      text;

comment on column public.orders.ship_name is
  'Who this order ships to. The customer record is the person; this is the parcel.';

create index orders_ship_phone_idx on public.orders (ship_phone) where ship_phone is not null;
create index orders_ship_name_key_idx on public.orders (ship_name_key) where ship_name_key is not null;

-- --- Names -----------------------------------------------------------------

-- A name as the letters that carry it, in either script, one entry a word.
--
-- The same name is written here in Arabic and in Latin letters, and the Latin
-- spelling wanders: Mohamed, Mohmed and محمد are one name. The vowels are what
-- wander, so they go, and what is left - m h m d - is the same in all three.
-- Good enough to say two names are one person's; not a transliteration.
create or replace function public.name_tokens(p_name text)
returns text[]
language plpgsql
immutable
parallel safe
as $$
declare
  v_text text;
  v_word text;
  v_out  text[] := '{}';
begin
  if p_name is null then
    return v_out;
  end if;

  v_text := lower(p_name);
  -- The yeh and kaf a Persian keyboard types.
  v_text := translate(v_text, 'یک', 'يك');
  -- Arabic short vowels, shadda and tatweel.
  v_text := regexp_replace(v_text, '[ً-ٰٟـ]', '', 'g');
  -- Franco-Arabic: the digits that stand for letters.
  v_text := replace(replace(v_text, '5', 'kh'), '8', 'gh');
  v_text := translate(v_text, '7923', 'hs');
  -- Abdelrahman, Abd El Rahman and عبد الرحمن.
  v_text := regexp_replace(v_text, '\mabd\s*-?\s*(el|al|ul|ol)?\s*-?\s*', 'abd ', 'g');
  v_text := regexp_replace(v_text, 'عبد\s*ال', 'عبد ', 'g');
  v_text := regexp_replace(v_text, '[^a-zء-ي]+', ' ', 'g');

  foreach v_word in array regexp_split_to_array(btrim(v_text), ' ')
  loop
    continue when v_word in ('', 'el', 'al', 'ال');
    if v_word ~ '^ال' and length(v_word) > 3 then
      v_word := substr(v_word, 3);
    end if;

    -- Arabic letters with a two-letter Latin spelling, then the rest; the
    -- long vowels and the letters Latin writes as a vowel go.
    v_word := replace(replace(replace(replace(v_word, 'خ', 'kh'), 'ش', 'sh'), 'غ', 'gh'), 'ث', 'th');
    v_word := translate(v_word,
      'بتجحدذرزسصضطظفقكلمنه' || 'عةويىاأإآءئؤ',
      'btghdzrzssdtzfkklmnh');
    -- Latin: one letter for each sound, then no vowels.
    v_word := replace(v_word, 'ch', 'sh');
    v_word := translate(v_word, 'qjcxvp' || 'aeiouyw', 'kgkkfb');
    v_word := regexp_replace(v_word, '(.)\1+', '\1', 'g');
    -- Sara and Sarah, سارة and Sarah.
    if length(v_word) >= 3 and right(v_word, 1) = 'h' then
      v_word := left(v_word, -1);
    end if;

    if v_word <> '' then
      v_out := v_out || v_word;
    end if;
  end loop;

  return v_out;
end;
$$;

-- A whole name - two words or more - as one key, or null. What ties two
-- orders to one person by name alone, so one word is never enough.
create or replace function public.name_key(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select case when cardinality(t) >= 2 then array_to_string(t, ' ') end
    from (select public.name_tokens(p_name) as t) x;
$$;

-- Whether two names can be one person's: the same letters however spaced, or
-- the shorter name's words in order within the longer - a name written with
-- fewer of the father's names (حسام احمد, حسام احمد عماره محمد عماره). Order
-- counts: Ahmed Mohamed and Mohamed Ahmed are a son and a father, who may well
-- share a phone. A name missing on either side is no difference.
create or replace function public.names_match(p_a text, p_b text)
returns boolean
language plpgsql
immutable
parallel safe
as $$
declare
  v_a     text[] := public.name_tokens(p_a);
  v_b     text[] := public.name_tokens(p_b);
  v_short text[];
  v_long  text[];
  i       integer := 1;
  j       integer := 1;
begin
  if cardinality(v_a) = 0 or cardinality(v_b) = 0 then
    return true;
  end if;
  if array_to_string(v_a, '') = array_to_string(v_b, '') then
    return true;
  end if;

  if cardinality(v_a) <= cardinality(v_b) then
    v_short := v_a;
    v_long  := v_b;
  else
    v_short := v_b;
    v_long  := v_a;
  end if;

  while i <= cardinality(v_short) and j <= cardinality(v_long) loop
    if v_short[i] = v_long[j] then
      i := i + 1;
    end if;
    j := j + 1;
  end loop;

  return i > cardinality(v_short);
end;
$$;

-- --- Where an order ships ---------------------------------------------------

-- An order takes what it is not given from the customer record: the name and
-- the phone each on their own, the address only whole - half of one address
-- and half of another is nobody's. A replacement goes where the order it
-- replaces went.
create or replace function public.orders_ship_to()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers;
  v_from     public.orders;
begin
  if tg_op = 'INSERT' and new.customer_id is not null then
    select * into v_customer from public.customers where id = new.customer_id;
    new.ship_name  := coalesce(nullif(btrim(new.ship_name), ''), v_customer.full_name);
    new.ship_phone := coalesce(nullif(btrim(new.ship_phone), ''), v_customer.phone);
    if num_nonnulls(new.ship_address_line1, new.ship_address_line2,
                    new.ship_city, new.ship_governorate) = 0 then
      new.ship_address_line1 := v_customer.address_line1;
      new.ship_address_line2 := v_customer.address_line2;
      new.ship_city          := v_customer.city;
      new.ship_governorate   := v_customer.governorate;
    end if;
  end if;

  -- create_exchange makes the replacement as a sale, then links it.
  if new.exchange_for_order_id is not null
     and (tg_op = 'INSERT' or new.exchange_for_order_id is distinct from old.exchange_for_order_id)
  then
    select * into v_from from public.orders where id = new.exchange_for_order_id;
    if found then
      new.ship_name          := v_from.ship_name;
      new.ship_phone         := v_from.ship_phone;
      new.ship_address_line1 := v_from.ship_address_line1;
      new.ship_address_line2 := v_from.ship_address_line2;
      new.ship_city          := v_from.ship_city;
      new.ship_governorate   := v_from.ship_governorate;
    end if;
  end if;

  new.ship_name     := nullif(btrim(new.ship_name), '');
  new.ship_phone    := public.normalize_eg_phone(nullif(btrim(new.ship_phone), ''));
  new.ship_name_key := public.name_key(new.ship_name);
  return new;
end;
$$;

create trigger orders_ship_to_trg
  before insert or update of ship_name, ship_phone, exchange_for_order_id on public.orders
  for each row execute function public.orders_ship_to();

-- Who a Shopify order ships to, from its payload. The phone is found the way
-- upsert_shopify_customer finds it: the shipping address one is what the
-- courier will call.
create or replace function public.shopify_ship_to(p_payload jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'name', coalesce(
      nullif(btrim(concat_ws(' ', a ->> 'first_name', a ->> 'last_name')), ''),
      nullif(btrim(a ->> 'name'), ''),
      nullif(btrim(concat_ws(' ', cu ->> 'first_name', cu ->> 'last_name')), '')),
    'phone', public.normalize_eg_phone(coalesce(
      nullif(a ->> 'phone', ''), nullif(p_payload ->> 'phone', ''), nullif(cu ->> 'phone', ''))),
    'address_line1', nullif(btrim(a ->> 'address1'), ''),
    'address_line2', nullif(btrim(a ->> 'address2'), ''),
    'city',          nullif(btrim(a ->> 'city'), ''),
    'governorate',   nullif(btrim(a ->> 'province'), '')
  ))
  from (
    select coalesce(p_payload -> 'shipping_address', p_payload -> 'billing_address', '{}'::jsonb) as a,
           coalesce(p_payload -> 'customer', '{}'::jsonb) as cu
  ) x;
$$;

-- Take Shopify's ship-to onto an order, when it is not the one taken last
-- time. What Shopify leaves out comes from the customer record, as on a new
-- order.
create or replace function public.take_shopify_ship_to(p_order_id uuid, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ship jsonb := public.shopify_ship_to(p_payload);
begin
  update public.orders o
     set ship_name          = coalesce(v_ship ->> 'name', c.full_name),
         ship_phone         = coalesce(v_ship ->> 'phone', c.phone),
         ship_address_line1 = case when v_ship ?| array['address_line1', 'address_line2', 'city', 'governorate']
                                   then v_ship ->> 'address_line1' else c.address_line1 end,
         ship_address_line2 = case when v_ship ?| array['address_line1', 'address_line2', 'city', 'governorate']
                                   then v_ship ->> 'address_line2' else c.address_line2 end,
         ship_city          = case when v_ship ?| array['address_line1', 'address_line2', 'city', 'governorate']
                                   then v_ship ->> 'city' else c.city end,
         ship_governorate   = case when v_ship ?| array['address_line1', 'address_line2', 'city', 'governorate']
                                   then v_ship ->> 'governorate' else c.governorate end,
         ship_from_shopify  = v_ship
    from public.orders o2
    left join public.customers c on c.id = o2.customer_id
   where o2.id = o.id
     and o.id = p_order_id
     and o.ship_from_shopify is distinct from v_ship;
end;
$$;

-- --- What the orders already here ship to ----------------------------------

-- Backfilling touches every order; its updated_at is when a person last
-- changed it, so it stays.
alter table public.orders disable trigger orders_touch_updated_at;

-- A Shopify order: what Shopify last sent for it. Checked against production
-- before writing this: every Shopify order has a payload, and none of the
-- twelve that differ from their customer record was corrected by hand - each
-- difference is an earlier order's details, or a later edit in Shopify.
select public.take_shopify_ship_to(o.id, l.payload)
  from public.orders o
  join (
    select distinct on (we.payload ->> 'id') we.payload ->> 'id' as shopify_id, we.payload
      from public.webhook_events we
     where we.topic like 'orders/%' and we.payload ? 'id'
     order by we.payload ->> 'id', we.received_at desc
  ) l on l.shopify_id = o.shopify_order_id::text;

-- Everything else, and what Shopify left out: the customer record, which is
-- what these orders showed until now.
update public.orders o
   set ship_name          = coalesce(o.ship_name, c.full_name),
       ship_phone         = coalesce(o.ship_phone, c.phone),
       ship_address_line1 = case when num_nonnulls(o.ship_address_line1, o.ship_address_line2, o.ship_city, o.ship_governorate) = 0
                                 then c.address_line1 else o.ship_address_line1 end,
       ship_address_line2 = case when num_nonnulls(o.ship_address_line1, o.ship_address_line2, o.ship_city, o.ship_governorate) = 0
                                 then c.address_line2 else o.ship_address_line2 end,
       ship_city          = case when num_nonnulls(o.ship_address_line1, o.ship_address_line2, o.ship_city, o.ship_governorate) = 0
                                 then c.city else o.ship_city end,
       ship_governorate   = case when num_nonnulls(o.ship_address_line1, o.ship_address_line2, o.ship_city, o.ship_governorate) = 0
                                 then c.governorate else o.ship_governorate end
  from public.customers c
 where c.id = o.customer_id
   and (o.ship_name is null or o.ship_phone is null
        or num_nonnulls(o.ship_address_line1, o.ship_address_line2, o.ship_city, o.ship_governorate) = 0);

alter table public.orders enable trigger orders_touch_updated_at;

-- --- Correcting it ----------------------------------------------------------

-- The editor's name, phone and address now change this order, not the
-- customer record. Changing the record rewrote every order that person ever
-- placed, and is how one order's name could become another's.
create or replace function public.update_order_ship_to(
  p_order_id      uuid,
  p_name          text,
  p_phone         text,
  p_address_line1 text,
  p_address_line2 text,
  p_city          text,
  p_governorate   text
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  public.orders;
  v_before jsonb;
  v_after  jsonb;
begin
  if not (public.is_admin()
          or public.has_permission('orders.edit')
          or public.is_service_request()) then
    raise exception 'Not allowed to edit an order'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Unknown order %', p_order_id using errcode = 'no_data_found';
  end if;

  if v_order.cancelled_at is not null then
    raise exception 'Order % was cancelled and cannot be edited', v_order.order_number
      using errcode = 'check_violation', hint = 'order_cancelled';
  end if;

  v_before := jsonb_build_object(
    'name', v_order.ship_name, 'phone', v_order.ship_phone,
    'address_line1', v_order.ship_address_line1, 'address_line2', v_order.ship_address_line2,
    'city', v_order.ship_city, 'governorate', v_order.ship_governorate);

  update public.orders
     set ship_name          = nullif(btrim(p_name), ''),
         ship_phone         = nullif(btrim(p_phone), ''),
         ship_address_line1 = nullif(btrim(p_address_line1), ''),
         ship_address_line2 = nullif(btrim(p_address_line2), ''),
         ship_city          = nullif(btrim(p_city), ''),
         ship_governorate   = nullif(btrim(p_governorate), '')
   where id = p_order_id
  returning * into v_order;

  v_after := jsonb_build_object(
    'name', v_order.ship_name, 'phone', v_order.ship_phone,
    'address_line1', v_order.ship_address_line1, 'address_line2', v_order.ship_address_line2,
    'city', v_order.ship_city, 'governorate', v_order.ship_governorate);

  if v_after is distinct from v_before then
    insert into public.order_events (order_id, event_type, details, staff_id)
    values (p_order_id, 'ship_to_edited',
            jsonb_build_object('from', jsonb_strip_nulls(v_before), 'to', jsonb_strip_nulls(v_after)),
            auth.uid());
  end if;

  return v_order;
end;
$$;

-- --- What is worth knowing about who it ships to ----------------------------

-- How an order ended, for the customer: 'refused', 'received', or null while
-- it has not ended (or ended in a way that says nothing about them).
--
-- Refused: came back from the door, the whole of it, unless the courier ran
-- out of time or the piece was ours to blame (the wrong one, or faulty).
-- Received: taken - paid at the door, or on the tab - including a refusal
-- that kept something (#1497 kept the L) and what came back later.
--
-- The badge on an order and the customers report both read this, so they
-- cannot disagree.
create or replace function public.order_outcome(p_order_id uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
           when o.fulfillment_status in ('returned', 'delivery_failed', 'return_in_transit')
                and exists (
                  select 1 from public.returns r
                   where r.order_id = o.id
                     and r.type = 'failed_delivery'
                     and coalesce(r.reason::text, '') not in ('delivery_timeout', 'wrong_item_sent', 'faulty'))
             then 'refused'
           when o.fulfillment_status = 'delivered'
                or (o.fulfillment_status = 'returned'
                    and not exists (select 1 from public.returns r
                                     where r.order_id = o.id and r.type = 'failed_delivery'))
             then 'received'
         end
    from public.orders o
   where o.id = p_order_id;
$$;

-- The orders that are one person's: on their customer record, sent to one of
-- their numbers, or under their whole name - but a name only when it has
-- been used with at most two numbers: a name on two numbers is one person
-- with two phones; "Mohamed Ahmed" on seven is seven people. Each order says
-- how it was tied, so a person can judge the tie.
create or replace function public.person_orders(p_customer_id uuid, p_phones text[], p_name_key text)
returns table (order_id uuid, order_number text, created_at timestamptz, via text, name text, phone text)
language sql
stable
set search_path = public, pg_temp
as $$
  with name_tie as (
    select p_name_key as name_key
     where p_name_key is not null
       and (select count(distinct coalesce(o.ship_phone, c.phone))
              from public.orders o
              left join public.customers c on c.id = o.customer_id
             where o.ship_name_key = p_name_key) <= 2
  )
  select o.id, o.order_number, o.created_at,
         case
           when o.customer_id = p_customer_id then 'customer'
           when coalesce(o.ship_phone, c.phone) = any (p_phones) or c.phone = any (p_phones) then 'phone'
           else 'name'
         end,
         o.ship_name,
         coalesce(o.ship_phone, c.phone)
    from public.orders o
    left join public.customers c on c.id = o.customer_id
   where o.customer_id = p_customer_id
      or coalesce(o.ship_phone, c.phone) = any (p_phones)
      or c.phone = any (p_phones)
      or o.ship_name_key = (select name_key from name_tie);
$$;

-- The person's other orders, how each ended, and the names this order's
-- number has gone under.
create or replace function public.order_customer_signals(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select o.id, o.customer_id, o.ship_name, o.ship_name_key,
           coalesce(o.ship_phone, c.phone) as phone, c.phone as customer_phone
      from public.orders o
      left join public.customers c on c.id = o.customer_id
     where o.id = p_order_id
       and (public.is_staff() or public.is_service_request())
  ),
  ended as (
    select p.*, public.order_outcome(p.order_id) as outcome
      from me
      cross join lateral public.person_orders(me.customer_id, array[me.phone, me.customer_phone], me.ship_name_key) p
     where p.order_id <> me.id
  ),
  same_number as (
    select o.order_number, o.ship_name as name, o.created_at
      from me
      join public.orders o on o.id <> me.id and o.ship_phone = me.phone
    union all
    select null, c.full_name, c.created_at
      from me
      join public.customers c on c.phone = me.phone
  ),
  other_names as (
    select (array_agg(s.name order by s.created_at desc))[1] as name,
           coalesce(jsonb_agg(s.order_number order by s.created_at)
                      filter (where s.order_number is not null), '[]'::jsonb) as orders
      from me
      join same_number s on s.name is not null and not public.names_match(s.name, me.ship_name)
     group by array_to_string(public.name_tokens(s.name), ' ')
  )
  select jsonb_build_object(
    'refused',  (select count(*) from ended where outcome = 'refused'),
    'received', (select count(*) from ended where outcome = 'received'),
    -- Taken after the last refusal: a refusal made good.
    'received_since_refusal', (
      select count(*) from ended e
       where e.outcome = 'received'
         and e.created_at > (select max(x.created_at) from ended x where x.outcome = 'refused')),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
               'order_number', e.order_number, 'outcome', e.outcome, 'via', e.via,
               'name', e.name, 'phone', e.phone) order by e.created_at)
        from ended e
       where e.outcome is not null), '[]'::jsonb),
    'other_names', coalesce((
      select jsonb_agg(jsonb_build_object('name', n.name, 'orders', n.orders) order by n.name)
        from other_names n), '[]'::jsonb)
  )
  from me;
$$;

revoke execute on function public.name_tokens(text) from public, anon;
grant execute on function public.name_tokens(text) to authenticated, service_role;
revoke execute on function public.name_key(text) from public, anon;
grant execute on function public.name_key(text) to authenticated, service_role;
revoke execute on function public.names_match(text, text) from public, anon;
grant execute on function public.names_match(text, text) to authenticated, service_role;
revoke execute on function public.shopify_ship_to(jsonb) from public, anon;
grant execute on function public.shopify_ship_to(jsonb) to authenticated, service_role;
revoke execute on function public.take_shopify_ship_to(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.take_shopify_ship_to(uuid, jsonb) to service_role;
revoke execute on function public.update_order_ship_to(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.update_order_ship_to(uuid, text, text, text, text, text, text) to authenticated, service_role;
revoke execute on function public.order_outcome(uuid) from public, anon;
grant execute on function public.order_outcome(uuid) to authenticated, service_role;
revoke execute on function public.person_orders(uuid, text[], text) from public, anon;
grant execute on function public.person_orders(uuid, text[], text) to authenticated, service_role;
revoke execute on function public.order_customer_signals(uuid) from public, anon;
grant execute on function public.order_customer_signals(uuid) to authenticated, service_role;

-- --- Every screen shows the order's ship-to ---------------------------------
--
-- The definitions below are the ones in place, with the customer record's
-- name, phone and address read from the order first. The customer record is
-- still the fallback, for a field the order never had.

create or replace view public.v_awaiting_settlement
with (security_invoker = on) as
SELECT o.id AS order_id,
    o.order_number,
    o.fulfillment_status,
    o.total_egp,
    o.shipping_egp,
    s.tracking_number,
    s.cod_amount_egp,
    s.delivered_at,
    s.returned_at,
    COALESCE(s.delivered_at, s.returned_at, s.handed_over_at) AS settled_from,
    EXTRACT(epoch FROM now() - COALESCE(s.delivered_at, s.returned_at, s.handed_over_at)) / 86400::numeric AS days_waiting,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_governorate, c.governorate) AS governorate
   FROM orders o
     JOIN shipments s ON s.order_id = o.id AND s.direction = 'outbound'::shipment_direction
     LEFT JOIN customers c ON c.id = o.customer_id
  WHERE (o.fulfillment_status = ANY (ARRAY['delivered'::fulfillment_status, 'returned'::fulfillment_status])) AND o.payment_status = 'pending'::payment_status AND s.courier <> 'own'::text AND s.status <> 'cancelled'::shipment_status AND NOT (EXISTS ( SELECT 1
           FROM settlement_lines sl
          WHERE sl.order_id = o.id));

create or replace view public.v_courier_custody
with (security_invoker = on) as
SELECT s.id AS shipment_id,
    s.tracking_number,
    s.courier,
    s.status,
    s.direction,
    s.handed_over_at,
    s.cod_amount_egp,
    o.id AS order_id,
    o.order_number,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    EXTRACT(epoch FROM now() - s.handed_over_at) / 86400::numeric AS days_in_custody,
    ( SELECT COALESCE(sum(li.quantity), 0::bigint) AS "coalesce"
           FROM order_line_items li
          WHERE li.order_id = o.id) AS units_out
   FROM shipments s
     JOIN orders o ON o.id = s.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
  WHERE s.handed_over_at IS NOT NULL AND s.courier <> 'own'::text AND (s.status = ANY (ARRAY['in_transit'::shipment_status, 'out_for_delivery'::shipment_status, 'delivery_failed'::shipment_status, 'return_in_transit'::shipment_status]));

create or replace view public.v_log
with (security_invoker = on) as
SELECT 'stock'::text AS kind,
    m.id,
    m.created_at,
    (m.created_at AT TIME ZONE 'Africa/Cairo'::text)::date AS activity_date,
    st.full_name AS staff_name,
    m.reason::text AS action,
    NULL::text AS event_type,
    NULL::text AS from_status,
    m.quantity_delta,
    m.variant_id,
    v.sku,
    p.title AS product_title,
    NULLIF(concat_ws(' / '::text, v.size, v.color), ''::text) AS variant_label,
    l.name AS location_name,
    m.note,
    m.reference_type,
    ord.id AS order_id,
    ord.order_number,
    ord.channel AS order_channel,
    ord.customer_name,
    so.taken_by,
    so.reason::text AS taken_out_reason,
    so.reason_text AS taken_out_reason_text,
    concat_ws(' '::text, v.sku, p.title, v.size, v.color, ord.order_number, ord.customer_name, st.full_name, m.note, so.taken_by, so.reason_text, so.note) AS search_text,
    so.note AS taken_out_note
   FROM stock_movements m
     LEFT JOIN variants v ON v.id = m.variant_id
     LEFT JOIN products p ON p.id = v.product_id
     LEFT JOIN staff st ON st.id = m.staff_id
     LEFT JOIN locations l ON l.id = m.location_id
     LEFT JOIN LATERAL ( SELECT o.id,
            o.order_number,
            o.channel::text AS channel,
            COALESCE(o.ship_name, c.full_name) AS customer_name
           FROM orders o
             LEFT JOIN customers c ON c.id = o.customer_id
          WHERE o.id =
                CASE
                    WHEN (m.reference_type = ANY (ARRAY['order'::text, 'order_cancellation'::text])) AND m.reference_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text THEN m.reference_id::uuid
                    WHEN m.reference_type = 'return'::text AND m.reference_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text THEN ( SELECT r.order_id
                       FROM returns r
                      WHERE r.id = m.reference_id::uuid)
                    ELSE NULL::uuid
                END OR o.shopify_order_id =
                CASE
                    WHEN (m.reference_type = ANY (ARRAY['shopify_order'::text, 'shopify_order_edit'::text, 'pre_crm_cleanup'::text])) AND m.reference_id ~ '^[0-9]{1,18}$'::text THEN m.reference_id::bigint
                    ELSE NULL::bigint
                END
         LIMIT 1) ord ON true
     LEFT JOIN stock_outs so ON m.reference_type = 'stock_out'::text AND so.id =
        CASE
            WHEN m.reference_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text THEN m.reference_id::uuid
            ELSE NULL::uuid
        END
UNION ALL
 SELECT 'order'::text AS kind,
    e.id,
    e.created_at,
    (e.created_at AT TIME ZONE 'Africa/Cairo'::text)::date AS activity_date,
    st.full_name AS staff_name,
    COALESCE(e.to_fulfillment::text, e.to_payment::text, e.event_type) AS action,
    e.event_type,
    COALESCE(e.from_fulfillment::text, e.from_payment::text) AS from_status,
    NULL::integer AS quantity_delta,
    NULL::uuid AS variant_id,
    NULL::text AS sku,
    NULL::text AS product_title,
    NULL::text AS variant_label,
    NULL::text AS location_name,
    e.note,
    NULL::text AS reference_type,
    o.id AS order_id,
    o.order_number,
    o.channel::text AS order_channel,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    NULL::text AS taken_by,
    NULL::text AS taken_out_reason,
    NULL::text AS taken_out_reason_text,
    concat_ws(' '::text, o.order_number, o.ship_name, o.ship_phone, c.full_name, c.phone, st.full_name, e.note) AS search_text,
    NULL::text AS taken_out_note
   FROM order_events e
     JOIN orders o ON o.id = e.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN staff st ON st.id = e.staff_id;

create or replace view public.v_order_list
with (security_invoker = on) as
SELECT o.id,
    o.order_number,
    o.channel,
    o.created_at,
    o.fulfillment_status,
    o.payment_status,
    o.payment_method,
    o.subtotal_egp,
    o.discount_egp,
    o.shipping_egp,
    o.total_egp,
    o.cancelled_at,
    o.note,
    o.customer_id,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_phone, c.phone) AS customer_phone,
    NULLIF(concat_ws('، '::text, NULLIF(TRIM(BOTH FROM COALESCE(o.ship_address_line1, c.address_line1)), ''::text), NULLIF(TRIM(BOTH FROM COALESCE(o.ship_address_line2, c.address_line2)), ''::text), NULLIF(TRIM(BOTH FROM COALESCE(o.ship_city, c.city)), ''::text), NULLIF(TRIM(BOTH FROM COALESCE(o.ship_governorate, c.governorate)), ''::text)), ''::text) AS customer_address,
    s.id AS shipment_id,
    s.tracking_number,
    s.courier,
    s.driver_name,
    s.status AS shipment_status,
    s.handed_over_at,
    s.delivered_at,
    s.cod_amount_egp,
    COALESCE(li.lines, '[]'::jsonb) AS items,
    COALESCE(li.unit_count, 0) AS unit_count,
        CASE
            WHEN o.cancelled_at IS NOT NULL OR o.fulfillment_status = 'cancelled'::fulfillment_status THEN 'cancelled'::text
            WHEN o.fulfillment_status = ANY (ARRAY['awaiting_confirmation'::fulfillment_status, 'confirmed'::fulfillment_status, 'ready_to_pack'::fulfillment_status, 'packed'::fulfillment_status, 'awaiting_pickup'::fulfillment_status]) THEN 'to_ship'::text
            WHEN o.fulfillment_status = ANY (ARRAY['in_transit'::fulfillment_status, 'out_for_delivery'::fulfillment_status]) THEN 'on_the_road'::text
            WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN 'delivered'::text
            ELSE 'back'::text
        END AS stage,
    COALESCE(
        CASE
            WHEN o.fulfillment_status = ANY (ARRAY['in_transit'::fulfillment_status, 'out_for_delivery'::fulfillment_status]) THEN s.handed_over_at
            ELSE NULL::timestamp with time zone
        END, ( SELECT max(e.created_at) AS max
           FROM order_events e
          WHERE e.order_id = o.id AND e.to_fulfillment = o.fulfillment_status), o.created_at) AS stage_since,
    o.shopify_order_id,
    (EXISTS ( SELECT 1
           FROM shopify_order_outbox q
          WHERE q.order_id = o.id)) AS shopify_pending,
    o.exchange_for_order_id,
    ( SELECT x.order_number
           FROM orders x
          WHERE x.id = o.exchange_for_order_id) AS exchange_for_order_number,
    o.exchange_refund_egp,
    o.exchange_refunded_at,
    ( SELECT string_agg(x.order_number, '، '::text ORDER BY x.created_at) AS string_agg
           FROM orders x
          WHERE x.exchange_for_order_id = o.id AND x.cancelled_at IS NULL) AS exchanged_in,
    o.cancelled_at IS NOT NULL OR o.fulfillment_status = 'cancelled'::fulfillment_status OR (o.fulfillment_status = ANY (ARRAY['delivered'::fulfillment_status, 'returned'::fulfillment_status])) AND (o.fulfillment_status = 'returned'::fulfillment_status OR (o.payment_status = ANY (ARRAY['paid'::payment_status, 'refunded'::payment_status, 'partially_refunded'::payment_status]))) AND NOT (o.exchange_refund_egp > 0::numeric AND o.exchange_refunded_at IS NULL) AND NOT (EXISTS ( SELECT 1
           FROM returns r
          WHERE r.order_id = o.id AND ((r.status = ANY (ARRAY['expected'::return_status, 'in_transit'::return_status, 'discrepancy'::return_status])) OR r.refund_egp > 0::numeric AND r.refunded_at IS NULL))) AS is_closed,
    COALESCE(o.ship_governorate, c.governorate) AS customer_governorate,
        CASE
            WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN order_returned_off_egp(o.id)
            ELSE 0::numeric
        END AS returned_off_egp,
    COALESCE(( SELECT sum(r.refund_egp) AS sum
           FROM returns r
          WHERE r.order_id = o.id AND r.refunded_at IS NULL), 0::numeric) AS return_refund_owed_egp,
    COALESCE(( SELECT sum(r.refund_egp) AS sum
           FROM returns r
          WHERE r.order_id = o.id AND r.refunded_at IS NOT NULL), 0::numeric) AS return_refunded_egp
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL ( SELECT sh.id,
            sh.order_id,
            sh.courier,
            sh.tracking_number,
            sh.direction,
            sh.status,
            sh.collects_return,
            sh.zone,
            sh.subzone,
            sh.service_type,
            sh.cod_amount_egp,
            sh.handed_over_at,
            sh.delivered_at,
            sh.failed_at,
            sh.returned_at,
            sh.last_tracked_at,
            sh.note,
            sh.created_at,
            sh.updated_at,
            sh.driver_name
           FROM shipments sh
          WHERE sh.order_id = o.id AND sh.direction = 'outbound'::shipment_direction AND sh.status <> 'cancelled'::shipment_status
          ORDER BY sh.created_at DESC
         LIMIT 1) s ON true
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('sku', l.sku, 'title', l.title, 'variant_title', l.variant_title, 'quantity', l.quantity, 'unit_price_egp', l.unit_price_egp, 'total_egp', l.total_egp, 'returned', ( SELECT COALESCE(sum(rl.quantity_expected), 0::bigint) AS "coalesce"
                   FROM return_lines rl
                     JOIN returns r ON r.id = rl.return_id
                  WHERE rl.order_line_item_id = l.id AND r.type <> 'exchange'::return_type AND (r.status = ANY (ARRAY['received'::return_status, 'discrepancy'::return_status, 'closed'::return_status])))) ORDER BY l.created_at) AS lines,
            sum(l.quantity)::integer AS unit_count
           FROM order_line_items l
          WHERE l.order_id = o.id) li ON true
  WHERE o.archived_at IS NULL;

create or replace view public.v_packing_queue
with (security_invoker = on) as
SELECT o.id AS order_id,
    o.order_number,
    o.channel,
    o.fulfillment_status,
    o.payment_status,
    o.payment_method,
    o.total_egp,
    o.shipping_egp,
    o.note,
    o.created_at,
    o.hold_until,
    o.confirmation_outcome,
    o.confirmation_attempts,
    c.id AS customer_id,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_phone, c.phone) AS customer_phone,
    COALESCE(o.ship_address_line1, c.address_line1) AS address_line1,
    COALESCE(o.ship_city, c.city) AS city,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    c.requires_prepayment,
    EXTRACT(epoch FROM now() - o.created_at) / 3600::numeric AS age_hours,
    ( SELECT COALESCE(sum(li.quantity), 0::bigint) AS "coalesce"
           FROM order_line_items li
          WHERE li.order_id = o.id) AS unit_count,
    ( SELECT string_agg((li.sku || ' x'::text) || li.quantity, ', '::text ORDER BY li.created_at) AS string_agg
           FROM order_line_items li
          WHERE li.order_id = o.id) AS items,
    s.id AS shipment_id,
    s.tracking_number,
    s.cod_amount_egp,
    ( SELECT count(*) AS count
           FROM returns r
             JOIN orders o2 ON o2.id = r.order_id
          WHERE o2.customer_id = c.id AND r.type = 'failed_delivery'::return_type) AS customer_prior_refusals,
    s.courier,
    s.driver_name,
    s.handed_over_at,
    ( SELECT x.order_number
           FROM orders x
          WHERE x.id = o.exchange_for_order_id) AS exchange_for_order_number,
    ( SELECT string_agg((rl.sku || ' x'::text) || rl.quantity_expected, ', '::text ORDER BY rl.created_at) AS string_agg
           FROM returns r
             JOIN return_lines rl ON rl.return_id = r.id
          WHERE r.replacement_order_id = o.id AND r.type = 'exchange'::return_type AND (r.status = ANY (ARRAY['expected'::return_status, 'in_transit'::return_status]))) AS exchange_collect_items,
    o.shopify_order_id,
    order_customer_signals(o.id) AS customer_signals
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL ( SELECT sh.id,
            sh.order_id,
            sh.courier,
            sh.tracking_number,
            sh.direction,
            sh.status,
            sh.collects_return,
            sh.zone,
            sh.subzone,
            sh.service_type,
            sh.cod_amount_egp,
            sh.handed_over_at,
            sh.delivered_at,
            sh.failed_at,
            sh.returned_at,
            sh.last_tracked_at,
            sh.note,
            sh.created_at,
            sh.updated_at,
            sh.driver_name
           FROM shipments sh
          WHERE sh.order_id = o.id AND sh.direction = 'outbound'::shipment_direction
          ORDER BY sh.created_at DESC
         LIMIT 1) s ON true
  WHERE ((o.fulfillment_status = ANY (ARRAY['awaiting_confirmation'::fulfillment_status, 'confirmed'::fulfillment_status, 'ready_to_pack'::fulfillment_status, 'packed'::fulfillment_status, 'awaiting_pickup'::fulfillment_status])) OR o.fulfillment_status = 'out_for_delivery'::fulfillment_status AND s.courier = 'own'::text) AND (o.hold_until IS NULL OR o.hold_until <= CURRENT_DATE);

create or replace view public.v_return_discrepancies
with (security_invoker = on) as
SELECT r.id AS return_id,
    r.status,
    r.reason,
    r.received_at,
    o.order_number,
    s.tracking_number,
    rl.sku,
    rl.quantity_expected,
    rl.quantity_received,
    rl.quantity_missing,
    rl.condition_note,
    COALESCE(o.ship_name, c.full_name) AS customer_name
   FROM return_lines rl
     JOIN returns r ON r.id = rl.return_id
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN shipments s ON s.id = r.outbound_shipment_id
     LEFT JOIN customers c ON c.id = o.customer_id
  WHERE rl.quantity_missing > 0;

create or replace view public.v_returnable_orders
with (security_invoker = on) as
SELECT o.id AS order_id,
    o.order_number,
    o.channel,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_phone, c.phone) AS customer_phone,
    COALESCE(s.delivered_at, o.created_at) AS delivered_at,
    ( SELECT string_agg((li.sku || ' x'::text) || li.quantity, ', '::text ORDER BY li.created_at) AS string_agg
           FROM order_line_items li
          WHERE li.order_id = o.id) AS items
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL ( SELECT sh.delivered_at
           FROM shipments sh
          WHERE sh.order_id = o.id AND sh.direction = 'outbound'::shipment_direction
          ORDER BY sh.created_at DESC
         LIMIT 1) s ON true
  WHERE o.fulfillment_status = 'delivered'::fulfillment_status AND COALESCE(s.delivered_at, o.created_at) > (now() - '30 days'::interval) AND NOT (EXISTS ( SELECT 1
           FROM returns r
          WHERE r.order_id = o.id AND r.status <> 'closed'::return_status));

create or replace view public.v_returns_inbound
with (security_invoker = on) as
SELECT r.id AS return_id,
    r.type,
    r.reason,
    r.status,
    r.courier_reported_at,
    o.id AS order_id,
    o.order_number,
    o.payment_method,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_phone, c.phone) AS customer_phone,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    s.tracking_number,
    EXTRACT(epoch FROM now() - COALESCE(r.courier_reported_at, r.created_at)) / 86400::numeric AS days_since_reported,
    ( SELECT COALESCE(sum(rl.quantity_expected), 0::bigint) AS "coalesce"
           FROM return_lines rl
          WHERE rl.return_id = r.id) AS units_expected,
    ( SELECT string_agg((rl.sku || ' x'::text) || rl.quantity_expected, ', '::text ORDER BY rl.created_at) AS string_agg
           FROM return_lines rl
          WHERE rl.return_id = r.id) AS items
   FROM returns r
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL ( SELECT sh.tracking_number
           FROM shipments sh
          WHERE sh.id = r.outbound_shipment_id OR r.type = 'exchange'::return_type AND sh.order_id = r.replacement_order_id AND sh.direction = 'outbound'::shipment_direction
          ORDER BY sh.created_at DESC
         LIMIT 1) s ON true
  WHERE r.status = ANY (ARRAY['expected'::return_status, 'in_transit'::return_status]);

create or replace view public.v_settlement_statement
with (security_invoker = on) as
SELECT s.id AS settlement_id,
    s.reference,
    s.received_at,
    s.status,
    sl.id AS line_id,
    sl.tracking_number,
    sl.outcome,
    sl.collected_egp,
    sl.fee_egp,
    sl.net_egp,
    o.order_number,
    COALESCE(o.ship_name, c.full_name) AS customer_name,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    ( SELECT string_agg((li.title || ' ×'::text) || li.quantity, ', '::text ORDER BY li.title) AS string_agg
           FROM order_line_items li
          WHERE li.order_id = sl.order_id) AS items,
    sl.note,
    sl.order_id,
    o.fulfillment_status AS order_status,
        CASE
            WHEN o.id IS NULL THEN NULL::text
            WHEN sl.outcome = 'delivered'::settlement_outcome THEN
            CASE
                WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN NULL::text
                WHEN o.fulfillment_status = ANY (ARRAY['returned'::fulfillment_status, 'return_in_transit'::fulfillment_status]) THEN 'crm_returned'::text
                ELSE 'crm_not_delivered'::text
            END
            WHEN sl.outcome = ANY (ARRAY['returned_refused'::settlement_outcome, 'returned_no_response'::settlement_outcome, 'returned_other'::settlement_outcome]) THEN
            CASE
                WHEN o.fulfillment_status = ANY (ARRAY['returned'::fulfillment_status, 'cancelled'::fulfillment_status]) THEN NULL::text
                WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN 'crm_delivered'::text
                ELSE 'not_back'::text
            END
            ELSE NULL::text
        END AS mismatch,
    sl.marked_paid,
    sl.customer_shipping_egp,
        CASE
            WHEN sl.outcome = 'delivered'::settlement_outcome AND sl.customer_shipping_egp > 0::numeric THEN sl.customer_shipping_egp - sl.fee_egp
            ELSE NULL::numeric
        END AS shipping_gain_egp
   FROM courier_settlements s
     JOIN settlement_lines sl ON sl.settlement_id = s.id
     LEFT JOIN orders o ON o.id = sl.order_id
     LEFT JOIN customers c ON c.id = o.customer_id;

create or replace view public.v_unsettled_orders
with (security_invoker = on) as
SELECT o.id AS order_id,
    o.order_number,
    o.total_egp,
    o.shipping_egp,
    o.payment_method,
    s.tracking_number,
    s.delivered_at,
    s.cod_amount_egp,
    EXTRACT(epoch FROM now() - COALESCE(s.delivered_at, s.handed_over_at)) / 86400::numeric AS days_since_delivery,
    COALESCE(o.ship_name, c.full_name) AS customer_name
   FROM orders o
     JOIN shipments s ON s.order_id = o.id AND s.direction = 'outbound'::shipment_direction
     LEFT JOIN customers c ON c.id = o.customer_id
  WHERE o.payment_status = 'pending'::payment_status AND o.fulfillment_status = 'delivered'::fulfillment_status;

-- --- The reports read the same -------------------------------------------------
--
-- An area is where the parcel went: the order's governorate. And an order's
-- outcome is what its status says - #1497, where the customer kept the L and
-- sent back the XL, is a delivery, not a refusal; #1463, one piece back with
-- the rest kept, is a delivery too. The pieces that came back are in the
-- returns report. Every parcel that came back whole still counts against the
-- refusal rate, whoever's fault it was: it cost a run either way.

create or replace view public.v_report_orders
with (security_invoker = on) as
SELECT o.id AS order_id,
    o.order_number,
    (o.created_at AT TIME ZONE 'Africa/Cairo'::text)::date AS placed_on,
    o.channel::text AS channel,
    o.payment_method::text AS payment_method,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    o.customer_id,
    c.full_name AS customer_name,
    c.phone AS customer_phone,
    o.exchange_for_order_id IS NOT NULL AS is_exchange,
    o.fulfillment_status::text AS fulfillment_status,
    o.subtotal_egp,
    o.total_egp AS net_egp,
    o.shipping_egp,
    COALESCE(units.quantity, 0) AS units,
    sh.courier,
    (sh.handed_over_at AT TIME ZONE 'Africa/Cairo'::text)::date AS shipped_on,
    (sh.delivered_at AT TIME ZONE 'Africa/Cairo'::text)::date AS delivered_on,
        CASE
            WHEN o.fulfillment_status = 'delivered'::fulfillment_status THEN 'delivered'::text
            WHEN ret.refused THEN 'refused'::text
            WHEN ret.returned THEN 'returned'::text
            ELSE 'open'::text
        END AS outcome,
        CASE
            WHEN o.customer_id IS NOT NULL THEN row_number() OVER (PARTITION BY o.customer_id ORDER BY o.created_at, o.id)
            ELSE NULL::bigint
        END AS customer_order_no
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN LATERAL ( SELECT sum(li.quantity)::integer AS quantity
           FROM order_line_items li
          WHERE li.order_id = o.id) units ON true
     LEFT JOIN LATERAL ( SELECT s.courier,
            s.handed_over_at,
            s.delivered_at
           FROM shipments s
          WHERE s.order_id = o.id AND s.direction = 'outbound'::shipment_direction AND s.status <> 'cancelled'::shipment_status
          ORDER BY s.created_at DESC
         LIMIT 1) sh ON true
     LEFT JOIN LATERAL ( SELECT bool_or(r.type = 'failed_delivery'::return_type) AS refused,
            bool_or(r.type = 'post_delivery'::return_type) AS returned
           FROM returns r
          WHERE r.order_id = o.id) ret ON true
  WHERE o.archived_at IS NULL AND o.cancelled_at IS NULL AND o.fulfillment_status <> 'cancelled'::fulfillment_status;

create or replace view public.v_report_lines
with (security_invoker = on) as
SELECT li.id AS line_id,
    o.id AS order_id,
    o.order_number,
    (o.created_at AT TIME ZONE 'Africa/Cairo'::text)::date AS placed_on,
    o.channel::text AS channel,
    o.payment_method::text AS payment_method,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    o.customer_id,
    v.product_id,
    COALESCE(p.title, li.title) AS product_title,
    li.variant_id,
    li.sku,
    v.size,
    v.color,
    li.quantity,
    round(li.unit_price_egp * li.quantity::numeric, 2) AS gross_egp,
    round(li.unit_price_egp * li.quantity::numeric, 2) - nl.net_egp AS discounts_egp,
    nl.net_egp
   FROM order_line_items li
     JOIN orders o ON o.id = li.order_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN variants v ON v.id = li.variant_id
     LEFT JOIN products p ON p.id = v.product_id
     CROSS JOIN LATERAL ( SELECT round(li.total_egp *
                CASE
                    WHEN o.subtotal_egp > 0::numeric THEN o.total_egp / o.subtotal_egp
                    ELSE 1::numeric
                END, 2) AS net_egp) nl
  WHERE o.archived_at IS NULL AND o.cancelled_at IS NULL AND o.fulfillment_status <> 'cancelled'::fulfillment_status;

create or replace view public.v_report_returns
with (security_invoker = on) as
SELECT rl.id AS return_line_id,
    r.id AS return_id,
    o.id AS order_id,
    o.order_number,
    (COALESCE(r.received_at, r.courier_reported_at, r.created_at) AT TIME ZONE 'Africa/Cairo'::text)::date AS returned_on,
    r.type::text AS return_type,
    r.reason::text AS reason,
    o.channel::text AS channel,
    COALESCE(o.ship_governorate, c.governorate) AS governorate,
    o.customer_id,
    v.product_id,
    COALESCE(p.title, li.title) AS product_title,
    rl.variant_id,
    rl.sku,
    v.size,
    v.color,
    rl.quantity_expected AS quantity,
    round(
        CASE
            WHEN li.quantity > 0 THEN li.total_egp *
            CASE
                WHEN o.subtotal_egp > 0::numeric THEN o.total_egp / o.subtotal_egp
                ELSE 1::numeric
            END / li.quantity::numeric
            ELSE 0::numeric
        END * rl.quantity_expected::numeric, 2) AS value_egp
   FROM return_lines rl
     JOIN returns r ON r.id = rl.return_id
     JOIN orders o ON o.id = r.order_id
     LEFT JOIN order_line_items li ON li.id = rl.order_line_item_id
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN variants v ON v.id = rl.variant_id
     LEFT JOIN products p ON p.id = v.product_id
  WHERE o.archived_at IS NULL AND rl.quantity_expected > 0;

-- Customers who refuse, by the badge's rules (order_outcome): a refusal is a
-- parcel that came back whole, by the customer's doing - #1497's customer
-- kept the L, and was listed here as a refuser. Each refusal is counted on
-- the record it happened on, so one person is not listed twice; what they
-- took after the last one counts wherever they ordered (person_orders) - on
-- #1442's customer's second number, W2610-00049. Appended:
-- received_since_refusal.
create or replace view public.v_customer_reliability
with (security_invoker = on) as
select c.id as customer_id,
       c.full_name,
       c.phone,
       c.governorate,
       c.requires_prepayment,
       st.orders_placed,
       st.delivered,
       st.refusals,
       st.returns_after_delivery,
       round(100.0 * st.refusals / nullif(st.orders_placed, 0), 1) as refusal_pct,
       st.last_order_at,
       case
         when st.refusals > 0 then (
           select count(*)
             from public.person_orders(c.id, array[c.phone], public.name_key(c.full_name)) p
            where public.order_outcome(p.order_id) = 'received'
              and p.created_at > st.last_refusal_at)
         else 0
       end as received_since_refusal
  from public.customers c
  join lateral (
    select count(*) as orders_placed,
           count(*) filter (where o.fulfillment_status = 'delivered') as delivered,
           count(*) filter (where public.order_outcome(o.id) = 'refused') as refusals,
           count(*) filter (where exists (select 1 from public.returns r
                                           where r.order_id = o.id and r.type = 'post_delivery')) as returns_after_delivery,
           max(o.created_at) as last_order_at,
           max(o.created_at) filter (where public.order_outcome(o.id) = 'refused') as last_refusal_at
      from public.orders o
     where o.customer_id = c.id
  ) st on st.orders_placed > 0;

-- --- And so do the lookups behind returns and statements --------------------

CREATE OR REPLACE FUNCTION public.lookup_return_by_order_number(p_order_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order    public.orders;
  v_customer public.customers;
  v_shipment public.shipments;
  v_return   public.returns;
  v_state    text;
  v_type     public.return_type;
begin
  if not public.is_staff() and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order
    from public.orders
   where upper(trim(order_number)) in (
           upper(trim(p_order_number)),
           '#' || upper(trim(p_order_number))
         );

  if v_order.id is null then
    return jsonb_build_object('state', 'not_found', 'order_number', trim(p_order_number));
  end if;

  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Carried through for the receipt line and for a courier-shipped order
  -- that also happens to have a code, so the screen is not blank for it.
  select * into v_shipment
    from public.shipments
   where order_id = v_order.id and direction = 'outbound'
   order by created_at desc
   limit 1;

  -- Typed as the replacement's number, it is that exchange's old piece -
  -- not a fresh return of the replacement.
  select * into v_return
    from public.returns
   where order_id = v_order.id
      or (type = 'exchange' and replacement_order_id = v_order.id)
   order by created_at desc
   limit 1;

  v_state := case
    -- Back, but the customer still has pieces of a delivered order: those can
    -- come back too.
    when v_return.id is not null and v_return.status in ('received', 'closed')
         and v_order.fulfillment_status = 'delivered'
         and exists (select 1 from public.order_line_items li
                      where li.order_id = v_order.id and public.order_line_remaining(li.id) > 0)
      then 'needs_post_delivery_record'
    when v_return.id is not null and v_return.status in ('received', 'closed')
      then 'already_received'
    when v_return.id is not null then 'ready_to_receive'
    -- Handed to the customer already - whether that was over the counter
    -- or, someday, a courier delivery this system can recognise as such.
    when v_order.fulfillment_status = 'delivered'
      then 'needs_post_delivery_record'
    when v_order.fulfillment_status in ('in_transit', 'out_for_delivery',
                                        'delivery_failed', 'return_in_transit')
      then 'needs_failure_record'
    else 'not_returnable'
  end;

  -- The return this will be, for whether its value is owed back.
  v_type := case v_state
    when 'ready_to_receive' then v_return.type
    when 'needs_post_delivery_record' then 'post_delivery'
    else 'failed_delivery'
  end;

  return jsonb_build_object(
    'state', v_state,
    'tracking_number', v_shipment.tracking_number,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'fulfillment_status', v_order.fulfillment_status,
      'payment_method', v_order.payment_method,
      'total_egp', v_order.total_egp,
      'customer_name', coalesce(v_order.ship_name, v_customer.full_name),
      'customer_phone', coalesce(v_order.ship_phone, v_customer.phone),
      'governorate', coalesce(v_order.ship_governorate, v_customer.governorate)
    ),
    'return', case
      when v_return.id is null or v_state = 'needs_post_delivery_record' then null
      else jsonb_build_object(
        'id', v_return.id,
        'type', v_return.type,
        'reason', v_return.reason,
        'status', v_return.status
      )
    end,
    'exchange', case when v_return.type = 'exchange' and v_state <> 'needs_post_delivery_record'
      then jsonb_build_object(
        'original_order_number', (select x.order_number from public.orders x where x.id = v_return.order_id),
        'replacement_order_number', (select x.order_number from public.orders x where x.id = v_return.replacement_order_id)
      ) end,
    'refunded', public.return_is_refunded(coalesce(v_return.order_id, v_order.id), v_type),
    'lines', case when v_state = 'ready_to_receive' then public.return_lines_json(v_return.id)
                  else '[]'::jsonb end,
    'order_lines', public.order_lines_json(v_order.id)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.lookup_return_by_tracking(p_tracking text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_return   public.returns;
  v_customer public.customers;
  v_state    text;
begin
  if not public.is_staff() and not public.is_service_request() then
    raise exception 'Not an active staff member' using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('state', 'not_found', 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Or the exchange whose replacement went out in this parcel: the courier
  -- collected the old piece on the same visit.
  select * into v_return
    from public.returns
   where outbound_shipment_id = v_shipment.id
      or (type = 'exchange' and replacement_order_id = v_shipment.order_id)
   order by created_at desc
   limit 1;

  v_state := case
    -- Fully accounted for. Scanning it again says so rather than inviting a
    -- second count of the same parcel.
    when v_return.id is not null and v_return.status in ('received', 'closed')
      then 'already_received'
    -- A return still marked short stays open on purpose: the missing piece
    -- may turn up next week, and it should be recordable when it does.
    -- receive_return only ever moves the difference, so scanning a short
    -- parcel again cannot add the same garments to stock twice.
    when v_return.id is not null then 'ready_to_receive'
    -- The parcel is on the table but nobody recorded the failure when the
    -- courier rang. Rather than making someone go and do that first, the
    -- screen offers to record it and check it in as one action.
    when v_order.fulfillment_status in ('in_transit', 'out_for_delivery',
                                        'delivery_failed', 'return_in_transit')
      then 'needs_failure_record'
    else 'not_returnable'
  end;

  return jsonb_build_object(
    'state', v_state,
    'tracking_number', v_shipment.tracking_number,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'fulfillment_status', v_order.fulfillment_status,
      'payment_method', v_order.payment_method,
      'total_egp', v_order.total_egp,
      'customer_name', coalesce(v_order.ship_name, v_customer.full_name),
      'customer_phone', coalesce(v_order.ship_phone, v_customer.phone),
      'governorate', coalesce(v_order.ship_governorate, v_customer.governorate)
    ),
    'return', case
      when v_return.id is null then null
      else jsonb_build_object(
        'id', v_return.id,
        'type', v_return.type,
        'reason', v_return.reason,
        'status', v_return.status
      )
    end,
    'exchange', case when v_return.type = 'exchange' then jsonb_build_object(
      'original_order_number', (select x.order_number from public.orders x where x.id = v_return.order_id),
      'replacement_order_number', (select x.order_number from public.orders x where x.id = v_return.replacement_order_id)
    ) end,
    -- What comes back is owed to the customer rather than taken off the bill.
    'refunded', public.return_is_refunded(
      coalesce(v_return.order_id, v_order.id),
      coalesce(v_return.type, 'failed_delivery'::public.return_type)
    ),
    'lines', public.return_lines_json(v_return.id),
    -- What went out, for the case where no return exists yet and the screen
    -- has to show the packer what to expect in the parcel.
    'order_lines', public.order_lines_json(v_order.id)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.lookup_shipment_for_settlement(p_tracking text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shipment public.shipments;
  v_order    public.orders;
  v_customer public.customers;
  v_settled  record;
begin
  if not (public.is_admin() or public.has_permission('settlements.manage') or public.is_service_request()) then
    raise exception 'Only an admin or stock manager may read settlements'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_shipment
    from public.shipments
   where tracking_number = trim(p_tracking)
   order by created_at desc
   limit 1;

  if v_shipment.id is null then
    return jsonb_build_object('found', false, 'tracking_number', trim(p_tracking));
  end if;

  select * into v_order from public.orders where id = v_shipment.order_id;
  select * into v_customer from public.customers where id = v_order.customer_id;

  -- Already on a statement. Worth knowing before it is keyed a second time.
  select s.reference, s.id into v_settled
    from public.settlement_lines sl
    join public.courier_settlements s on s.id = sl.settlement_id
   where sl.order_id = v_order.id
   limit 1;

  return jsonb_build_object(
    'found', true,
    'tracking_number', v_shipment.tracking_number,
    'order_number', v_order.order_number,
    'fulfillment_status', v_order.fulfillment_status,
    'payment_status', v_order.payment_status,
    'payment_method', v_order.payment_method,
    'prepaid', v_shipment.cod_amount_egp = 0,
    'customer_name', coalesce(v_order.ship_name, v_customer.full_name),
    'governorate', coalesce(v_order.ship_governorate, v_customer.governorate),
    'goods_egp', v_order.total_egp
                 - case when v_order.fulfillment_status = 'delivered'
                        then public.order_returned_off_egp(v_order.id) else 0 end,
    'shipping_egp', v_order.shipping_egp,
    -- What their statement should say for it, delivered: collected at the
    -- door, and charged to carry it - the shipping the customer was charged.
    'expected_egp', public.settlement_goods(v_shipment.id) + public.settlement_door_shipping(v_shipment.id),
    'door_shipping_egp', public.settlement_door_shipping(v_shipment.id),
    'fee_egp', v_order.shipping_egp,
    'already_on', v_settled.reference,
    -- What the customer took: a piece refused at the door is not on it.
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'sku', li.sku,
               'title', li.title,
               'variant_title', li.variant_title,
               'quantity', li.quantity - r.refused,
               'unit_price_egp', li.unit_price_egp,
               'total_egp', round(li.total_egp * (li.quantity - r.refused) / li.quantity, 2)
             ) order by li.created_at), '[]'::jsonb)
        from public.order_line_items li
       cross join lateral (
         select case when v_order.fulfillment_status = 'delivered'
                     then public.order_line_refused(li.id) else 0 end as refused
       ) r
       where li.order_id = v_order.id
         and li.quantity > r.refused
    )
  );
end;
$function$;

-- --- Shopify's ship-to, on arrival and on every change there ----------------
-- As in place, with the ship-to added.

CREATE OR REPLACE FUNCTION public.ingest_shopify_order(p_payload jsonb, p_location_id uuid DEFAULT NULL::uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shopify_id   bigint;
  v_order        public.orders;
  v_location_id  uuid;
  v_customer_id  uuid;
  v_item         jsonb;
  v_variant      public.variants;
  v_quantity     integer;
  v_unit_price   numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_line_total   numeric(12, 2);
  v_subtotal     numeric(12, 2) := 0;
  v_shipping     numeric(12, 2);
  v_discount     numeric(12, 2);
  v_gateways     text;
  v_payment      public.payment_method;
  v_payment_stat public.payment_status;
  v_movements    jsonb := '[]'::jsonb;
  v_unmatched    jsonb := '[]'::jsonb;
  v_ship         jsonb;
begin
  if not public.is_service_request() and not public.is_admin() then
    raise exception 'Shopify orders are ingested by the webhook service'
      using errcode = 'insufficient_privilege';
  end if;

  v_shopify_id := nullif(p_payload ->> 'id', '')::bigint;
  if v_shopify_id is null then
    raise exception 'Payload has no order id' using errcode = 'invalid_parameter_value';
  end if;

  -- The replay path. Shopify redelivers, and a second delivery must not
  -- create a second order or deduct the stock again.
  select * into v_order from public.orders where shopify_order_id = v_shopify_id;
  if found then
    return v_order;
  end if;

  -- An explicitly named location wins. Otherwise ship from the default one.
  v_location_id := p_location_id;

  if v_location_id is null then
    select id into v_location_id
      from public.locations
     where is_default and is_active
     limit 1;
  end if;

  if v_location_id is null then
    raise exception 'No default location is configured to ship from'
      using errcode = 'no_data_found';
  end if;

  v_customer_id := public.upsert_shopify_customer(p_payload);
  -- Who this parcel goes to, which need not be who the customer record is:
  -- #1532 was one person on another customer's number.
  v_ship := public.shopify_ship_to(p_payload);

  -- Shipping sits in a money set rather than a plain field.
  v_shipping := coalesce(
    nullif(p_payload #>> '{total_shipping_price_set,shop_money,amount}', '')::numeric,
    0
  );
  v_discount := coalesce(nullif(p_payload ->> 'total_discounts', '')::numeric, 0);

  -- Gateway names are an array and a store can have several. Matching on the
  -- text of all of them is more robust than guessing one exact label, since
  -- the COD gateway is named differently on every store.
  select coalesce(string_agg(lower(value #>> '{}'), ','), '')
    into v_gateways
    from jsonb_array_elements(coalesce(p_payload -> 'payment_gateway_names', '[]'::jsonb));

  v_payment := case
    when v_gateways ~ 'cash|cod|delivery' then 'cod'
    when v_gateways ~ 'instapay'          then 'instapay'
    when v_gateways ~ 'bank|transfer'     then 'bank_transfer'
    when v_gateways = ''                  then 'cod'
    else 'card'
  end::public.payment_method;

  v_payment_stat := case lower(coalesce(p_payload ->> 'financial_status', 'pending'))
    when 'paid'               then 'paid'
    when 'partially_refunded' then 'partially_refunded'
    when 'refunded'           then 'refunded'
    when 'voided'             then 'failed'
    else 'pending'
  end::public.payment_status;

  -- Every order here is phoned to confirm before it ships, so that is where a
  -- new one starts rather than going straight into the packing queue.
  insert into public.orders (
    order_number, channel, fulfillment_status, payment_status, location_id,
    customer_id, payment_method, currency, shipping_egp, discount_egp,
    shopify_order_id, source_detail, note,
    ship_name, ship_phone, ship_address_line1, ship_address_line2, ship_city, ship_governorate,
    ship_from_shopify
  )
  values (
    coalesce(nullif(p_payload ->> 'name', ''), public.next_order_number('online')),
    'online', 'awaiting_confirmation', v_payment_stat,
    v_location_id, v_customer_id, v_payment,
    coalesce(nullif(p_payload ->> 'currency', ''), 'EGP'),
    v_shipping, v_discount, v_shopify_id,
    nullif(p_payload ->> 'name', ''),
    nullif(p_payload ->> 'note', ''),
    v_ship ->> 'name', v_ship ->> 'phone', v_ship ->> 'address_line1', v_ship ->> 'address_line2',
    v_ship ->> 'city', v_ship ->> 'governorate',
    v_ship
  )
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'line_items', '[]'::jsonb))
  loop
    v_variant := null;

    if nullif(v_item ->> 'variant_id', '') is not null then
      select * into v_variant from public.variants
       where shopify_variant_id = (v_item ->> 'variant_id')::bigint;
    end if;

    if v_variant.id is null and nullif(v_item ->> 'sku', '') is not null then
      select * into v_variant from public.variants where sku = v_item ->> 'sku';
    end if;

    v_quantity      := coalesce(nullif(v_item ->> 'quantity', '')::integer, 0);
    v_unit_price    := coalesce(nullif(v_item ->> 'price', '')::numeric, 0);
    v_line_discount := coalesce(nullif(v_item ->> 'total_discount', '')::numeric, 0);
    v_line_total    := round(v_unit_price * v_quantity, 2) - v_line_discount;

    if v_quantity <= 0 then
      continue;
    end if;

    insert into public.order_line_items (
      order_id, variant_id, sku, title, quantity,
      unit_price_egp, discount_egp, total_egp
    )
    values (
      v_order.id, v_variant.id,
      coalesce(nullif(v_item ->> 'sku', ''), 'UNKNOWN'),
      coalesce(nullif(v_item ->> 'title', ''), 'Unknown item'),
      v_quantity, v_unit_price, v_line_discount, greatest(v_line_total, 0)
    );

    v_subtotal := v_subtotal + greatest(v_line_total, 0);

    if v_variant.id is null then
      -- Recorded rather than rejected. The customer has bought something, and
      -- an order we refuse to import is an order nobody packs.
      v_unmatched := v_unmatched || jsonb_build_object(
        'sku', v_item ->> 'sku',
        'title', v_item ->> 'title',
        'shopify_variant_id', v_item ->> 'variant_id'
      );
    elsif v_variant.track_inventory then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_variant.id,
        'quantity_delta', -v_quantity
      );
    end if;
  end loop;

  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         total_egp    = greatest(round(v_subtotal - v_discount, 2), 0)
   where id = v_order.id
  returning * into v_order;

  -- Shopify has already taken this off its own count at checkout, so our
  -- number and theirs land on the same figure and the outbound push that
  -- follows is a harmless no-op.
  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_location_id,
      p_reason          => 'online_order',
      p_movements       => v_movements,
      p_reference_type  => 'shopify_order',
      p_reference_id    => v_shopify_id::text,
      p_note            => null,
      p_idempotency_key => 'shopify_order:' || v_shopify_id::text
    );
  end if;

  if jsonb_array_length(v_unmatched) > 0 then
    perform public.open_sync_issue(
      'missing_in_crm', null, v_location_id, null, null,
      jsonb_build_object(
        'reason', 'order_contains_unknown_variants',
        'order_number', v_order.order_number,
        'shopify_order_id', v_shopify_id,
        'items', v_unmatched
      ),
      'webhook'
    );
  end if;

  return v_order;
end;
$function$;

CREATE OR REPLACE FUNCTION public.sync_shopify_order_lines(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_shopify_id  bigint;
  v_updated_at  timestamptz;
  v_order       public.orders;
  v_item        jsonb;
  v_variant     public.variants;
  v_key         text;
  v_qty         integer;
  v_ordered     integer;
  v_price       numeric(12, 2);
  v_line_disc   numeric(12, 2);
  v_line_total  numeric(12, 2);
  v_subtotal    numeric(12, 2) := 0;
  v_shipping    numeric(12, 2);
  v_shopify     jsonb := '{}'::jsonb;
  v_crm         jsonb;
  v_before      jsonb;
  v_after       jsonb := '{}'::jsonb;
  v_delta       integer;
  v_movements   jsonb := '[]'::jsonb;
  v_touched     uuid[] := '{}';
begin
  if not public.is_service_request() and not public.is_admin() then
    raise exception 'Shopify order changes are applied by the webhook service'
      using errcode = 'insufficient_privilege';
  end if;

  v_shopify_id := nullif(p_payload ->> 'id', '')::bigint;
  if v_shopify_id is null then
    raise exception 'Payload has no order id' using errcode = 'invalid_parameter_value';
  end if;
  v_updated_at := nullif(p_payload ->> 'updated_at', '')::timestamptz;

  select * into v_order from public.orders where shopify_order_id = v_shopify_id for update;

  if not found then
    -- Placed before the CRM existed: history, not a missed order. Its stock
    -- was in the opening count, so importing it would take it out twice -
    -- which is what tidying old orders in Shopify did on 2026-10-22.
    if nullif(p_payload ->> 'created_at', '')::timestamptz < coalesce(
         (select (s.value #>> '{}')::timestamptz from public.settings s where s.key = 'shopify_orders_since'),
         '-infinity'::timestamptz)
    then
      return jsonb_build_object('result', 'before_crm', 'order_number', p_payload ->> 'name');
    end if;

    -- Missed orders/create: this is the order's first appearance.
    v_order := public.ingest_shopify_order(p_payload);
    update public.orders set shopify_updated_at = v_updated_at where id = v_order.id;
    return jsonb_build_object(
      'result', 'created',
      'order_id', v_order.id,
      'order_number', v_order.order_number,
      'variant_ids', coalesce((
        select jsonb_agg(distinct li.variant_id)
          from public.order_line_items li
         where li.order_id = v_order.id and li.variant_id is not null
      ), '[]'::jsonb)
    );
  end if;

  if v_updated_at is not null
     and v_order.shopify_updated_at is not null
     and v_updated_at <= v_order.shopify_updated_at
  then
    return jsonb_build_object('result', 'stale', 'order_number', v_order.order_number);
  end if;

  update public.orders
     set shopify_updated_at = coalesce(v_updated_at, now())
   where id = v_order.id
  returning * into v_order;

  -- An address fix in Shopify reaches the order. A correction typed here
  -- stays until Shopify's own ship-to changes again.
  perform public.take_shopify_ship_to(v_order.id, p_payload);

  if v_order.cancelled_at is not null then
    return jsonb_build_object('result', 'cancelled', 'order_number', v_order.order_number);
  end if;

  -- Cancelled in Shopify: its lines all going to nothing is the cancellation,
  -- not an edit to follow or to flag. orders/cancelled says what it means here
  -- - closing a returned order flagged two false alarms on 2026-10-24.
  if nullif(p_payload ->> 'cancelled_at', '') is not null then
    return jsonb_build_object('result', 'cancelled_in_shopify', 'order_number', v_order.order_number);
  end if;

  -- A change made here has not reached Shopify yet, so what Shopify says is
  -- out of date. The queued job will make Shopify match.
  if exists (select 1 from public.shopify_order_outbox where order_id = v_order.id) then
    return jsonb_build_object('result', 'crm_change_pending', 'order_number', v_order.order_number);
  end if;

  -- What Shopify says the order holds now. current_quantity leaves out what
  -- an edit removed; quantity is what was first ordered.
  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'line_items', '[]'::jsonb))
  loop
    v_qty := coalesce(nullif(v_item ->> 'current_quantity', '')::integer,
                      nullif(v_item ->> 'quantity', '')::integer, 0);
    continue when v_qty <= 0;

    v_variant := null;
    if nullif(v_item ->> 'variant_id', '') is not null then
      select * into v_variant from public.variants
       where shopify_variant_id = (v_item ->> 'variant_id')::bigint;
    end if;
    if v_variant.id is null and nullif(v_item ->> 'sku', '') is not null then
      select * into v_variant from public.variants where sku = v_item ->> 'sku';
    end if;

    v_key := coalesce(v_variant.id::text, 'sku:' || coalesce(nullif(v_item ->> 'sku', ''), 'UNKNOWN'));
    v_shopify := jsonb_set(v_shopify, array[v_key], to_jsonb(coalesce((v_shopify ->> v_key)::integer, 0) + v_qty));
  end loop;

  select coalesce(jsonb_object_agg(t.k, t.q), '{}'::jsonb)
    into v_crm
    from (
      select coalesce(li.variant_id::text, 'sku:' || li.sku) as k, sum(li.quantity)::integer as q
        from public.order_line_items li
       where li.order_id = v_order.id
       group by 1
    ) t;

  -- The usual case: an address fix, a tag, or our own edit coming back.
  if v_crm = v_shopify then
    return jsonb_build_object('result', 'unchanged', 'order_number', v_order.order_number);
  end if;

  -- The parcel has left, or its money is counted. Nothing in a van moves
  -- stock (DECISIONS #3), so a person decides what this change means.
  if v_order.fulfillment_status not in ('awaiting_confirmation', 'confirmed', 'ready_to_pack', 'packed')
     or v_order.payment_status = 'paid'
     or exists (select 1 from public.settlement_lines where order_id = v_order.id)
  then
    perform public.open_sync_issue(
      'order_changed_in_shopify', null, v_order.location_id, null, null,
      jsonb_build_object(
        'order_id',           v_order.id,
        'order_number',       v_order.order_number,
        'fulfillment_status', v_order.fulfillment_status,
        'shopify_items', coalesce((
          select jsonb_agg((i ->> 'sku') || ' x' || (i ->> 'current_quantity'))
            from jsonb_array_elements(coalesce(p_payload -> 'line_items', '[]'::jsonb)) i
           where coalesce(nullif(i ->> 'current_quantity', '')::integer, 0) > 0
        ), '[]'::jsonb),
        'crm_items', coalesce((
          select jsonb_agg(li.sku || ' x' || li.quantity order by li.sku)
            from public.order_line_items li
           where li.order_id = v_order.id
        ), '[]'::jsonb)
      ),
      'webhook'
    );
    return jsonb_build_object('result', 'flagged', 'order_number', v_order.order_number);
  end if;

  -- Follow it. Captured before the lines are rewritten: what the order held,
  -- per tracked variant.
  select coalesce(jsonb_object_agg(t.variant_id::text, t.quantity), '{}'::jsonb)
    into v_before
    from (
      select li.variant_id, sum(li.quantity)::integer as quantity
        from public.order_line_items li
        join public.variants v on v.id = li.variant_id
       where li.order_id = v_order.id and v.track_inventory
       group by li.variant_id
    ) t;

  delete from public.order_line_items where order_id = v_order.id;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'line_items', '[]'::jsonb))
  loop
    v_qty := coalesce(nullif(v_item ->> 'current_quantity', '')::integer,
                      nullif(v_item ->> 'quantity', '')::integer, 0);
    continue when v_qty <= 0;
    v_ordered := greatest(coalesce(nullif(v_item ->> 'quantity', '')::integer, v_qty), 1);

    v_variant := null;
    if nullif(v_item ->> 'variant_id', '') is not null then
      select * into v_variant from public.variants
       where shopify_variant_id = (v_item ->> 'variant_id')::bigint;
    end if;
    if v_variant.id is null and nullif(v_item ->> 'sku', '') is not null then
      select * into v_variant from public.variants where sku = v_item ->> 'sku';
    end if;

    v_price      := coalesce(nullif(v_item ->> 'price', '')::numeric, 0);
    -- A line's discount was for the quantity first ordered.
    v_line_disc  := round(coalesce(nullif(v_item ->> 'total_discount', '')::numeric, 0) * v_qty / v_ordered, 2);
    v_line_total := greatest(round(v_price * v_qty, 2) - v_line_disc, 0);

    insert into public.order_line_items (
      order_id, variant_id, sku, title, variant_title,
      quantity, unit_price_egp, discount_egp, total_egp
    )
    values (
      v_order.id, v_variant.id,
      coalesce(nullif(v_item ->> 'sku', ''), 'UNKNOWN'),
      coalesce(nullif(v_item ->> 'title', ''), 'Unknown item'),
      nullif(v_item ->> 'variant_title', ''),
      v_qty, v_price, v_line_disc, v_line_total
    );

    v_subtotal := v_subtotal + v_line_total;

    if v_variant.id is not null and v_variant.track_inventory then
      v_after := jsonb_set(
        v_after,
        array[v_variant.id::text],
        to_jsonb(coalesce((v_after ->> v_variant.id::text)::integer, 0) + v_qty)
      );
    end if;
  end loop;

  -- Stock comes back for what left the order and goes out for what joined it.
  for v_key in select jsonb_object_keys(v_before || v_after)
  loop
    v_delta := coalesce((v_before ->> v_key)::integer, 0) - coalesce((v_after ->> v_key)::integer, 0);
    if v_delta <> 0 then
      v_movements := v_movements || jsonb_build_object('variant_id', v_key::uuid, 'quantity_delta', v_delta);
      v_touched := v_touched || v_key::uuid;
    end if;
  end loop;

  -- The shipping still on the order; an edit can remove a line and add one.
  if jsonb_typeof(p_payload -> 'shipping_lines') = 'array' then
    select coalesce(sum(nullif(s ->> 'price', '')::numeric), 0)
      into v_shipping
      from jsonb_array_elements(p_payload -> 'shipping_lines') s
     where coalesce(s ->> 'is_removed', 'false') <> 'true';
  else
    v_shipping := v_order.shipping_egp;
  end if;

  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         discount_egp = least(discount_egp, round(v_subtotal, 2)),
         total_egp    = greatest(round(v_subtotal - least(discount_egp, v_subtotal), 2), 0),
         shipping_egp = round(v_shipping, 2)
   where id = v_order.id
  returning * into v_order;

  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => v_order.location_id,
      p_reason          => 'adjustment'::public.stock_movement_reason,
      p_movements       => v_movements,
      p_reference_type  => 'shopify_order_edit',
      p_reference_id    => v_shopify_id::text,
      p_note            => 'Order ' || v_order.order_number || ' edited in Shopify',
      p_idempotency_key => 'shopify-edit:' || v_shopify_id::text || ':'
                           || coalesce(v_updated_at::text, clock_timestamp()::text)
    );
  end if;

  insert into public.order_events (order_id, event_type, note, details)
  values (
    v_order.id, 'items_edited', 'Edited in Shopify',
    jsonb_build_object('source', 'shopify', 'subtotal_egp', v_subtotal, 'movements', v_movements)
  );

  return jsonb_build_object(
    'result', 'updated',
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'variant_ids', to_jsonb(v_touched)
  );
end;
$function$;

-- --- A different Shopify customer on a known number fills nothing in ---------
-- As in place, with the condition added.

CREATE OR REPLACE FUNCTION public.upsert_shopify_customer(p_payload jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_customer    jsonb := coalesce(p_payload -> 'customer', '{}'::jsonb);
  v_address     jsonb := coalesce(p_payload -> 'shipping_address',
                                  p_payload -> 'billing_address', '{}'::jsonb);
  v_shopify_id  bigint;
  v_phone       text;
  v_email       text;
  v_name        text;
  v_id          uuid;
begin
  v_shopify_id := nullif(v_customer ->> 'id', '')::bigint;

  -- Shopify puts a phone number in up to three places and they do not always
  -- agree. The shipping address one is what the courier will actually call.
  v_phone := public.normalize_eg_phone(
    coalesce(
      nullif(v_address ->> 'phone', ''),
      nullif(p_payload ->> 'phone', ''),
      nullif(v_customer ->> 'phone', '')
    )
  );

  v_email := lower(nullif(coalesce(p_payload ->> 'email', v_customer ->> 'email'), ''));

  v_name := nullif(trim(concat_ws(' ',
    coalesce(nullif(v_address ->> 'first_name', ''), v_customer ->> 'first_name'),
    coalesce(nullif(v_address ->> 'last_name', ''),  v_customer ->> 'last_name')
  )), '');

  -- Match on the Shopify id first, then the phone number. Phone is the
  -- identifier that actually carries across the website, Instagram and the
  -- till, which is what makes one customer history possible.
  if v_shopify_id is not null then
    select id into v_id from public.customers where shopify_customer_id = v_shopify_id;
  end if;

  if v_id is null and v_phone is not null then
    select id into v_id from public.customers where phone = v_phone;
  end if;

  if v_id is null then
    insert into public.customers (
      shopify_customer_id, full_name, phone, email,
      address_line1, address_line2, city, governorate
    )
    values (
      v_shopify_id, v_name, v_phone, v_email,
      nullif(v_address ->> 'address1', ''),
      nullif(v_address ->> 'address2', ''),
      nullif(v_address ->> 'city', ''),
      nullif(v_address ->> 'province', '')
    )
    returning id into v_id;
    return v_id;
  end if;

  -- Fill in blanks without overwriting anything a person typed by hand - and
  -- only from this record's own Shopify customer. Another one on the same
  -- number is someone else using it: #1532 gave one customer's record
  -- another person's email.
  update public.customers
     set shopify_customer_id = coalesce(shopify_customer_id, v_shopify_id),
         full_name           = coalesce(full_name, v_name),
         phone               = coalesce(phone, v_phone),
         email               = coalesce(email, v_email::citext),
         address_line1       = coalesce(address_line1, nullif(v_address ->> 'address1', '')),
         city                = coalesce(city, nullif(v_address ->> 'city', '')),
         governorate         = coalesce(governorate, nullif(v_address ->> 'province', ''))
   where id = v_id
     and (shopify_customer_id is null or v_shopify_id is null or shopify_customer_id = v_shopify_id);

  return v_id;
end;
$function$;

-- --- A sale taken by hand ships to the name and number typed -----------------
-- The number finds the customer record, which keeps its own name: W2611-00066
-- was typed on a known number, and whatever name was typed with it is gone.
-- Now the order keeps it. As in place, with the two arguments added.

drop function public.create_store_sale(uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel, numeric);

CREATE OR REPLACE FUNCTION public.create_store_sale(p_location_id uuid, p_payment_method payment_method, p_items jsonb, p_idempotency_key text, p_customer_id uuid DEFAULT NULL::uuid, p_discount_egp numeric DEFAULT 0, p_note text DEFAULT NULL::text, p_channel sales_channel DEFAULT 'store'::sales_channel, p_shipping_egp numeric DEFAULT 0, p_ship_name text DEFAULT NULL::text, p_ship_phone text DEFAULT NULL::text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order         public.orders;
  v_item          jsonb;
  v_variant       public.variants;
  v_product_title text;
  v_quantity      integer;
  v_unit_price    numeric(12, 2);
  v_line_discount numeric(12, 2);
  v_line_total    numeric(12, 2);
  v_subtotal      numeric(12, 2) := 0;
  v_total         numeric(12, 2);
  v_shipping      numeric(12, 2);
    v_may_override  boolean;
  v_movements     jsonb := '[]'::jsonb;
  v_fulfillment   public.fulfillment_status;
  v_payment       public.payment_status;
begin
  perform public.assert_can_move_stock(
    case when p_channel = 'wholesale' then 'wholesale'::public.stock_movement_reason
         else 'store_sale'::public.stock_movement_reason end
  );

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'An idempotency key of at least 8 characters is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_order from public.orders where idempotency_key = p_idempotency_key;
  if found then
    return v_order;
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item'
      using errcode = 'invalid_parameter_value';
  end if;

  v_shipping := round(coalesce(p_shipping_egp, 0), 2);
  if v_shipping < 0 then
    raise exception 'Shipping cannot be negative'
      using errcode = 'invalid_parameter_value';
  end if;

  v_may_override := public.is_admin()
                    or public.has_permission('products.manage')
                    or public.is_service_request();

  -- Where the goods are.
  --
  -- A counter sale is handed over as it is rung up, so it is born delivered.
  -- Anything else has to be confirmed by phone, packed and shipped, so it
  -- starts at the front of the packing queue like an order from the website.
  -- The cast is explicit: a CASE returning string literals into an enum
  -- column is a mistake this project has made three times.
  v_fulfillment := case
    when p_channel = 'store' then 'delivered'
    else 'awaiting_confirmation'
  end::public.fulfillment_status;

  -- Where the money is, which moves on its own timeline.
  --
  -- Cash on delivery is collected by the courier and only becomes paid when
  -- the settlement containing it is reviewed - see DECISIONS.md. Paying later
  -- is a tab: the goods leave, the money is owed, and someone marks it paid
  -- when the customer settles. Everything else is money already taken.
  v_payment := case
    when p_payment_method in ('cod', 'deferred') then 'pending'
    else 'paid'
  end::public.payment_status;

  insert into public.orders (
    order_number, channel, fulfillment_status, payment_status, location_id,
    customer_id, staff_id, payment_method, note, idempotency_key, shipping_egp,
    ship_name, ship_phone
  )
  values (
    public.next_order_number(p_channel), p_channel, v_fulfillment, v_payment, p_location_id,
    p_customer_id, auth.uid(), p_payment_method, p_note, p_idempotency_key, v_shipping,
    p_ship_name, p_ship_phone
  )
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_variant
      from public.variants
     where id = (v_item ->> 'variant_id')::uuid;

    if not found then
      raise exception 'Unknown variant %', v_item ->> 'variant_id'
        using errcode = 'foreign_key_violation';
    end if;

    if not v_variant.is_active then
      raise exception 'Variant % (%) is not active and cannot be sold',
        v_variant.sku, v_variant.id
        using errcode = 'check_violation';
    end if;

    select title into v_product_title from public.products where id = v_variant.product_id;

    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity is null or v_quantity <= 0 then
      raise exception 'Quantity for % must be a positive whole number', v_variant.sku
        using errcode = 'invalid_parameter_value';
    end if;

    v_unit_price := case
      when v_may_override and (v_item ? 'unit_price_egp')
        then (v_item ->> 'unit_price_egp')::numeric
      else v_variant.price_egp
    end;

    v_line_discount := round(coalesce((v_item ->> 'discount_egp')::numeric, 0), 2);
    v_line_total := round(v_unit_price * v_quantity, 2) - v_line_discount;

    if v_line_total < 0 then
      raise exception 'Line discount for % is larger than the line total', v_variant.sku
        using errcode = 'check_violation';
    end if;

    insert into public.order_line_items (
      order_id, variant_id, sku, title, variant_title,
      quantity, unit_price_egp, discount_egp, total_egp
    )
    values (
      v_order.id, v_variant.id, v_variant.sku, coalesce(v_product_title, v_variant.sku),
      nullif(concat_ws(' / ', v_variant.size, v_variant.color), ''),
      v_quantity, v_unit_price, v_line_discount, v_line_total
    );

    v_subtotal := v_subtotal + v_line_total;

    if v_variant.track_inventory then
      v_movements := v_movements || jsonb_build_object(
        'variant_id', v_variant.id,
        'quantity_delta', -v_quantity
      );
    end if;
  end loop;

  v_total := round(v_subtotal - round(coalesce(p_discount_egp, 0), 2), 2);
  if v_total < 0 then
    raise exception 'Order discount is larger than the order subtotal'
      using errcode = 'check_violation';
  end if;

  -- total_egp is the goods, after discount, WITHOUT shipping. The customer
  -- pays total_egp + shipping_egp; see calculateInvoiceTotals in shared.
  update public.orders
     set subtotal_egp = round(v_subtotal, 2),
         discount_egp = round(coalesce(p_discount_egp, 0), 2),
         total_egp    = v_total
   where id = v_order.id
  returning * into v_order;

  -- Stock leaves when the order is taken, on every channel. There is no
  -- reservation concept yet (DECISIONS.md #8), so an order that is later
  -- refused comes back through the returns flow rather than by never having
  -- left. Manual entry is also refused outright when stock is short, unlike
  -- an order arriving from the storefront - the difference is that a person
  -- is standing here and can look.
  if jsonb_array_length(v_movements) > 0 then
    perform public.record_stock_movements(
      p_location_id     => p_location_id,
      p_reason          => case when p_channel = 'wholesale' then 'wholesale'::public.stock_movement_reason
                                else 'store_sale'::public.stock_movement_reason end,
      p_movements       => v_movements,
      p_reference_type  => 'order',
      p_reference_id    => v_order.id::text,
      p_note            => null,
      p_idempotency_key => 'order:' || v_order.id::text
    );
  end if;

  return v_order;
end;
$function$;

revoke execute on function public.create_store_sale(uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel, numeric, text, text) from public, anon;
grant execute on function public.create_store_sale(uuid, public.payment_method, jsonb, text, uuid, numeric, text, public.sales_channel, numeric, text, text) to authenticated, service_role;
