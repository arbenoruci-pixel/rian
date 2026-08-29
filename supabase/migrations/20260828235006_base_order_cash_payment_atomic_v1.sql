-- Atomic BASE cash payment for the Pastrimi purpose wizard.
-- The app calls this only through a server-side service-role client.

create or replace function public.record_base_order_cash_payment_atomic_v1(
  p_order_id bigint,
  p_amount numeric,
  p_expected_debt numeric,
  p_actor_pin text,
  p_actor_name text default null,
  p_actor_role text default null,
  p_order_code text default null,
  p_client_name text default null,
  p_client_phone text default null,
  p_note text default null,
  p_payment_outcome text default null,
  p_status_on_full_payment text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_payment public.arka_pending_payments%rowtype;
  v_existing public.arka_pending_payments%rowtype;
  v_actor public.users%rowtype;
  v_data jsonb;
  v_pay jsonb;
  v_next_data jsonb;
  v_total numeric := 0;
  v_paid numeric := 0;
  v_debt numeric := 0;
  v_next_paid numeric := 0;
  v_next_debt numeric := 0;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_expected_debt numeric := round(coalesce(p_expected_debt, -1), 2);
  v_outcome text := upper(btrim(coalesce(p_payment_outcome, '')));
  v_requested_status text := lower(btrim(coalesce(p_status_on_full_payment, '')));
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_current_status text;
  v_next_status text;
  v_order_code bigint := null;
  v_now timestamptz := clock_timestamp();
begin
  if p_order_id is null or p_order_id <= 0 then raise exception 'ORDER_ID_INVALID'; end if;
  if v_amount <= 0 then raise exception 'AMOUNT_INVALID'; end if;
  if v_expected_debt < 0 then raise exception 'EXPECTED_DEBT_REQUIRED'; end if;
  if btrim(coalesce(p_actor_pin, '')) = '' then raise exception 'ACTOR_PIN_REQUIRED'; end if;
  if v_idempotency_key = '' then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if v_outcome not in ('PREPAY_STAYS_PASTRIMI', 'CLIENT_PICKED_UP_TO_DORZIM', 'DELIVERY_TO_DORZIM') then
    raise exception 'PAYMENT_OUTCOME_INVALID';
  end if;
  if (v_outcome = 'PREPAY_STAYS_PASTRIMI' and v_requested_status <> 'pastrim')
     or (v_outcome in ('CLIENT_PICKED_UP_TO_DORZIM', 'DELIVERY_TO_DORZIM') and v_requested_status <> 'dorzim') then
    raise exception 'PAYMENT_OUTCOME_STATUS_MISMATCH';
  end if;

  -- Serialize exact retries first, then all payments for the same order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('base_payment_idem:' || v_idempotency_key, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('base_payment_order:' || p_order_id::text, 0));

  select * into v_actor
  from public.users
  where pin = btrim(p_actor_pin) and is_active is true
  limit 1;
  if not found then raise exception 'ACTOR_NOT_ACTIVE'; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  select * into v_existing
  from public.arka_pending_payments
  where idempotency_key = v_idempotency_key
  limit 1;

  if found then
    if v_existing.order_id is distinct from p_order_id
       or round(v_existing.amount, 2) is distinct from v_amount
       or coalesce(v_existing.created_by_pin, '') <> btrim(p_actor_pin)
       or coalesce(v_existing.source_module, '') <> 'BASE'
       or coalesce(v_existing.type, '') <> 'IN'
       or position('[OUTCOME:' || v_outcome || ']' in coalesce(v_existing.note, '')) = 0 then
      raise exception 'BASE_ARKA_IDEMPOTENCY_CONFLICT';
    end if;
    -- A retry must never push an order back from a later lifecycle state.
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'existing', true,
      'payment', to_jsonb(v_existing),
      'row', to_jsonb(v_existing),
      'order', to_jsonb(v_order),
      'idempotencyKey', v_idempotency_key,
      'paymentOutcome', v_outcome
    );
  end if;

  v_data := coalesce(v_order.data, '{}'::jsonb);
  v_pay := case when jsonb_typeof(v_data->'pay') = 'object' then v_data->'pay' else '{}'::jsonb end;
  v_total := round(greatest(0, coalesce(
    public.base_bonus_safe_numeric_v2(v_pay->>'euro'),
    public.base_bonus_safe_numeric_v2(v_pay->>'total'),
    v_order.price_total,
    v_order.total,
    public.base_bonus_safe_numeric_v2(v_data->>'price_total'),
    public.base_bonus_safe_numeric_v2(v_data->>'total'),
    0
  )), 2);
  v_paid := round(greatest(
    coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'paid'), 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'arkaRecordedPaid'), 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_data->>'clientPaid'), 0),
    coalesce(v_order.paid, 0),
    coalesce(v_order.paid_cash, 0)
  ), 2);
  v_debt := round(greatest(0, v_total - v_paid), 2);
  v_current_status := lower(btrim(coalesce(v_order.status, v_data->>'status', 'pastrim')));

  if v_total <= 0 then raise exception 'ORDER_TOTAL_INVALID'; end if;
  if v_debt <= 0 then raise exception 'ORDER_ALREADY_PAID'; end if;
  if v_outcome <> 'DELIVERY_TO_DORZIM' and v_current_status not in ('pastrim', 'pastrimi') then raise exception 'ORDER_NOT_IN_PASTRIM'; end if;
  if v_outcome = 'DELIVERY_TO_DORZIM' and v_current_status not in ('pastrim', 'pastrimi', 'gati') then raise exception 'ORDER_NOT_READY_FOR_DELIVERY'; end if;
  if abs(v_debt - v_expected_debt) > 0.009 then
    raise exception 'BASE_PAYMENT_STALE_DEBT expected=% actual=%', v_expected_debt, v_debt;
  end if;
  if v_amount - v_debt > 0.009 then raise exception 'BASE_PAYMENT_OVER_DEBT'; end if;
  if v_outcome = 'CLIENT_PICKED_UP_TO_DORZIM' and abs(v_amount - v_debt) > 0.009 then
    raise exception 'PICKUP_REQUIRES_FULL_PAYMENT';
  end if;

  if nullif(pg_catalog.regexp_replace(coalesce(p_order_code, ''), '[^0-9]', '', 'g'), '') is not null then
    begin
      v_order_code := pg_catalog.regexp_replace(p_order_code, '[^0-9]', '', 'g')::bigint;
    exception when numeric_value_out_of_range then
      v_order_code := v_order.code;
    end;
  else
    v_order_code := v_order.code;
  end if;

  insert into public.arka_pending_payments (
    order_id, amount, type, status, note, client_name, client_phone,
    order_code, created_by_pin, created_by_name, source_module,
    idempotency_key, created_at, updated_at
  ) values (
    p_order_id, v_amount, 'IN', 'PENDING',
    concat('[OUTCOME:', v_outcome, '] ', coalesce(nullif(btrim(p_note), ''), concat('PAGESA ', v_amount, '€'))),
    coalesce(nullif(btrim(p_client_name), ''), v_order.client_name),
    coalesce(nullif(btrim(p_client_phone), ''), v_order.client_phone),
    v_order_code, btrim(p_actor_pin), coalesce(v_actor.name, nullif(btrim(p_actor_name), '')),
    'BASE', v_idempotency_key, v_now, v_now
  ) returning * into v_payment;

  v_next_paid := round(v_paid + v_amount, 2);
  v_next_debt := round(greatest(0, v_total - v_next_paid), 2);
  v_next_status := case when v_outcome in ('CLIENT_PICKED_UP_TO_DORZIM', 'DELIVERY_TO_DORZIM') then 'dorzim' else 'pastrim' end;
  v_next_data := v_data || jsonb_build_object(
    'status', v_next_status,
    'clientPaid', v_next_paid,
    'paid', v_next_paid,
    'debt', v_next_debt,
    'isPaid', v_next_debt = 0,
    'updated_at', v_now
  );
  v_next_data := pg_catalog.jsonb_set(
    v_next_data,
    '{pay}',
    v_pay || jsonb_build_object(
      'euro', v_total,
      'paid', v_next_paid,
      'arkaRecordedPaid', v_next_paid,
      'debt', v_next_debt,
      'method', 'CASH'
    ),
    true
  );
  if v_outcome in ('CLIENT_PICKED_UP_TO_DORZIM', 'DELIVERY_TO_DORZIM') then
    v_next_data := v_next_data || jsonb_build_object('picked_up_at', v_now, 'delivered_at', v_now);
  else
    v_next_data := v_next_data || jsonb_build_object('prepaid_at', v_now, 'prepaid_by_pin', btrim(p_actor_pin), 'prepaid_by_name', coalesce(v_actor.name, p_actor_name));
  end if;

  update public.orders
  set status = v_next_status,
      data = v_next_data,
      price_total = v_total,
      paid = v_next_paid,
      paid_cash = v_next_paid,
      is_paid_upfront = case when v_outcome = 'PREPAY_STAYS_PASTRIMI' and v_next_debt = 0 then true else is_paid_upfront end,
      picked_up_at = case when v_outcome in ('CLIENT_PICKED_UP_TO_DORZIM', 'DELIVERY_TO_DORZIM') then v_now else picked_up_at end,
      delivered_at = case when v_outcome in ('CLIENT_PICKED_UP_TO_DORZIM', 'DELIVERY_TO_DORZIM') then v_now else delivered_at end,
      updated_at = v_now
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'existing', false,
    'payment', to_jsonb(v_payment),
    'row', to_jsonb(v_payment),
    'order', to_jsonb(v_order),
    'idempotencyKey', v_idempotency_key,
    'paymentOutcome', v_outcome
  );
end;
$$;

revoke execute on function public.record_base_order_cash_payment_atomic_v1(
  bigint, numeric, numeric, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.record_base_order_cash_payment_atomic_v1(
  bigint, numeric, numeric, text, text, text, text, text, text, text, text, text, text
) to service_role;

comment on function public.record_base_order_cash_payment_atomic_v1(
  bigint, numeric, numeric, text, text, text, text, text, text, text, text, text, text
) is 'Atomic service-role-only BASE cash payment with stale-balance, idempotency and lifecycle guards.';
