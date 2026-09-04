-- Legacy ARKA day open/close is retired.
-- Current ARKA is continuous ledger-based; no financial write may depend on arka_cycles.is_closed.
-- Keep old tables/rows for historical audit only.

create or replace function public.create_arka_advance_atomic_v2(
  p_worker_pin text,
  p_worker_name text,
  p_amount numeric,
  p_note text default null,
  p_actor_pin text default null,
  p_actor_name text default null,
  p_actor_role text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.arka_pending_payments%rowtype;
  v_amount numeric := round(coalesce(p_amount, 0)::numeric, 2);
  v_worker_pin text := regexp_replace(coalesce(p_worker_pin, ''), '[^0-9]', '', 'g');
  v_actor_pin text := regexp_replace(coalesce(p_actor_pin, ''), '[^0-9]', '', 'g');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  if v_amount <= 0 then
    raise exception 'AMOUNT_INVALID';
  end if;
  if v_worker_pin = '' then
    raise exception 'WORKER_PIN_REQUIRED';
  end if;

  if v_key is not null then
    select * into v_row
    from public.arka_pending_payments
    where idempotency_key = v_key
      and upper(coalesce(type, '')) = 'ADVANCE'
    order by created_at desc
    limit 1;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'existing', true, 'payment', to_jsonb(v_row), 'row', to_jsonb(v_row));
    end if;
  end if;

  insert into public.arka_pending_payments (
    idempotency_key,
    amount,
    type,
    status,
    note,
    source_module,
    created_by_pin,
    created_by_name,
    created_by_role,
    approved_by_pin,
    approved_by_name,
    handed_at,
    handed_by_pin,
    handed_by_name,
    handed_by_role,
    created_at,
    updated_at
  ) values (
    v_key,
    v_amount,
    'ADVANCE',
    'ADVANCE',
    coalesce(nullif(btrim(p_note), ''), 'AVANS'),
    'ARKA',
    v_worker_pin,
    nullif(btrim(coalesce(p_worker_name, '')), ''),
    nullif(btrim(coalesce(p_actor_role, '')), ''),
    nullif(v_actor_pin, ''),
    nullif(btrim(coalesce(p_actor_name, '')), ''),
    now(),
    nullif(v_actor_pin, ''),
    nullif(btrim(coalesce(p_actor_name, '')), ''),
    nullif(btrim(coalesce(p_actor_role, '')), ''),
    now(),
    now()
  ) returning * into v_row;

  return jsonb_build_object('ok', true, 'duplicate', false, 'payment', to_jsonb(v_row), 'row', to_jsonb(v_row));
end;
$$;

-- Compatibility entry point used by older clients. It deliberately delegates to
-- the continuous ledger function above and performs no open/closed-day lookup.
create or replace function public.create_worker_advance_pro_v1(
  p_worker_pin text,
  p_worker_name text,
  p_amount numeric,
  p_note text default null,
  p_actor_pin text default null,
  p_actor_name text default null,
  p_actor_role text default null,
  p_idempotency_key text default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.create_arka_advance_atomic_v2(
    p_worker_pin,
    p_worker_name,
    p_amount,
    p_note,
    p_actor_pin,
    p_actor_name,
    p_actor_role,
    p_idempotency_key
  );
$$;

comment on function public.create_arka_advance_atomic_v2(text,text,numeric,text,text,text,text,text)
is 'Continuous ARKA advance write. Legacy day-cycle open/close checks retired 2026-09-04.';

comment on function public.create_worker_advance_pro_v1(text,text,numeric,text,text,text,text,text)
is 'Compatibility wrapper; no ARKA day open/close semantics.';
