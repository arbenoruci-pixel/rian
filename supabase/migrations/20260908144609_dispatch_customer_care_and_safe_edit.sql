-- Applied 2026-09-08 before the customer-care / Dispatch edit UI release.
begin;

create table public.transport_customer_feedback (
  id uuid primary key,
  client_id uuid not null references public.transport_clients(id),
  order_id uuid references public.transport_orders(id),
  rating smallint check (rating between 1 and 5),
  note text not null default '' check (length(note) <= 2000),
  issue text check (issue in ('PAYMENT', 'NO_SHOW', 'ACCESS', 'OTHER')),
  no_pickup boolean,
  created_by uuid not null references public.users(id),
  author_name text not null,
  author_role text not null,
  created_at timestamptz not null default now(),
  check (rating is not null or length(note) > 0 or issue is not null or no_pickup is not null)
);
create index transport_customer_feedback_client_created_idx on public.transport_customer_feedback(client_id, created_at desc);
create index transport_customer_feedback_client_flag_idx on public.transport_customer_feedback(client_id, created_at desc) where no_pickup is not null;
create index transport_customer_feedback_order_idx on public.transport_customer_feedback(order_id);
create index transport_customer_feedback_author_idx on public.transport_customer_feedback(created_by);
alter table public.transport_customer_feedback enable row level security;
revoke all on public.transport_customer_feedback from public, anon, authenticated;
grant select, insert on public.transport_customer_feedback to service_role;
comment on table public.transport_customer_feedback is 'Internal customer feedback. Approved-device API validates identity and driver order ownership; no browser table access.';

-- Both edits commit together. Exact timestamps reject stale edits from another phone.
create function public.edit_dispatch_order_v1(
  p_order_id uuid, p_expected_updated_at timestamptz,
  p_client_id uuid, p_client_expected_updated_at timestamptz,
  p_client_patch jsonb, p_order_data jsonb, p_next_status text
) returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '5s' as $$
declare
  v_order public.transport_orders%rowtype;
  v_client public.transport_clients%rowtype;
  v_key text;
begin
  select * into v_client from public.transport_clients where id = p_client_id for update;
  if not found or v_client.updated_at is distinct from p_client_expected_updated_at then
    raise exception 'DISPATCH_EDIT_CONFLICT';
  end if;
  select * into v_order from public.transport_orders where id = p_order_id for update;
  if not found or v_order.updated_at is distinct from p_expected_updated_at or v_order.client_id is distinct from p_client_id then
    raise exception 'DISPATCH_EDIT_CONFLICT';
  end if;
  if coalesce(length(btrim(p_client_patch->>'name')), 0) = 0 or jsonb_typeof(p_order_data) is distinct from 'object' or p_next_status is null then
    raise exception 'DISPATCH_EDIT_INVALID';
  end if;
  -- Check the ledger under the order lock as well as the API's JSON guard.
  if p_order_data->'dispatch_edit'->>'measurements_changed' = 'true' and exists (
    select 1 from public.arka_pending_payments ap
    where ap.transport_order_id = v_order.id and ap.amount > 0
      and upper(coalesce(ap.status, '')) in ('PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH')
      and (ap.type = 'TRANSPORT' or ap.source_module = 'TRANSPORT')
  ) then
    raise exception 'DISPATCH_EDIT_PAID_MEASUREMENTS';
  end if;
  update public.transport_clients set name = p_client_patch->>'name', address = p_client_patch->>'address', updated_at = clock_timestamp()
    where id = p_client_id;
  if p_next_status is distinct from v_order.status then
    update public.transport_orders set client_name = p_client_patch->>'name', data = p_order_data,
      status = p_next_status, updated_at = clock_timestamp()
      where id = p_order_id returning * into v_order;
  else
    -- Do not activate status-transition triggers during an ordinary edit.
    update public.transport_orders set client_name = p_client_patch->>'name', data = p_order_data,
      updated_at = clock_timestamp() where id = p_order_id returning * into v_order;
  end if;
  if v_order.status is distinct from p_next_status then
    raise exception 'DISPATCH_EDIT_CONFLICT';
  end if;
  -- A trigger must never silently undo the requested measurements or ownership.
  foreach v_key in array array['transport_id','transport_user_id','assigned_driver_id','worker_pin','tepiha','staza','shkallore','pay'] loop
    if v_order.data->v_key is distinct from p_order_data->v_key then
      raise exception 'DISPATCH_EDIT_CONFLICT';
    end if;
  end loop;
  return to_jsonb(v_order);
end;
$$;
revoke all on function public.edit_dispatch_order_v1(uuid,timestamptz,uuid,timestamptz,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.edit_dispatch_order_v1(uuid,timestamptz,uuid,timestamptz,jsonb,jsonb,text) to service_role;
commit;
