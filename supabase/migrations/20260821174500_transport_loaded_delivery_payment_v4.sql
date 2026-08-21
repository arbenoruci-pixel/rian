-- Explicit atomic payment + delivery support for loaded transport orders.
-- The service-role API requires confirmDelivery=true before invoking this path.

create or replace function public.transport_collect_client_payment_v1(
  p_order_id uuid,
  p_actor_pin text,
  p_amount_received numeric,
  p_method text default 'CASH',
  p_note text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.transport_orders%rowtype;
  v_actor public.users%rowtype;
  v_receivable public.transport_receivables%rowtype;
  v_batch public.transport_payment_batches%rowtype;
  v_alloc_order public.transport_orders%rowtype;
  v_data jsonb;
  v_pay jsonb;
  v_total numeric(12,2);
  v_json_paid numeric(12,2);
  v_arka_paid numeric(12,2);
  v_paid numeric(12,2);
  v_current_outstanding numeric(12,2);
  v_total_due numeric(12,2);
  v_received numeric(12,2) := round(coalesce(p_amount_received, 0), 2);
  v_applied numeric(12,2);
  v_change numeric(12,2);
  v_remaining numeric(12,2);
  v_allocate numeric(12,2);
  v_new_outstanding numeric(12,2);
  v_new_paid numeric(12,2);
  v_new_arka numeric(12,2);
  v_payment_id bigint;
  v_alloc_no integer := 0;
  v_now timestamptz := now();
  v_status text;
  v_is_delivery boolean := false;
  v_client_id uuid;
  v_service_m2 numeric(12,4) := 0;
  v_collectible_m2 numeric(12,4) := 0;
  v_prior_commission_m2 numeric(12,4) := 0;
  v_commission_m2 numeric(12,4) := 0;
  v_current_cash_applied numeric(12,2) := 0;
  v_current_debt_remaining numeric(12,2) := 0;
  v_owner_matches boolean := false;
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_payments jsonb := '[]'::jsonb;
  v_allocations jsonb := '[]'::jsonb;
  r public.transport_receivables%rowtype;
begin
  if v_received <= 0 then
    raise exception 'AMOUNT_INVALID';
  end if;
  if upper(trim(coalesce(p_method, 'CASH'))) <> 'CASH' then
    raise exception 'ONLY_CASH_SUPPORTED';
  end if;
  if v_key is null then
    raise exception 'PAYMENT_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if length(v_key) > 240 then
    raise exception 'PAYMENT_IDEMPOTENCY_KEY_TOO_LONG';
  end if;

  select * into v_actor
  from public.users
  where pin = trim(coalesce(p_actor_pin, ''))
    and is_active = true
  limit 1;
  if not found then
    raise exception 'ACTOR_NOT_FOUND_OR_DISABLED';
  end if;

  select client_id into v_client_id
  from public.transport_orders
  where id = p_order_id;
  if not found then
    raise exception 'TRANSPORT_ORDER_NOT_FOUND';
  end if;
  if v_client_id is null then
    raise exception 'TRANSPORT_CLIENT_ID_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('transport-receivables-v3:' || v_client_id::text, 0));

  select * into v_order
  from public.transport_orders
  where id = p_order_id
  for update;
  if not found then
    raise exception 'TRANSPORT_ORDER_NOT_FOUND';
  end if;
  if v_order.client_id is distinct from v_client_id then
    raise exception 'TRANSPORT_ORDER_CLIENT_CHANGED' using errcode = '40001';
  end if;

  select * into v_batch
  from public.transport_payment_batches
  where idempotency_key = v_key;
  if found then
    if v_batch.current_transport_order_id is distinct from p_order_id
       or v_batch.amount_received is distinct from v_received
       or upper(coalesce(v_batch.method, '')) <> 'CASH'
       or v_batch.created_by_pin is distinct from v_actor.pin then
      raise exception 'PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';
    end if;

    if v_batch.status <> 'CONFIRMED' then
      raise exception 'PAYMENT_IDEMPOTENCY_BATCH_NOT_CONFIRMED';
    end if;
    if (
      select round(coalesce(sum(a.amount), 0), 2)
      from public.transport_payment_allocations a
      where a.batch_id = v_batch.id
    ) <> v_batch.amount_applied then
      raise exception 'PAYMENT_IDEMPOTENCY_ALLOCATION_SUM_MISMATCH';
    end if;
    if exists (
      select 1
      from public.transport_payment_allocations a
      join public.arka_pending_payments p on p.id = a.arka_payment_id
      where a.batch_id = v_batch.id
        and p.status not in ('ACCEPTED_BY_DISPATCH', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL')
    ) then
      raise exception 'PAYMENT_IDEMPOTENCY_ARKA_NOT_ACTIVE';
    end if;

    select coalesce(jsonb_agg(to_jsonb(a) order by a.allocation_order), '[]'::jsonb)
      into v_allocations
    from public.transport_payment_allocations a
    where a.batch_id = v_batch.id;
    select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb)
      into v_payments
    from public.arka_pending_payments p
    join public.transport_payment_allocations a on a.arka_payment_id = p.id
    where a.batch_id = v_batch.id;
    select * into v_order from public.transport_orders where id = p_order_id;
    return public.transport_client_receivable_summary_v1(p_order_id, v_order.client_id)
      || jsonb_build_object(
        'duplicate', true,
        'paymentVerified', true,
        'batch', to_jsonb(v_batch),
        'payments', v_payments,
        'allocations', v_allocations,
        'order', to_jsonb(v_order)
      );
  end if;

  v_status := lower(trim(coalesce(v_order.status, v_order.data ->> 'status', '')));
  if v_status not in ('loaded', 'ngarkuar', 'ngarkim', 'delivery', 'dorzim', 'dorezim', 'dorëzim', 'done', 'completed', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar') then
    raise exception 'TRANSPORT_ORDER_NOT_IN_DELIVERY';
  end if;
  v_is_delivery := v_status in ('loaded', 'ngarkuar', 'ngarkim', 'delivery', 'dorzim', 'dorezim', 'dorëzim');

  select * into v_receivable
  from public.transport_receivables
  where transport_order_id = p_order_id;

  v_data := coalesce(v_order.data, '{}'::jsonb);
  v_pay := coalesce(v_data -> 'pay', '{}'::jsonb);
  v_total := greatest(
    0,
    public.transport_receivable_parse_money_v1(
      coalesce(v_pay ->> 'euro', v_pay ->> 'total', v_data ->> 'total', '0')
    )
  );
  v_json_paid := greatest(
    public.transport_receivable_parse_money_v1(v_pay ->> 'paid'),
    public.transport_receivable_parse_money_v1(v_pay ->> 'arkaRecordedPaid'),
    public.transport_receivable_parse_money_v1(v_data ->> 'clientPaid'),
    0
  );
  v_arka_paid := public.transport_order_active_arka_paid_v1(v_order.id);
  v_paid := least(v_total, greatest(v_json_paid, v_arka_paid, 0));
  v_current_outstanding := greatest(0, round(v_total - v_paid, 2));

  if v_receivable.id is null and v_current_outstanding > 0 and v_is_delivery then
    insert into public.transport_receivables (
      transport_order_id, client_id, client_tcode, client_name, client_phone,
      original_amount, opening_paid_amount, outstanding_amount, status,
      due_date, delivered_at, created_by_pin, created_by_name, created_by_role,
      note, source, idempotency_key
    ) values (
      v_order.id,
      v_order.client_id,
      coalesce(nullif(v_order.client_tcode, ''), nullif(v_order.code_str, '')),
      v_order.client_name,
      v_order.client_phone,
      v_total,
      least(v_paid, v_total),
      v_current_outstanding,
      case when v_paid > 0 then 'PARTIALLY_PAID' else 'OPEN' end,
      null,
      v_now,
      v_actor.pin,
      v_actor.name,
      v_actor.role,
      nullif(trim(coalesce(p_note, '')), ''),
      'DELIVERY',
      'TRANSPORT_RECEIVABLE:' || v_order.id::text
    )
    returning * into v_receivable;
  end if;

  if v_is_delivery then
    -- Delivery is a fulfillment event even when the payment is partial.
    v_pay := v_pay || jsonb_build_object(
      'euro', v_total,
      'paid', v_paid,
      'arkaRecordedPaid', greatest(0, public.transport_receivable_parse_money_v1(v_pay ->> 'arkaRecordedPaid')),
      'debt', v_current_outstanding
    );
    v_data := jsonb_set(v_data, '{pay}', v_pay, true)
      || jsonb_build_object(
        'status', 'done',
        'state', 'done',
        'clientPaid', v_paid,
        'paid', v_paid,
        'debt', v_current_outstanding,
        'isPaid', v_current_outstanding <= 0,
        'paid_done', v_current_outstanding <= 0,
        'payment_state', case when v_current_outstanding <= 0 then 'PAID' when v_paid > 0 then 'PARTIALLY_PAID' else 'DEBT' end,
        'delivery_payment_status', case when v_current_outstanding <= 0 then 'PAID' when v_paid > 0 then 'PARTIALLY_PAID' else 'DEBT' end,
        'delivery_with_debt', v_current_outstanding > 0,
        'debt_amount', v_current_outstanding,
        'delivered_at', coalesce(v_data ->> 'delivered_at', v_now::text),
        'done_at', coalesce(v_data ->> 'done_at', v_now::text),
        'completed_at', coalesce(v_data ->> 'completed_at', v_now::text),
        'delivered_by_pin', v_actor.pin,
        'delivered_by_name', v_actor.name,
        'updated_at', v_now
      );
    update public.transport_orders
    set status = 'done', data = v_data, updated_at = v_now
    where id = v_order.id
    returning * into v_order;

  end if;

  select coalesce(sum(outstanding_amount), 0)
    into v_total_due
  from public.transport_receivables
  where client_id = v_order.client_id
    and status in ('OPEN', 'PARTIALLY_PAID')
    and outstanding_amount > 0;
  if v_total_due <= 0 then
    raise exception 'CLIENT_HAS_NO_OUTSTANDING_BALANCE';
  end if;

  v_applied := least(v_received, round(v_total_due, 2));
  v_change := round(v_received - v_applied, 2);
  v_remaining := v_applied;

  insert into public.transport_payment_batches (
    client_id, current_transport_order_id,
    amount_received, amount_applied, change_amount,
    method, status, created_by_pin, created_by_name, created_by_role,
    note, idempotency_key
  ) values (
    v_order.client_id, v_order.id,
    v_received, v_applied, v_change,
    'CASH', 'CONFIRMED', v_actor.pin, v_actor.name, v_actor.role,
    nullif(trim(coalesce(p_note, '')), ''), v_key
  )
  returning * into v_batch;

  for r in
    select *
    from public.transport_receivables
    where client_id = v_order.client_id
      and status in ('OPEN', 'PARTIALLY_PAID')
      and outstanding_amount > 0
    order by delivered_at, created_at, id
    for update
  loop
    exit when v_remaining <= 0;
    v_allocate := least(v_remaining, r.outstanding_amount);
    if v_allocate <= 0 then
      continue;
    end if;
    v_alloc_no := v_alloc_no + 1;

    select * into v_alloc_order
    from public.transport_orders
    where id = r.transport_order_id
    for update;
    if not found then
      raise exception 'RECEIVABLE_ORDER_NOT_FOUND';
    end if;

    v_data := coalesce(v_alloc_order.data, '{}'::jsonb);
    v_pay := coalesce(v_data -> 'pay', '{}'::jsonb);
    v_service_m2 := greatest(
      0,
      public.transport_receivable_parse_money_v1(v_pay ->> 'm2')
    );
    if v_alloc_order.transport_id is not null then
      v_owner_matches := coalesce(v_alloc_order.transport_id::text, '') in (
        coalesce(v_actor.id::text, ''),
        coalesce(v_actor.pin, ''),
        coalesce(v_actor.transport_id::text, ''),
        coalesce(v_actor.tid::text, '')
      );
    else
      v_owner_matches := (
        coalesce(v_data ->> 'transport_id', '') in (
          coalesce(v_actor.id::text, ''),
          coalesce(v_actor.pin, ''),
          coalesce(v_actor.transport_id::text, ''),
          coalesce(v_actor.tid::text, '')
        )
        or coalesce(v_data ->> 'transport_pin', '') = coalesce(v_actor.pin, '')
        or coalesce(v_data ->> 'driver_pin', '') = coalesce(v_actor.pin, '')
        or coalesce(v_data ->> 'assigned_to_pin', '') = coalesce(v_actor.pin, '')
      );
    end if;

    select coalesce(sum(a.commission_m2), 0)
      into v_prior_commission_m2
    from public.transport_payment_allocations a
    join public.transport_payment_batches b on b.id = a.batch_id
    where a.receivable_id = r.id
      and b.status = 'CONFIRMED';

    v_commission_m2 := 0;
    v_collectible_m2 := case
      when r.original_amount > 0 then round(
        v_service_m2 * greatest(0, r.original_amount - r.opening_paid_amount) / r.original_amount,
        4
      )
      else 0
    end;
    if v_owner_matches
       and v_actor.is_hybrid_transport is true
       and v_actor.pay_commission_enabled is true
       and upper(coalesce(v_actor.pay_cash_mode, '')) = 'HYBRID_COMMISSION'
       and greatest(coalesce(v_actor.pay_commission_rate_m2, 0), coalesce(v_actor.commission_rate_m2, 0)) > 0
       and r.original_amount > 0 then
      if round(r.outstanding_amount - v_allocate, 2) <= 0 then
        v_commission_m2 := greatest(0, round(v_collectible_m2 - v_prior_commission_m2, 4));
      else
        v_commission_m2 := least(
          greatest(0, round(v_collectible_m2 - v_prior_commission_m2, 4)),
          greatest(0, round(v_service_m2 * v_allocate / r.original_amount, 4))
        );
      end if;
    end if;

    insert into public.arka_pending_payments (
      idempotency_key, status, amount, type, source_module,
      order_id, order_code, transport_order_id, transport_code_str, transport_m2,
      client_name, client_phone, note,
      created_by_pin, created_by_name,
      handed_by_pin, handed_by_name, handed_by_role,
      created_at, updated_at
    ) values (
      'TRANSPORT_CLIENT_PAYMENT:' || v_batch.id::text || ':' || r.transport_order_id::text,
      'COLLECTED',
      v_allocate,
      'TRANSPORT',
      'TRANSPORT',
      null,
      null,
      r.transport_order_id,
      r.client_tcode,
      v_commission_m2,
      r.client_name,
      r.client_phone,
      'PAGESË KLIENTI ' || r.client_tcode || ' • NDARJE ' || v_alloc_no::text || ' • BATCH ' || v_batch.id::text,
      v_actor.pin,
      v_actor.name,
      v_actor.pin,
      v_actor.name,
      v_actor.role,
      v_now,
      v_now
    )
    returning id into v_payment_id;

    insert into public.transport_payment_allocations (
      batch_id, receivable_id, arka_payment_id, amount, commission_m2, allocation_order
    ) values (
      v_batch.id, r.id, v_payment_id, v_allocate, v_commission_m2, v_alloc_no
    );

    if (
      select coalesce(sum(a.commission_m2), 0)
      from public.transport_payment_allocations a
      join public.transport_payment_batches b on b.id = a.batch_id
      where a.receivable_id = r.id
        and b.status = 'CONFIRMED'
    ) > v_collectible_m2 + 0.0001 then
      raise exception 'TRANSPORT_COMMISSION_M2_EXCEEDS_SERVICE';
    end if;

    v_new_outstanding := round(r.outstanding_amount - v_allocate, 2);
    update public.transport_receivables
    set outstanding_amount = v_new_outstanding,
        status = case
          when v_new_outstanding <= 0 then 'PAID'
          else 'PARTIALLY_PAID'
        end,
        updated_at = v_now
    where id = r.id;

    v_data := coalesce(v_alloc_order.data, '{}'::jsonb);
    v_pay := coalesce(v_data -> 'pay', '{}'::jsonb);
    -- The receivable ledger is authoritative for total paid. ARKA is read back
    -- from active UUID-linked rows, so a retry or stale legacy JSON cannot add twice.
    v_new_paid := round(r.original_amount - v_new_outstanding, 2);
    v_new_arka := public.transport_order_active_arka_paid_v1(v_alloc_order.id);
    v_pay := v_pay || jsonb_build_object(
      'paid', v_new_paid,
      'arkaRecordedPaid', v_new_arka,
      'debt', v_new_outstanding,
      'method', 'CASH',
      'last_paid_at', v_now
    );
    v_data := jsonb_set(v_data, '{pay}', v_pay, true)
      || jsonb_build_object(
        'status', 'done',
        'state', 'done',
        'clientPaid', v_new_paid,
        'paid', v_new_paid,
        'debt', v_new_outstanding,
        'isPaid', v_new_outstanding <= 0,
        'paid_done', v_new_outstanding <= 0,
        'payment_state', case when v_new_outstanding <= 0 then 'PAID' else 'PARTIALLY_PAID' end,
        'delivery_payment_status', case when v_new_outstanding <= 0 then 'PAID' else 'PARTIALLY_PAID' end,
        'delivery_with_debt', v_new_outstanding > 0,
        'debt_amount', v_new_outstanding,
        'updated_at', v_now
      );
    if v_new_outstanding <= 0 then
      v_data := v_data || jsonb_build_object('paid_at', coalesce(v_data ->> 'paid_at', v_now::text));
    end if;

    update public.transport_orders
    set status = 'done', data = v_data, updated_at = v_now
    where id = v_alloc_order.id;

    v_remaining := round(v_remaining - v_allocate, 2);
  end loop;

  if v_remaining <> 0 then
    raise exception 'PAYMENT_ALLOCATION_INCOMPLETE';
  end if;

  if v_is_delivery then
    select coalesce(sum(a.amount), 0)
      into v_current_cash_applied
    from public.transport_payment_allocations a
    join public.transport_receivables r2 on r2.id = a.receivable_id
    where a.batch_id = v_batch.id
      and r2.transport_order_id = p_order_id;

    select coalesce(outstanding_amount, 0)
      into v_current_debt_remaining
    from public.transport_receivables
    where transport_order_id = p_order_id;
    if not found then
      v_current_debt_remaining := 0;
    end if;

    if round(
      coalesce(v_receivable.opening_paid_amount, 0)
      + v_current_cash_applied
      + v_current_debt_remaining,
      2
    ) <> round(v_receivable.original_amount, 2) then
      raise exception 'DELIVERY_EVENT_ALLOCATION_MISMATCH';
    end if;

    insert into public.transport_delivery_events (
      transport_order_id, client_id, receivable_id, payment_batch_id, event_type,
      cash_received, debt_created, due_date,
      actor_pin, actor_name, actor_role, note, idempotency_key
    ) values (
      v_order.id, v_order.client_id, v_receivable.id, v_batch.id, 'DELIVERED_WITH_PAYMENT',
      round(v_current_cash_applied, 2), round(v_current_debt_remaining, 2), null,
      v_actor.pin, v_actor.name, v_actor.role,
      nullif(trim(coalesce(p_note, '')), ''),
      'TRANSPORT_DELIVERY_EVENT:' || v_order.id::text
    );
  end if;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.allocation_order), '[]'::jsonb)
    into v_allocations
  from public.transport_payment_allocations a
  where a.batch_id = v_batch.id;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb)
    into v_payments
  from public.arka_pending_payments p
  join public.transport_payment_allocations a on a.arka_payment_id = p.id
  where a.batch_id = v_batch.id;
  select * into v_order from public.transport_orders where id = p_order_id;

  return public.transport_client_receivable_summary_v1(p_order_id, v_order.client_id)
    || jsonb_build_object(
      'duplicate', false,
      'paymentVerified', true,
      'batch', to_jsonb(v_batch),
      'payments', v_payments,
      'allocations', v_allocations,
      'order', to_jsonb(v_order)
    );
end;
$$;


revoke execute on function public.transport_collect_client_payment_v1(uuid, text, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.transport_collect_client_payment_v1(uuid, text, numeric, text, text, text) to service_role;
