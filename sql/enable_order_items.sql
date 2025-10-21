
-- sql/enable_order_items.sql — run once in Supabase SQL editor

-- 1) Table for pieces
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  piece_type text,
  qty int not null default 1,
  m2 numeric not null default 0,
  price_per_m2 numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Helpful index
create index if not exists order_items_order_id_idx on public.order_items(order_id);

-- 2) Row Level Security (simple & permissive for anon)
alter table public.order_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='order_items' and policyname='order_items_select') then
    create policy "order_items_select" on public.order_items
      for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='order_items' and policyname='order_items_insert') then
    create policy "order_items_insert" on public.order_items
      for insert with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='order_items' and policyname='order_items_update') then
    create policy "order_items_update" on public.order_items
      for update using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='order_items' and policyname='order_items_delete') then
    create policy "order_items_delete" on public.order_items
      for delete using (true);
  end if;
end$$;

-- 3) (Optional) If you want the order total recomputed from items via a view:
-- create or replace view public.order_items_totals as
--   select order_id, sum(qty*m2*price_per_m2) as items_total
--   from public.order_items group by order_id;
