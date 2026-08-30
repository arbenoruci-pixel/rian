-- Atomic client-wide BASE debt settlement.
-- One cash tender may settle several canonical client visits, oldest first.

create table if not exists public.base_payment_batches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  anchor_order_id bigint not null references public.orders(id) on delete restrict,
  amount_given numeric(12,2) not null,
  amount_applied numeric(12,2) not null,
  change_amount numeric(12,2) not null default 0,
  expected_total_debt numeric(12,2) not null,
  expected_order_debts jsonb not null,
  payment_outcome text not null,
  status text not null default 'CONFIRMED',
  created_by_pin text not null,
  created_by_name text,
  created_by_role text,
  note text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  constraint base_payment_batches_amounts_ck check (
    amount_given > 0
    and amount_applied > 0
    and amount_applied <= amount_given
    and change_amount = amount_given - amount_applied
    and expected_total_debt > 0
    and amount_applied <= expected_total_debt
  ),
  constraint base_payment_batches_snapshot_ck check (
    jsonb_typeof(expected_order_debts) = 'array'
    and jsonb_array_length(expected_order_debts) > 0
  ),
  constraint base_payment_batches_outcome_ck check (
    payment_outcome in ('PREPAY_STAYS_PASTRIMI', 'CLIENT_PICKED_UP_TO_DORZIM')
  ),
  constraint base_payment_batches_status_ck check (status in ('CONFIRMED', 'VOIDED'))
);

create table if not exists public.base_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.base_payment_batches(id) on delete restrict,
  order_id bigint not null references public.orders(id) on delete restrict,
  arka_payment_id bigint not null unique references public.arka_pending_payments(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  debt_before numeric(12,2) not null check (debt_before > 0),
  debt_after numeric(12,2) not null check (debt_after >= 0),
  allocation_order integer not null check (allocation_order > 0),
  created_at timestamptz not null default now(),
  constraint base_payment_allocations_math_ck check (debt_before = amount + debt_after),
  unique (batch_id, order_id),
  unique (batch_id, allocation_order)
);

create index if not exists idx_orders_client_id_created
  on public.orders(client_id, created_at, id)
  where client_id is not null;
create index if not exists idx_base_payment_batches_client_created
  on public.base_payment_batches(client_id, created_at desc);
create index if not exists idx_base_payment_batches_anchor
  on public.base_payment_batches(anchor_order_id);
create index if not exists idx_base_payment_allocations_order
  on public.base_payment_allocations(order_id, created_at desc);

alter table public.base_payment_batches enable row level security;
alter table public.base_payment_allocations enable row level security;

revoke all on table public.base_payment_batches from public, anon, authenticated, service_role;
revoke all on table public.base_payment_allocations from public, anon, authenticated, service_role;
grant select on table public.base_payment_batches to service_role;
grant select on table public.base_payment_allocations to service_role;

create or replace function public.record_base_client_cash_payment_atomic_v1(
  p_anchor_order_id bigint,
  p_amount numeric,
  p_cash_given numeric,
  p_change_amount numeric,
  p_expected_total_debt numeric,
  p_expected_order_debts jsonb,
  p_expected_client_id uuid,
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
  v_actor public.users%rowtype;
  v_anchor public.orders%rowtype;
  v_order public.orders%rowtype;
  v_updated_order public.orders%rowtype;
  v_payment public.arka_pending_payments%rowtype;
  v_batch public.base_payment_batches%rowtype;
  v_existing_batch public.base_payment_batches%rowtype;
  v_item jsonb;
  v_data jsonb;
  v_pay jsonb;
  v_next_data jsonb;
  v_expected_snapshot jsonb := '[]'::jsonb;
  v_actual_snapshot jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
  v_orders jsonb := '[]'::jsonb;
  v_allocations jsonb := '[]'::jsonb;
  v_return_payment jsonb := null;
  v_return_order jsonb := null;
  v_order_ids bigint[] := array[]::bigint[];
  v_order_id bigint;
  v_client_id uuid;
  v_expected_debt numeric;
  v_actual_total numeric := 0;
  v_total numeric := 0;
  v_paid numeric := 0;
  v_debt numeric := 0;
  v_allocate numeric := 0;
  v_next_paid numeric := 0;
  v_next_debt numeric := 0;
  v_remaining numeric;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_cash_given numeric := round(coalesce(p_cash_given, p_amount, 0), 2);
  v_change numeric := round(coalesce(p_change_amount, 0), 2);
  v_expected_total numeric := round(coalesce(p_expected_total_debt, -1), 2);
  v_outcome text := upper(btrim(coalesce(p_payment_outcome, '')));
  v_requested_status text := lower(btrim(coalesce(p_status_on_full_payment, '')));
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_current_status text;
  v_next_status text;
  v_alloc_no integer := 0;
  v_payment_id bigint;
  v_now timestamptz := clock_timestamp();
begin
  if p_anchor_order_id is null or p_anchor_order_id <= 0 then raise exception 'ORDER_ID_INVALID'; end if;
  if v_amount <= 0 then raise exception 'AMOUNT_INVALID'; end if;
  if v_cash_given < v_amount then raise exception 'CASH_GIVEN_BELOW_APPLIED'; end if;
  if abs(v_change - (v_cash_given - v_amount)) > 0.009 then raise exception 'CHANGE_AMOUNT_MISMATCH'; end if;
  if v_expected_total <= 0 then raise exception 'EXPECTED_DEBT_REQUIRED'; end if;
  if v_amount - v_expected_total > 0.009 then raise exception 'BASE_CLIENT_PAYMENT_OVER_DEBT'; end if;
  if btrim(coalesce(p_actor_pin, '')) = '' then raise exception 'ACTOR_PIN_REQUIRED'; end if;
  if v_idempotency_key = '' then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if length(v_idempotency_key) > 240 then raise exception 'IDEMPOTENCY_KEY_TOO_LONG'; end if;
  if p_expected_client_id is null then raise exception 'CANONICAL_CLIENT_ID_REQUIRED'; end if;
  if jsonb_typeof(p_expected_order_debts) <> 'array' or jsonb_array_length(p_expected_order_debts) = 0 then
    raise exception 'EXPECTED_ORDER_DEBTS_REQUIRED';
  end if;
  if v_outcome not in ('PREPAY_STAYS_PASTRIMI', 'CLIENT_PICKED_UP_TO_DORZIM') then
    raise exception 'PAYMENT_OUTCOME_INVALID';
  end if;
  if (v_outcome = 'PREPAY_STAYS_PASTRIMI' and v_requested_status <> 'pastrim')
     or (v_outcome = 'CLIENT_PICKED_UP_TO_DORZIM' and v_requested_status <> 'dorzim') then
    raise exception 'PAYMENT_OUTCOME_STATUS_MISMATCH';
  end if;
  if v_outcome = 'CLIENT_PICKED_UP_TO_DORZIM'
     and abs(v_amount - v_expected_total) > 0.009 then
    raise exception 'PICKUP_REQUIRES_FULL_CLIENT_DEBT';
  end if;

  for v_item in select value from jsonb_array_elements(p_expected_order_debts)
  loop
    if coalesce(v_item->>'orderId', v_item->>'order_id', '') !~ '^[0-9]+$' then
      raise exception 'EXPECTED_ORDER_ID_INVALID';
    end if;
    v_order_id := coalesce(v_item->>'orderId', v_item->>'order_id')::bigint;
    v_expected_debt := round(coalesce(public.base_bonus_safe_numeric_v2(v_item->>'debt'), -1), 2);
    if v_order_id <= 0 or v_expected_debt <= 0 then raise exception 'EXPECTED_ORDER_DEBT_INVALID'; end if;
    if v_order_id = any(v_order_ids) then raise exception 'EXPECTED_ORDER_DUPLICATE'; end if;
    v_order_ids := array_append(v_order_ids, v_order_id);
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('orderId', x.order_id, 'debt', x.debt) order by x.order_id), '[]'::jsonb)
    into v_expected_snapshot
  from (
    select
      coalesce(value->>'orderId', value->>'order_id')::bigint as order_id,
      round(public.base_bonus_safe_numeric_v2(value->>'debt'), 2) as debt
    from jsonb_array_elements(p_expected_order_debts)
  ) x;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('base_client_payment_idem:' || v_idempotency_key, 0));

  select * into v_existing_batch
  from public.base_payment_batches
  where idempotency_key = v_idempotency_key
  limit 1;

  if found then
    if v_existing_batch.anchor_order_id is distinct from p_anchor_order_id
       or v_existing_batch.client_id is distinct from p_expected_client_id
       or round(v_existing_batch.amount_given, 2) is distinct from v_cash_given
       or round(v_existing_batch.amount_applied, 2) is distinct from v_amount
       or round(v_existing_batch.change_amount, 2) is distinct from v_change
       or round(v_existing_batch.expected_total_debt, 2) is distinct from v_expected_total
       or v_existing_batch.expected_order_debts is distinct from v_expected_snapshot
       or v_existing_batch.payment_outcome is distinct from v_outcome
       or v_existing_batch.created_by_pin is distinct from btrim(p_actor_pin)
       or v_existing_batch.status <> 'CONFIRMED' then
      raise exception 'BASE_CLIENT_PAYMENT_IDEMPOTENCY_CONFLICT';
    end if;

    select coalesce(jsonb_agg(to_jsonb(p) order by a.allocation_order), '[]'::jsonb),
           coalesce(jsonb_agg(to_jsonb(a) order by a.allocation_order), '[]'::jsonb)
      into v_payments, v_allocations
    from public.base_payment_allocations a
    join public.arka_pending_payments p on p.id = a.arka_payment_id
    where a.batch_id = v_existing_batch.id;

    if not exists (select 1 from public.base_payment_allocations a where a.batch_id = v_existing_batch.id) then
      raise exception 'BASE_CLIENT_PAYMENT_BATCH_EMPTY';
    end if;
    if abs((select coalesce(sum(a.amount), 0) from public.base_payment_allocations a where a.batch_id = v_existing_batch.id) - v_existing_batch.amount_applied) > 0.009 then
      raise exception 'BASE_CLIENT_PAYMENT_ALLOCATION_SUM_MISMATCH';
    end if;
    if abs((select coalesce(sum(p.amount), 0)
            from public.base_payment_allocations a
            join public.arka_pending_payments p on p.id = a.arka_payment_id
            where a.batch_id = v_existing_batch.id) - v_existing_batch.amount_applied) > 0.009 then
      raise exception 'BASE_CLIENT_PAYMENT_ARKA_SUM_MISMATCH';
    end if;
    if exists (
      select 1
      from public.base_payment_allocations a
      left join public.arka_pending_payments p on p.id = a.arka_payment_id
      where a.batch_id = v_existing_batch.id
        and (
          p.id is null
          or p.order_id is distinct from a.order_id
          or round(coalesce(p.amount, 0), 2) is distinct from round(a.amount, 2)
          or upper(btrim(coalesce(p.type, ''))) <> 'IN'
          or upper(btrim(coalesce(p.source_module, ''))) <> 'BASE'
          or nullif(btrim(coalesce(p.status, '')), '') is null
          or upper(btrim(coalesce(p.status, ''))) = 'VOIDED'
          or p.idempotency_key is distinct from concat('BASE_CLIENT_PAYMENT:', v_existing_batch.id::text, ':', a.order_id::text)
        )
    ) then
      raise exception 'BASE_CLIENT_PAYMENT_ARKA_INVARIANT_FAILED';
    end if;

    select coalesce(jsonb_agg(to_jsonb(o) order by o.id), '[]'::jsonb)
      into v_orders
    from public.orders o
    where o.id = any(v_order_ids) or o.id = p_anchor_order_id;

    select to_jsonb(o) into v_return_order from public.orders o where o.id = p_anchor_order_id;
    select to_jsonb(p) into v_return_payment
    from public.base_payment_allocations a
    join public.arka_pending_payments p on p.id = a.arka_payment_id
    where a.batch_id = v_existing_batch.id
    order by case when a.order_id = p_anchor_order_id then 0 else 1 end, a.allocation_order
    limit 1;
    if v_return_payment is null or v_return_order is null then
      raise exception 'BASE_CLIENT_PAYMENT_RETURN_ROW_MISSING';
    end if;

    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'existing', true,
      'batch', to_jsonb(v_existing_batch), 'payments', v_payments,
      'allocations', v_allocations, 'orders', v_orders,
      'payment', v_return_payment, 'row', v_return_payment, 'order', v_return_order,
      'idempotencyKey', v_idempotency_key, 'paymentOutcome', v_outcome
    );
  end if;

  select * into v_actor
  from public.users
  where pin = btrim(p_actor_pin) and is_active is true
  limit 1;
  if not found then raise exception 'ACTOR_NOT_ACTIVE'; end if;

  select * into v_anchor from public.orders where id = p_anchor_order_id;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_anchor.client_id is null then raise exception 'CANONICAL_CLIENT_ID_REQUIRED'; end if;
  if v_anchor.client_id is distinct from p_expected_client_id then raise exception 'BASE_CLIENT_ID_MISMATCH'; end if;
  v_client_id := v_anchor.client_id;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('base_client_payment:' || v_client_id::text, 0));

  -- Lock every debt-capable sibling in deterministic visit order before
  -- checking the exact expected snapshot.
  for v_order in
    select *
    from public.orders
    where client_id = v_client_id
      and lower(btrim(coalesce(
        nullif(btrim(status), ''),
        nullif(btrim(data#>>'{data,status}'), ''),
        nullif(btrim(data->>'status'), ''),
        ''
      ))) in ('pastrim', 'gati', 'dorzim')
    order by created_at, id
    for update
  loop
    v_data := coalesce(v_order.data, '{}'::jsonb);
    if jsonb_typeof(v_data->'data') = 'object' then
      v_data := (v_data - 'data') || (v_data->'data');
    end if;
    v_pay := case when jsonb_typeof(v_data->'pay') = 'object' then v_data->'pay' else '{}'::jsonb end;
    v_total := round(greatest(
      0,
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'euro'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'total'), 0),
      coalesce(v_order.price_total, 0),
      coalesce(v_order.total, 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'price_total'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'total'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data#>>'{totals,total}'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data#>>'{totals,euro}'), 0)
    ), 2);
    v_paid := round(greatest(
      0,
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'paid'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'arkaRecordedPaid'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'clientPaid'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'paid'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'paid_cash'), 0),
      coalesce(v_order.paid, 0),
      coalesce(v_order.paid_cash, 0)
    ), 2);
    v_debt := case when v_total > 0 then round(greatest(0, v_total - v_paid), 2) else round(greatest(
      0,
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'debt_amount'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'debt'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data#>>'{payment_state,debt_remaining}'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'debt'), 0)
    ), 2) end;
    if v_debt > 0 then
      v_actual_snapshot := v_actual_snapshot || jsonb_build_array(jsonb_build_object('orderId', v_order.id, 'debt', v_debt));
      v_actual_total := round(v_actual_total + v_debt, 2);
    end if;
  end loop;

  select coalesce(jsonb_agg(value order by (value->>'orderId')::bigint), '[]'::jsonb)
    into v_actual_snapshot
  from jsonb_array_elements(v_actual_snapshot);

  if v_actual_snapshot is distinct from v_expected_snapshot then
    raise exception 'BASE_CLIENT_PAYMENT_STALE_DEBT expected=% actual=%', v_expected_snapshot, v_actual_snapshot;
  end if;
  if abs(v_actual_total - v_expected_total) > 0.009 then
    raise exception 'BASE_CLIENT_PAYMENT_STALE_TOTAL expected=% actual=%', v_expected_total, v_actual_total;
  end if;

  select * into v_anchor from public.orders where id = p_anchor_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_anchor.client_id is distinct from v_client_id
     or v_anchor.client_id is distinct from p_expected_client_id then
    raise exception 'BASE_CLIENT_ID_MISMATCH';
  end if;
  v_current_status := lower(btrim(coalesce(
    nullif(btrim(v_anchor.status), ''),
    nullif(btrim(v_anchor.data#>>'{data,status}'), ''),
    nullif(btrim(v_anchor.data->>'status'), ''),
    ''
  )));
  if v_current_status <> 'pastrim' then raise exception 'ANCHOR_ORDER_NOT_IN_PASTRIM'; end if;

  insert into public.base_payment_batches (
    client_id, anchor_order_id, amount_given, amount_applied, change_amount,
    expected_total_debt, expected_order_debts, payment_outcome, status,
    created_by_pin, created_by_name, created_by_role, note, idempotency_key, created_at
  ) values (
    v_client_id, p_anchor_order_id, v_cash_given, v_amount, v_change,
    v_expected_total, v_expected_snapshot, v_outcome, 'CONFIRMED',
    btrim(p_actor_pin), coalesce(v_actor.name, nullif(btrim(p_actor_name), '')),
    coalesce(v_actor.role, nullif(btrim(p_actor_role), '')),
    nullif(btrim(p_note), ''), v_idempotency_key, v_now
  ) returning * into v_batch;

  v_remaining := v_amount;
  for v_order in
    select *
    from public.orders
    where id = any(v_order_ids)
    order by created_at, id
    for update
  loop
    exit when v_remaining <= 0;
    if v_order.client_id is distinct from v_client_id then raise exception 'BASE_CLIENT_ORDER_IDENTITY_CONFLICT'; end if;

    v_data := coalesce(v_order.data, '{}'::jsonb);
    if jsonb_typeof(v_data->'data') = 'object' then
      v_data := (v_data - 'data') || (v_data->'data');
    end if;
    v_pay := case when jsonb_typeof(v_data->'pay') = 'object' then v_data->'pay' else '{}'::jsonb end;
    v_total := round(greatest(
      0,
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'euro'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'total'), 0),
      coalesce(v_order.price_total, 0),
      coalesce(v_order.total, 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'price_total'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'total'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data#>>'{totals,total}'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data#>>'{totals,euro}'), 0)
    ), 2);
    v_paid := round(greatest(
      0,
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'paid'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'arkaRecordedPaid'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'clientPaid'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'paid'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'paid_cash'), 0),
      coalesce(v_order.paid, 0),
      coalesce(v_order.paid_cash, 0)
    ), 2);
    v_debt := case when v_total > 0 then round(greatest(0, v_total - v_paid), 2) else round(greatest(
      0,
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'debt_amount'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data->>'debt'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_data#>>'{payment_state,debt_remaining}'), 0),
      coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'debt'), 0)
    ), 2) end;
    if v_debt <= 0 then continue; end if;
    if v_total <= 0 then v_total := round(v_paid + v_debt, 2); end if;

    v_allocate := least(v_remaining, v_debt);
    v_next_paid := round(v_paid + v_allocate, 2);
    v_next_debt := round(greatest(0, v_debt - v_allocate), 2);
    v_alloc_no := v_alloc_no + 1;

    insert into public.arka_pending_payments (
      order_id, amount, type, status, note, client_name, client_phone,
      order_code, created_by_pin, created_by_name, source_module,
      idempotency_key, created_at, updated_at
    ) values (
      v_order.id, v_allocate, 'IN', 'PENDING',
      concat('[BASE_CLIENT_BATCH:', v_batch.id::text, '] [OUTCOME:', v_outcome, '] ', coalesce(nullif(btrim(p_note), ''), concat('PAGESA ', v_amount, '€'))),
      coalesce(nullif(btrim(p_client_name), ''), v_order.client_name),
      coalesce(nullif(btrim(p_client_phone), ''), v_order.client_phone),
      v_order.code, btrim(p_actor_pin), coalesce(v_actor.name, nullif(btrim(p_actor_name), '')),
      'BASE', concat('BASE_CLIENT_PAYMENT:', v_batch.id::text, ':', v_order.id::text), v_now, v_now
    ) returning * into v_payment;

    insert into public.base_payment_allocations (
      batch_id, order_id, arka_payment_id, amount, debt_before, debt_after, allocation_order, created_at
    ) values (
      v_batch.id, v_order.id, v_payment.id, v_allocate, v_debt, v_next_debt, v_alloc_no, v_now
    );

    v_next_status := case
      when v_order.id = p_anchor_order_id and v_outcome = 'CLIENT_PICKED_UP_TO_DORZIM' then 'dorzim'
      else v_order.status
    end;
    v_next_data := v_data || jsonb_build_object(
      'status', v_next_status,
      'clientPaid', v_next_paid,
      'paid', v_next_paid,
      'debt', v_next_debt,
      'isPaid', v_next_debt = 0,
      'updated_at', v_now,
      'base_payment_batch_id', v_batch.id
    );
    v_next_data := pg_catalog.jsonb_set(
      v_next_data,
      '{pay}',
      v_pay || jsonb_build_object(
        'euro', v_total,
        'paid', v_next_paid,
        'arkaRecordedPaid', v_next_paid,
        'debt', v_next_debt,
        'method', 'CASH',
        'last_paid_at', v_now
      ),
      true
    );
    if v_order.id = p_anchor_order_id and v_outcome = 'CLIENT_PICKED_UP_TO_DORZIM' then
      v_next_data := v_next_data || jsonb_build_object('picked_up_at', v_now, 'delivered_at', v_now);
    elsif v_order.id = p_anchor_order_id then
      v_next_data := v_next_data || jsonb_build_object(
        'prepaid_at', v_now,
        'prepaid_by_pin', btrim(p_actor_pin),
        'prepaid_by_name', coalesce(v_actor.name, p_actor_name)
      );
    end if;

    update public.orders
    set status = v_next_status,
        data = v_next_data,
        price_total = v_total,
        paid = v_next_paid,
        paid_cash = v_next_paid,
        is_paid_upfront = case
          when v_order.id = p_anchor_order_id and v_outcome = 'PREPAY_STAYS_PASTRIMI' and v_next_debt = 0 then true
          else is_paid_upfront
        end,
        picked_up_at = case
          when v_order.id = p_anchor_order_id and v_outcome = 'CLIENT_PICKED_UP_TO_DORZIM' then v_now
          else picked_up_at
        end,
        delivered_at = case
          when v_order.id = p_anchor_order_id and v_outcome = 'CLIENT_PICKED_UP_TO_DORZIM' then v_now
          else delivered_at
        end,
        updated_at = v_now
    where id = v_order.id
    returning * into v_updated_order;

    v_payments := v_payments || jsonb_build_array(to_jsonb(v_payment));
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'batch_id', v_batch.id, 'order_id', v_order.id, 'arka_payment_id', v_payment.id,
      'amount', v_allocate, 'debt_before', v_debt, 'debt_after', v_next_debt,
      'allocation_order', v_alloc_no
    ));
    if v_return_payment is null or v_order.id = p_anchor_order_id then v_return_payment := to_jsonb(v_payment); end if;
    if v_order.id = p_anchor_order_id then v_return_order := to_jsonb(v_updated_order); end if;
    v_remaining := round(v_remaining - v_allocate, 2);
  end loop;

  if v_remaining > 0.009 then raise exception 'BASE_CLIENT_PAYMENT_ALLOCATION_INCOMPLETE'; end if;
  if not exists (select 1 from public.base_payment_allocations a where a.batch_id = v_batch.id) then
    raise exception 'BASE_CLIENT_PAYMENT_BATCH_EMPTY';
  end if;
  if abs((select coalesce(sum(amount), 0) from public.base_payment_allocations where batch_id = v_batch.id) - v_amount) > 0.009 then
    raise exception 'BASE_CLIENT_PAYMENT_ALLOCATION_SUM_MISMATCH';
  end if;
  if abs((select coalesce(sum(p.amount), 0)
          from public.base_payment_allocations a
          join public.arka_pending_payments p on p.id = a.arka_payment_id
          where a.batch_id = v_batch.id) - v_amount) > 0.009 then
    raise exception 'BASE_CLIENT_PAYMENT_ARKA_SUM_MISMATCH';
  end if;
  if exists (
    select 1
    from public.base_payment_allocations a
    left join public.arka_pending_payments p on p.id = a.arka_payment_id
    where a.batch_id = v_batch.id
      and (
        p.id is null
        or p.order_id is distinct from a.order_id
        or round(coalesce(p.amount, 0), 2) is distinct from round(a.amount, 2)
        or upper(btrim(coalesce(p.type, ''))) <> 'IN'
        or upper(btrim(coalesce(p.source_module, ''))) <> 'BASE'
        or nullif(btrim(coalesce(p.status, '')), '') is null
        or upper(btrim(coalesce(p.status, ''))) = 'VOIDED'
        or p.idempotency_key is distinct from concat('BASE_CLIENT_PAYMENT:', v_batch.id::text, ':', a.order_id::text)
      )
  ) then
    raise exception 'BASE_CLIENT_PAYMENT_ARKA_INVARIANT_FAILED';
  end if;

  -- The order currently being handed to the client may already be fully paid
  -- while an older visit still has debt. It therefore may not appear in the
  -- positive-debt snapshot, but pickup must still transition that anchor only.
  if v_outcome = 'CLIENT_PICKED_UP_TO_DORZIM'
     and not (p_anchor_order_id = any(v_order_ids)) then
    v_next_data := coalesce(v_anchor.data, '{}'::jsonb);
    if jsonb_typeof(v_next_data->'data') = 'object' then
      v_next_data := (v_next_data - 'data') || (v_next_data->'data');
    end if;
    v_next_data := v_next_data || jsonb_build_object(
      'status', 'dorzim',
      'picked_up_at', v_now,
      'delivered_at', v_now,
      'updated_at', v_now,
      'base_payment_batch_id', v_batch.id
    );
    update public.orders o
    set status = 'dorzim',
        data = v_next_data,
        picked_up_at = v_now,
        delivered_at = v_now,
        updated_at = v_now
    where o.id = p_anchor_order_id
      and o.client_id = v_client_id
      and lower(btrim(coalesce(
        nullif(btrim(o.status), ''),
        nullif(btrim(o.data#>>'{data,status}'), ''),
        nullif(btrim(o.data->>'status'), ''),
        ''
      ))) = 'pastrim'
    returning * into v_updated_order;
    if not found then raise exception 'ANCHOR_LIFECYCLE_STALE'; end if;
    v_return_order := to_jsonb(v_updated_order);
  end if;

  select coalesce(jsonb_agg(to_jsonb(o) order by o.id), '[]'::jsonb)
    into v_orders
  from public.orders o
  where o.id = any(v_order_ids) or o.id = p_anchor_order_id;
  if v_return_order is null then select to_jsonb(o) into v_return_order from public.orders o where o.id = p_anchor_order_id; end if;
  if v_return_payment is null or v_return_order is null then
    raise exception 'BASE_CLIENT_PAYMENT_RETURN_ROW_MISSING';
  end if;

  return jsonb_build_object(
    'ok', true, 'duplicate', false, 'existing', false,
    'batch', to_jsonb(v_batch), 'payments', v_payments,
    'allocations', v_allocations, 'orders', v_orders,
    'payment', v_return_payment, 'row', v_return_payment, 'order', v_return_order,
    'idempotencyKey', v_idempotency_key, 'paymentOutcome', v_outcome
  );
end;
$$;

revoke execute on function public.record_base_client_cash_payment_atomic_v1(
  bigint, numeric, numeric, numeric, numeric, jsonb, uuid, text, text, text,
  text, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.record_base_client_cash_payment_atomic_v1(
  bigint, numeric, numeric, numeric, numeric, jsonb, uuid, text, text, text,
  text, text, text, text, text, text, text
) to service_role;

comment on function public.record_base_client_cash_payment_atomic_v1(
  bigint, numeric, numeric, numeric, numeric, jsonb, uuid, text, text, text,
  text, text, text, text, text, text, text
) is 'Atomic service-role-only canonical BASE client debt settlement with exact snapshot, FIFO allocations, stale-balance protection and idempotent retries.';
