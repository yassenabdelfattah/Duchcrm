-- ---------------------------------------------------------------------------
-- Phase 1: locations, products and variants.
-- ---------------------------------------------------------------------------

-- --- Locations -------------------------------------------------------------
--
-- Phase 2 runs on a single location. The column still exists on every ledger
-- row from day one: retrofitting locations into an append-only ledger later
-- would mean rewriting history, which is exactly what an append-only ledger
-- is supposed to make impossible.

create type public.location_type as enum ('warehouse', 'store');

create table public.locations (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  name_ar              text,
  type                 public.location_type not null default 'store',
  shopify_location_id  bigint unique,
  is_default           boolean not null default false,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on column public.locations.shopify_location_id is
  'Set on exactly one location - the one whose stock is mirrored to the storefront.';

-- At most one default location.
create unique index locations_one_default_idx on public.locations ((true)) where is_default;

create trigger locations_touch_updated_at
  before update on public.locations
  for each row execute function public.touch_updated_at();

-- --- Products --------------------------------------------------------------

create type public.product_status as enum ('active', 'draft', 'archived');

create table public.products (
  id                  uuid primary key default gen_random_uuid(),
  shopify_product_id  bigint unique,
  title               text not null,
  title_ar            text,
  handle              text,
  description         text,
  description_ar      text,
  product_type        text,
  vendor              text,
  status              public.product_status not null default 'active',
  tags                text[] not null default '{}',
  image_url           text,
  shopify_synced_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on column public.products.shopify_product_id is
  'Null for products created in the CRM that have not been pushed to Shopify.';

create index products_status_idx on public.products (status);
create index products_title_trgm_idx on public.products using gin (title gin_trgm_ops);

create trigger products_touch_updated_at
  before update on public.products
  for each row execute function public.touch_updated_at();

-- --- Variants --------------------------------------------------------------

create table public.variants (
  id                         uuid primary key default gen_random_uuid(),
  product_id                 uuid not null references public.products (id) on delete cascade,
  shopify_variant_id         bigint unique,
  shopify_inventory_item_id  bigint unique,
  sku                        text not null unique,
  barcode                    text,
  size                       text,
  color                      text,
  options                    jsonb not null default '{}'::jsonb,
  price_egp                  numeric(12, 2) not null default 0 check (price_egp >= 0),
  compare_at_price_egp       numeric(12, 2) check (compare_at_price_egp >= 0),
  weight_grams               integer check (weight_grams >= 0),
  position                   integer not null default 1,
  low_stock_threshold        integer not null default 3 check (low_stock_threshold >= 0),
  track_inventory            boolean not null default true,
  is_active                  boolean not null default true,
  shopify_synced_at          timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

comment on column public.variants.shopify_inventory_item_id is
  'The only identifier an inventory_levels/update webhook carries. Without it '
  'an incoming inventory webhook cannot be resolved back to a variant.';

create index variants_product_id_idx on public.variants (product_id);
create index variants_barcode_idx on public.variants (barcode) where barcode is not null;
create index variants_sku_trgm_idx on public.variants using gin (sku gin_trgm_ops);
create index variants_active_idx on public.variants (is_active) where is_active;

create trigger variants_touch_updated_at
  before update on public.variants
  for each row execute function public.touch_updated_at();

-- --- Costs -----------------------------------------------------------------
--
-- Unit cost lives in its own table rather than as a column on variants, for
-- one reason: Row Level Security works on rows, not columns. A sales user
-- needs to read variants to ring up a sale, and if cost sat on that row they
-- would be able to read the factory's margin along with it. A separate table
-- gets its own policy, so "sales staff cannot see cost" is enforced by the
-- database rather than by which screen we happen to show them.

create table public.variant_costs (
  variant_id  uuid primary key references public.variants (id) on delete cascade,
  cost_egp    numeric(12, 2) not null check (cost_egp >= 0),
  currency    text not null default 'EGP',
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.staff (id) on delete set null
);

comment on table public.variant_costs is
  'Unit cost for stock valuation. Readable only by admin and stock_manager.';

create trigger variant_costs_touch_updated_at
  before update on public.variant_costs
  for each row execute function public.touch_updated_at();
