-- Prevent two tabs/devices with different client-generated idempotency keys
-- from applying the same stale cash-payment view twice.

create or replace function public.transport_collect_client_payment_guarded_v2(
  p_order_id uuid,
  p_actor_pin text,
  p_amount_received numeric,
  p_method text default 'CASH',
  p_note text default null,
  p_idempotency_key text default null,
  p_confirm_delivery boolean default false,
  p_expected_total_due numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client_id uuid;
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_expected numeric(12,2) := round(coalesce(p_expected_total_due, -1), 2);
  v_actual numeric(12,2);
  v_summary jsonb;
  v_existing_batch boolean := false;
begin
  select client_id into v_client_id
  from public.transport_orders
  where id = p_order_id;
  if not found then
    raise exception 'TRANSPORT_ORDER_NOT_FOUND';
  end if;
  if v_client_id is null then
    raise exception 'TRANSPORT_CLIENT_ID_REQUIRED';
  end if;

  -- This is the same client-wide lock used by the authoritative collector.
  -- It keeps the snapshot check and the delegated payment in one transaction.
  perform pg_advisory_xact_lock(
    hashtextextended('transport-receivables-v3:' || v_client_id::text, 0)
  );

  if v_key is not null then
    select exists(
      select 1
      from public.transport_payment_batches b
      where b.idempotency_key = v_key
    ) into v_existing_batch;
  end if;

  -- A retry of an already-committed key must be allowed through so the v1
  -- collector can verify and return its original batch, even though debt moved.
  if not v_existing_batch then
    if p_expected_total_due is null then
      raise exception 'EXPECTED_TOTAL_DUE_REQUIRED';
    end if;
    if v_expected < 0 then
      raise exception 'EXPECTED_TOTAL_DUE_INVALID';
    end if;

    v_summary := public.transport_client_receivable_summary_v1(p_order_id, v_client_id);
    v_actual := round(coalesce((v_summary ->> 'totalForPayment')::numeric, 0), 2);
    if v_actual is distinct from v_expected then
      raise exception 'PAYMENT_BALANCE_CHANGED';
    end if;
  end if;

  return public.transport_collect_client_payment_v1(
    p_order_id,
    p_actor_pin,
    p_amount_received,
    p_method,
    p_note,
    p_idempotency_key,
    p_confirm_delivery
  );
end;
$$;

revoke execute on function public.transport_collect_client_payment_guarded_v2(
  uuid, text, numeric, text, text, text, boolean, numeric
) from public, anon, authenticated;

grant execute on function public.transport_collect_client_payment_guarded_v2(
  uuid, text, numeric, text, text, text, boolean, numeric
) to service_role;
