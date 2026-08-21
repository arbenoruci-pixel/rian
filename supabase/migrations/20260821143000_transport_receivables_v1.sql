-- Transport client receivables V1
-- Delivery, debt and cash collection are independent, auditable events.

create table if not exists public.transport_receivables (
  id uuid primary key default gen_random_uuid(),
  transport_order_id uuid not null unique
    references public.transport_orders(id) on delete restrict,
  client_id uuid not null
    references public.transport_clients(id) on delete restrict,
  client_tcode text not null,
  client_name text,
  client_phone text,
  original_amount numeric(12,2) not null,
  opening_paid_amount numeric(12,2) not null default 0,
  outstanding_amount numeric(12,2) not null,
  status text not null default 'OPEN',
  due_date date,
  delivered_at timestamptz not null,
  created_by_pin text not null,
  created_by_name text,
  created_by_role text,
  note text,
  source text not null default 'DELIVERY',
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transport_receivables_amounts_ck check (
    original_amount >= 0
    and opening_paid_amount >= 0
    and opening_paid_amount <= original_amount
    and outstanding_amount >= 0
    and outstanding_amount <= original_amount - opening_paid_amount
  ),
  constraint transport_receivables_status_ck check (
    status in ('OPEN', 'PARTIALLY_PAID', 'PAID', 'VOIDED')
  ),
  constraint transport_receivables_tcode_ck check (client_tcode ~ '^T[0-9]+$')
);

create table if not exists public.transport_payment_batches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null
    references public.transport_clients(id) on delete restrict,
  current_transport_order_id uuid
    references public.transport_orders(id) on delete restrict,
  amount_received numeric(12,2) not null,
  amount_applied numeric(12,2) not null,
  change_amount numeric(12,2) not null default 0,
  method text not null default 'CASH',
  status text not null default 'CONFIRMED',
  created_by_pin text not null,
  created_by_name text,
  created_by_role text,
  note text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  constraint transport_payment_batches_amounts_ck check (
    amount_received > 0
    and amount_applied > 0
    and amount_applied <= amount_received
    and change_amount = amount_received - amount_applied
  ),
  constraint transport_payment_batches_method_ck check (method in ('CASH')),
  constraint transport_payment_batches_status_ck check (status in ('CONFIRMED', 'VOIDED'))
);

create table if not exists public.transport_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null
    references public.transport_payment_batches(id) on delete restrict,
  receivable_id uuid not null
    references public.transport_receivables(id) on delete restrict,
  arka_payment_id bigint not null unique
    references public.arka_pending_payments(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  allocation_order integer not null check (allocation_order > 0),
  created_at timestamptz not null default now(),
  unique (batch_id, receivable_id),
  unique (batch_id, allocation_order)
);

create table if not exists public.transport_delivery_events (
  id uuid primary key default gen_random_uuid(),
  transport_order_id uuid not null unique
    references public.transport_orders(id) on delete restrict,
  client_id uuid not null
    references public.transport_clients(id) on delete restrict,
  receivable_id uuid
    references public.transport_receivables(id) on delete restrict,
  event_type text not null,
  cash_received numeric(12,2) not null default 0 check (cash_received >= 0),
  debt_created numeric(12,2) not null default 0 check (debt_created >= 0),
  due_date date,
  actor_pin text not null,
  actor_name text,
  actor_role text,
  note text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  constraint transport_delivery_events_type_ck check (
    event_type in ('DELIVERED_WITH_DEBT', 'DELIVERED_WITH_PAYMENT', 'DEBT_CORRECTION')
  )
);

create index if not exists transport_receivables_client_open_idx
  on public.transport_receivables(client_id, delivered_at, id)
  where status in ('OPEN', 'PARTIALLY_PAID') and outstanding_amount > 0;
create index if not exists transport_receivables_tcode_open_idx
  on public.transport_receivables(client_tcode, delivered_at, id)
  where status in ('OPEN', 'PARTIALLY_PAID') and outstanding_amount > 0;
create index if not exists transport_payment_batches_client_created_idx
  on public.transport_payment_batches(client_id, created_at desc);
create index if not exists transport_payment_allocations_receivable_idx
  on public.transport_payment_allocations(receivable_id, created_at);

alter table public.transport_receivables enable row level security;
alter table public.transport_payment_batches enable row level security;
alter table public.transport_payment_allocations enable row level security;
alter table public.transport_delivery_events enable row level security;

revoke all on table public.transport_receivables from public, anon, authenticated;
revoke all on table public.transport_payment_batches from public, anon, authenticated;
revoke all on table public.transport_payment_allocations from public, anon, authenticated;
revoke all on table public.transport_delivery_events from public, anon, authenticated;

grant select, insert, update on table public.transport_receivables to service_role;
grant select, insert, update on table public.transport_payment_batches to service_role;
grant select, insert, update on table public.transport_payment_allocations to service_role;
grant select, insert, update on table public.transport_delivery_events to service_role;

create or replace function public.transport_receivable_parse_money_v1(p_value text)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v text := replace(trim(coalesce(p_value, '')), ',', '.');
begin
  if v ~ '^-?[0-9]+([.][0-9]+)?$' then
    return round(v::numeric, 2);
  end if;
  return 0;
end;
$$;

create or replace function public.transport_client_receivable_summary_v1(
  p_order_id uuid default null,
  p_client_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.transport_orders%rowtype;
  v_client_id uuid := p_client_id;
  v_data jsonb := '{}'::jsonb;
  v_total numeric(12,2) := 0;
  v_paid numeric(12,2) := 0;
  v_current_due numeric(12,2) := 0;
  v_previous numeric(12,2) := 0;
  v_ledger_total numeric(12,2) := 0;
  v_items jsonb := '[]'::jsonb;
  v_current_receivable jsonb := null;
  v_current_ledger_due numeric(12,2) := null;
begin
  if p_order_id is not null then
    select * into v_order
    from public.transport_orders
    where id = p_order_id;
    if not found then
      raise exception 'TRANSPORT_ORDER_NOT_FOUND';
    end if;
    v_client_id := v_order.client_id;
    v_data := coalesce(v_order.data, '{}'::jsonb);
    v_total := greatest(
      0,
      public.transport_receivable_parse_money_v1(
        coalesce(v_data #>> '{pay,euro}', v_data #>> '{pay,total}', v_data ->> 'total', '0')
      )
    );
    v_paid := greatest(
      public.transport_receivable_parse_money_v1(v_data #>> '{pay,paid}'),
      public.transport_receivable_parse_money_v1(v_data #>> '{pay,arkaRecordedPaid}'),
      public.transport_receivable_parse_money_v1(v_data ->> 'clientPaid'),
      0
    );
    v_current_due := greatest(0, round(v_total - v_paid, 2));
  end if;

  if v_client_id is null then
    raise exception 'TRANSPORT_CLIENT_ID_REQUIRED';
  end if;

  select
    coalesce(sum(r.outstanding_amount), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'transportOrderId', r.transport_order_id,
          'clientTcode', r.client_tcode,
          'originalAmount', r.original_amount,
          'openingPaidAmount', r.opening_paid_amount,
          'outstandingAmount', r.outstanding_amount,
          'status', r.status,
          'dueDate', r.due_date,
          'deliveredAt', r.delivered_at
        )
        order by r.delivered_at, r.created_at, r.id
      ),
      '[]'::jsonb
    )
  into v_ledger_total, v_items
  from public.transport_receivables r
  where r.client_id = v_client_id
    and r.status in ('OPEN', 'PARTIALLY_PAID')
    and r.outstanding_amount > 0;

  if p_order_id is not null then
    select to_jsonb(r), r.outstanding_amount
      into v_current_receivable, v_current_ledger_due
    from public.transport_receivables r
    where r.transport_order_id = p_order_id
      and r.status in ('OPEN', 'PARTIALLY_PAID')
      and r.outstanding_amount > 0;

    if found then
      v_current_due := v_current_ledger_due;
    end if;

    select coalesce(sum(r.outstanding_amount), 0)
      into v_previous
    from public.transport_receivables r
    where r.client_id = v_client_id
      and r.transport_order_id <> p_order_id
      and r.status in ('OPEN', 'PARTIALLY_PAID')
      and r.outstanding_amount > 0;
  else
    v_previous := v_ledger_total;
  end if;

  return jsonb_build_object(
    'ok', true,
    'clientId', v_client_id,
    'orderId', p_order_id,
    'previousOutstanding', round(v_previous, 2),
    'currentOrderDue', round(v_current_due, 2),
    'ledgerOutstanding', round(v_ledger_total, 2),
    'totalForPayment', round(v_previous + v_current_due, 2),
    'currentReceivable', v_current_receivable,
    'receivables', v_items
  );
end;
$$;

create or replace function public.transport_deliver_with_debt_v1(
  p_order_id uuid,
  p_actor_pin text,
  p_due_date date default null,
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
  v_data jsonb;
  v_pay jsonb;
  v_total numeric(12,2);
  v_paid numeric(12,2);
  v_outstanding numeric(12,2);
  v_now timestamptz := now();
  v_status text;
  v_key text := coalesce(nullif(trim(p_idempotency_key), ''), 'TRANSPORT_DELIVER_WITH_DEBT:' || p_order_id::text);
begin
  select * into v_actor
  from public.users
  where pin = trim(coalesce(p_actor_pin, ''))
    and is_active = true
  limit 1;
  if not found then
    raise exception 'ACTOR_NOT_FOUND_OR_DISABLED';
  end if;

  select * into v_order
  from public.transport_orders
  where id = p_order_id
  for update;
  if not found then
    raise exception 'TRANSPORT_ORDER_NOT_FOUND';
  end if;
  if v_order.client_id is null then
    raise exception 'TRANSPORT_CLIENT_ID_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_order.client_id::text, 0));

  select * into v_receivable
  from public.transport_receivables
  where transport_order_id = p_order_id;
  if found then
    return public.transport_client_receivable_summary_v1(p_order_id, v_order.client_id)
      || jsonb_build_object('duplicate', true, 'receivable', to_jsonb(v_receivable), 'order', to_jsonb(v_order));
  end if;

  v_status := lower(trim(coalesce(v_order.status, v_order.data ->> 'status', '')));
  if v_status not in ('delivery', 'dorzim', 'dorezim', 'dorëzim', 'done', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar') then
    raise exception 'TRANSPORT_ORDER_NOT_IN_DELIVERY';
  end if;

  v_data := coalesce(v_order.data, '{}'::jsonb);
  v_pay := coalesce(v_data -> 'pay', '{}'::jsonb);
  v_total := greatest(
    0,
    public.transport_receivable_parse_money_v1(
      coalesce(v_pay ->> 'euro', v_pay ->> 'total', v_data ->> 'total', '0')
    )
  );
  v_paid := greatest(
    public.transport_receivable_parse_money_v1(v_pay ->> 'paid'),
    public.transport_receivable_parse_money_v1(v_pay ->> 'arkaRecordedPaid'),
    public.transport_receivable_parse_money_v1(v_data ->> 'clientPaid'),
    0
  );
  v_outstanding := greatest(0, round(v_total - v_paid, 2));
  if v_outstanding <= 0 then
    raise exception 'TRANSPORT_ORDER_HAS_NO_DEBT';
  end if;

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
    v_outstanding,
    case when v_paid > 0 then 'PARTIALLY_PAID' else 'OPEN' end,
    p_due_date,
    v_now,
    v_actor.pin,
    v_actor.name,
    v_actor.role,
    nullif(trim(coalesce(p_note, '')), ''),
    'DELIVERY',
    v_key
  )
  returning * into v_receivable;

  v_pay := v_pay || jsonb_build_object(
    'euro', v_total,
    'paid', v_paid,
    'arkaRecordedPaid', least(
      v_paid,
      greatest(0, public.transport_receivable_parse_money_v1(v_pay ->> 'arkaRecordedPaid'))
    ),
    'debt', v_outstanding
  );
  v_data := jsonb_set(v_data, '{pay}', v_pay, true)
    || jsonb_build_object(
      'status', 'done',
      'state', 'done',
      'clientPaid', v_paid,
      'paid', v_paid,
      'debt', v_outstanding,
      'isPaid', false,
      'paid_done', false,
      'payment_state', case when v_paid > 0 then 'PARTIALLY_PAID' else 'DEBT' end,
      'delivery_payment_status', case when v_paid > 0 then 'PARTIALLY_PAID' else 'DEBT' end,
      'delivery_with_debt', true,
      'debt_amount', v_outstanding,
      'debt_due_date', p_due_date,
      'debt_created_at', v_now,
      'debt_reason', 'CLIENT_PAY_LATER',
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

  insert into public.transport_delivery_events (
    transport_order_id, client_id, receivable_id, event_type,
    cash_received, debt_created, due_date,
    actor_pin, actor_name, actor_role, note, idempotency_key
  ) values (
    v_order.id, v_order.client_id, v_receivable.id, 'DELIVERED_WITH_DEBT',
    0, v_outstanding, p_due_date,
    v_actor.pin, v_actor.name, v_actor.role,
    nullif(trim(coalesce(p_note, '')), ''),
    'TRANSPORT_DELIVERY_EVENT:' || v_order.id::text
  )
  on conflict (transport_order_id) do nothing;

  return public.transport_client_receivable_summary_v1(p_order_id, v_order.client_id)
    || jsonb_build_object('duplicate', false, 'receivable', to_jsonb(v_receivable), 'order', to_jsonb(v_order));
end;
$$;

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

  select * into v_order
  from public.transport_orders
  where id = p_order_id
  for update;
  if not found then
    raise exception 'TRANSPORT_ORDER_NOT_FOUND';
  end if;
  if v_order.client_id is null then
    raise exception 'TRANSPORT_CLIENT_ID_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_order.client_id::text, 0));

  select * into v_batch
  from public.transport_payment_batches
  where idempotency_key = v_key;
  if found then
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
  if v_status not in ('delivery', 'dorzim', 'dorezim', 'dorëzim', 'done', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar') then
    raise exception 'TRANSPORT_ORDER_NOT_IN_DELIVERY';
  end if;

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
  v_paid := greatest(
    public.transport_receivable_parse_money_v1(v_pay ->> 'paid'),
    public.transport_receivable_parse_money_v1(v_pay ->> 'arkaRecordedPaid'),
    public.transport_receivable_parse_money_v1(v_data ->> 'clientPaid'),
    0
  );
  v_current_outstanding := greatest(0, round(v_total - v_paid, 2));

  if v_receivable.id is null and v_current_outstanding > 0 then
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

  if v_receivable.id is not null then
    insert into public.transport_delivery_events (
      transport_order_id, client_id, receivable_id, event_type,
      cash_received, debt_created, due_date,
      actor_pin, actor_name, actor_role, note, idempotency_key
    ) values (
      v_order.id, v_order.client_id, v_receivable.id, 'DELIVERED_WITH_PAYMENT',
      v_received, v_current_outstanding, null,
      v_actor.pin, v_actor.name, v_actor.role,
      nullif(trim(coalesce(p_note, '')), ''),
      'TRANSPORT_DELIVERY_EVENT:' || v_order.id::text
    )
    on conflict (transport_order_id) do nothing;
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
      public.transport_receivable_parse_money_v1(v_alloc_order.data #>> '{pay,m2}'),
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
      batch_id, receivable_id, arka_payment_id, amount, allocation_order
    ) values (
      v_batch.id, r.id, v_payment_id, v_allocate, v_alloc_no
    );

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
    v_paid := greatest(
      public.transport_receivable_parse_money_v1(v_pay ->> 'paid'),
      public.transport_receivable_parse_money_v1(v_pay ->> 'arkaRecordedPaid'),
      public.transport_receivable_parse_money_v1(v_data ->> 'clientPaid'),
      0
    );
    v_new_paid := round(v_paid + v_allocate, 2);
    v_new_arka := round(
      greatest(0, public.transport_receivable_parse_money_v1(v_pay ->> 'arkaRecordedPaid')) + v_allocate,
      2
    );
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

revoke execute on function public.transport_receivable_parse_money_v1(text) from public, anon, authenticated;
revoke execute on function public.transport_client_receivable_summary_v1(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.transport_deliver_with_debt_v1(uuid, text, date, text, text) from public, anon, authenticated;
revoke execute on function public.transport_collect_client_payment_v1(uuid, text, numeric, text, text, text) from public, anon, authenticated;

grant execute on function public.transport_receivable_parse_money_v1(text) to service_role;
grant execute on function public.transport_client_receivable_summary_v1(uuid, uuid) to service_role;
grant execute on function public.transport_deliver_with_debt_v1(uuid, text, date, text, text) to service_role;
grant execute on function public.transport_collect_client_payment_v1(uuid, text, numeric, text, text, text) to service_role;
