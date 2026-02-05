-- TEPIHA — FIX: clients.photo_url + safe NEXT CODE + BRAND NEW RESET
-- Run in Supabase SQL Editor.

begin;

-- 1) Ensure clients has photo_url column (some triggers / app joins expect it)
alter table if exists public.clients
  add column if not exists photo_url text;

-- 2) Prevent "COALESCE types text and integer cannot be matched" by forcing integer codes
--    (If already integer, this will be skipped.)
do $$
begin
  begin
    alter table public.clients
      alter column code type integer
      using nullif(code::text,'')::int;
  exception when others then
    -- ignore if already int / cannot convert old junk rows
    null;
  end;

  begin
    alter table public.orders
      alter column code type integer
      using nullif(code::text,'')::int;
  exception when others then
    null;
  end;
end $$;

commit;

-- 3) BRAND NEW RESET (safe: only touches tables/cols that exist)
--    ⚠️ This DELETES ALL DATA (orders, clients, arka, payments, etc.)
--    After this, your first new client/order should start from code 1 again.
do $$
begin
  -- core
  if to_regclass('public.payments') is not null then
    execute 'truncate table public.payments restart identity cascade';
  end if;
  if to_regclass('public.orders') is not null then
    execute 'truncate table public.orders restart identity cascade';
  end if;
  if to_regclass('public.clients') is not null then
    execute 'truncate table public.clients restart identity cascade';
  end if;

  -- arka
  if to_regclass('public.arka_moves') is not null then
    execute 'truncate table public.arka_moves restart identity cascade';
  end if;
  if to_regclass('public.arka_days') is not null then
    execute 'truncate table public.arka_days restart identity cascade';
  end if;
  if to_regclass('public.arka_cycles') is not null then
    execute 'truncate table public.arka_cycles restart identity cascade';
  end if;

  -- code reservation / lock tables (if you have them)
  if to_regclass('public.code_leases') is not null then
    -- some schemas use is_used, some used_at, some used
    begin execute 'update public.code_leases set is_used=false'; exception when undefined_column then null; end;
    begin execute 'update public.code_leases set used=false'; exception when undefined_column then null; end;
    begin execute 'update public.code_leases set used_at=null'; exception when undefined_column then null; end;
  end if;
  if to_regclass('public.code_reservations') is not null then
    begin execute 'update public.code_reservations set is_used=false'; exception when undefined_column then null; end;
    begin execute 'update public.code_reservations set used=false'; exception when undefined_column then null; end;
    begin execute 'update public.code_reservations set used_at=null'; exception when undefined_column then null; end;
  end if;

end $$;

-- Note: localStorage counters still need to be reset from the app's hidden reset (PIN 2380)
-- or by clearing site data in the browser.
