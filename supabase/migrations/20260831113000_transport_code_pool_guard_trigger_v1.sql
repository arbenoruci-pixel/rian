-- TRANSPORT_CODE_POOL_GUARD_TRIGGER_V1
-- The allocator/create/finalize RPCs own pool lifecycle. This trigger only guards
-- code identity and never mutates transport_code_pool from a browser-role write.

begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

do $$
declare
  v_trigger_count integer;
  v_canonicalizer_count integer;
begin
  select count(*)::integer
  into v_trigger_count
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'public.transport_orders'::regclass
    and not t.tgisinternal
    and t.tgname = 'trg_mark_transport_code_used'
    and t.tgenabled = 'O'
    and pg_get_triggerdef(t.oid, true) =
      'CREATE TRIGGER trg_mark_transport_code_used AFTER INSERT OR UPDATE OF code_str, client_tcode ON transport_orders FOR EACH ROW EXECUTE FUNCTION trg_mark_transport_code_used()'
    and p.proname = 'trg_mark_transport_code_used'
    and p.prosecdef is false
    and p.proconfig = array['search_path=public, pg_temp']::text[]
    -- Exact audited production function at 2026-08-31. Abort on any drift;
    -- never replace a same-named trigger/function whose behavior changed.
    and md5(pg_get_functiondef(p.oid)) = '7fa3e6b65c2e0d9dc9cb1195863c2455';

  if v_trigger_count <> 1 then
    raise exception 'TRANSPORT_CODE_POOL_GUARD_TRIGGER_PREFLIGHT_FAILED: expected legacy trigger once, found %', v_trigger_count;
  end if;

  select count(*)::integer
  into v_canonicalizer_count
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'public.transport_orders'::regclass
    and not t.tgisinternal
    and t.tgname = 'trg_transport_order_code_canonicalize'
    and t.tgenabled = 'O'
    and pg_get_triggerdef(t.oid, true) =
      'CREATE TRIGGER trg_transport_order_code_canonicalize BEFORE INSERT OR UPDATE OF client_id, client_tcode, code_str, visit_nr, data ON transport_orders FOR EACH ROW EXECUTE FUNCTION transport_order_code_canonicalize()'
    and p.proname = 'transport_order_code_canonicalize'
    and p.prosecdef is false
    and p.proconfig = array['search_path=public, pg_temp']::text[]
    and md5(pg_get_functiondef(p.oid)) = '3fc598b43ae83a79030be3d2e9ad9a1e';

  if v_canonicalizer_count <> 1 then
    raise exception 'TRANSPORT_CODE_CANONICALIZER_PREFLIGHT_FAILED: expected canonicalizer once, found %', v_canonicalizer_count;
  end if;
end;
$$;

drop trigger trg_mark_transport_code_used on public.transport_orders;

-- Preserve the live canonicalizer contract and add the identity aliases that
-- hardened PATCH payloads deliberately omit. Its existing trigger sorts before
-- the guard below and rehydrates JSON from authoritative row/client columns.
create or replace function public.transport_order_code_canonicalize()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order_code text;
  v_order_digits text;
  v_master_tcode text;
  v_master_digits text;
  v_data jsonb;
begin
  v_order_code := upper(btrim(coalesce(nullif(new.code_str, ''), nullif(new.client_tcode, ''), '')));
  v_order_digits := regexp_replace(v_order_code, '\D', '', 'g');
  if v_order_digits is null or v_order_digits = '' then
    raise exception using errcode = '23514', message = 'TRANSPORT_ORDER_CODE_REQUIRED';
  end if;
  v_order_code := 'T' || (v_order_digits::bigint)::text;

  if new.client_id is not null then
    select upper(btrim(c.tcode))
    into v_master_tcode
    from public.transport_clients c
    where c.id = new.client_id;
  end if;
  v_master_tcode := upper(btrim(coalesce(
    v_master_tcode,
    nullif(new.client_tcode, ''),
    new.data->>'transport_client_tcode',
    new.data->'client'->>'transport_client_tcode',
    new.data->'client'->>'tcode',
    v_order_code
  )));
  v_master_digits := regexp_replace(v_master_tcode, '\D', '', 'g');
  if v_master_digits is null or v_master_digits = '' then
    raise exception using errcode = '23514', message = 'TRANSPORT_CLIENT_TCODE_REQUIRED';
  end if;
  v_master_tcode := 'T' || (v_master_digits::bigint)::text;

  new.code_str := v_order_code;
  new.code_n := v_order_digits::bigint;
  new.client_tcode := v_master_tcode;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('transport-visit:' || v_master_tcode, 0));
    select coalesce(max(o.visit_nr), 0) + 1
    into new.visit_nr
    from public.transport_orders o
    where upper(coalesce(o.client_tcode, '')) = v_master_tcode;
  elsif new.visit_nr is null or new.visit_nr < 1 or old.client_tcode is distinct from v_master_tcode then
    perform pg_advisory_xact_lock(hashtextextended('transport-visit:' || v_master_tcode, 0));
    select coalesce(max(o.visit_nr), 0) + 1
    into new.visit_nr
    from public.transport_orders o
    where upper(coalesce(o.client_tcode, '')) = v_master_tcode
      and o.id <> new.id;
  end if;

  v_data := coalesce(new.data, '{}'::jsonb)
    || jsonb_build_object(
      'order_id', new.id::text,
      'public_order_id', new.id::text,
      'client_id', case when new.client_id is null then null else new.client_id::text end,
      'code_str', v_order_code,
      'code', v_order_code,
      'code_n', new.code_n,
      't_code', v_order_code,
      'order_code', v_order_code,
      'official_order_code', v_order_code,
      'order_tcode', v_order_code,
      'client_tcode', v_master_tcode,
      'transport_client_tcode', v_master_tcode,
      'visit_nr', new.visit_nr,
      'tcode_lifecycle', 'PERMANENT_CLIENT_TCODE_V1'
    );
  v_data := v_data || jsonb_build_object(
    'client', coalesce(v_data->'client', '{}'::jsonb)
      || jsonb_build_object(
        'id', case when new.client_id is null then null else new.client_id::text end,
        'tcode', v_master_tcode,
        'code_str', v_master_tcode,
        'code', v_master_tcode,
        't_code', v_master_tcode,
        'client_tcode', v_master_tcode,
        'transport_client_tcode', v_master_tcode,
        'order_code', v_order_code,
        'official_order_code', v_order_code,
        'order_tcode', v_order_code
      )
  );
  new.data := v_data;
  return new;
end;
$$;

create or replace function public.trg_mark_transport_code_used()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_code text;
  v_pool_status text;
  v_has_client boolean;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.client_id is distinct from old.client_id
       or new.code_str is distinct from old.code_str
       or new.client_tcode is distinct from old.client_tcode
       or new.code_n is distinct from old.code_n
       or new.visit_nr is distinct from old.visit_nr
    then
      raise exception using
        errcode = '23514',
        message = 'TRANSPORT_ORDER_IDENTITY_IMMUTABLE';
    end if;
    return new;
  end if;

  for v_code in
    select distinct upper(btrim(x.code))
    from (values(new.code_str), (new.client_tcode)) as x(code)
    where nullif(btrim(x.code), '') is not null
  loop
    select p.status
    into v_pool_status
    from public.transport_code_pool p
    where upper(btrim(p.code)) = v_code;

    select exists(
      select 1
      from public.transport_clients c
      where upper(btrim(c.tcode)) = v_code
        and (new.client_id is null or c.id = new.client_id)
    ) into v_has_client;

    if coalesce(v_pool_status, '') <> 'used' and not coalesce(v_has_client, false) then
      raise exception using
        errcode = '23514',
        message = 'TRANSPORT_ORDER_TCODE_NOT_CLAIMED';
    end if;
  end loop;

  return new;
end;
$$;

-- PostgreSQL runs triggers with the same timing/event in name order. The live
-- canonicalizer must run first so this guard checks the final canonical row,
-- including changes derived from a SET data/client_id statement.
create trigger trg_z_transport_order_identity_guard_v1
before insert or update
on public.transport_orders
for each row
execute function public.trg_mark_transport_code_used();

comment on function public.trg_mark_transport_code_used() is
  'Guard-only Transport code identity trigger v1. Pool mutation belongs to allocator/create/finalize RPCs.';

comment on function public.transport_order_code_canonicalize() is
  'Canonical Transport order/client T-code and JSON identity aliases; guard v1 compatible.';

commit;
