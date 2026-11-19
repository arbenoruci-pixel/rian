-- Transport fulfillment is final once the delivery RPC has committed its event.
-- Cached order edits may still update other fields after delivery.
create or replace function private.guard_confirmed_transport_delivery_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  balance numeric;
  invoice numeric;
  old_pay jsonb := coalesce(old.data->'pay', '{}'::jsonb);
  new_pay jsonb;
  protected jsonb;
  total_keys constant text[] := array['total','totalEuro','total_eur','price_total'];
  delivery_keys constant text[] := array[
    'delivered_at','done_at','completed_at','delivered_by_pin','delivered_by_name'
  ];
  payment_keys constant text[] := array[
    'clientPaid','paid','debt','debt_amount','isPaid','paid_done','payment_state',
    'delivery_payment_status','delivery_with_debt','paid_at'
  ];
  pay_keys constant text[] := array['paid','arkaRecordedPaid','debt','method','last_paid_at'];
begin
  -- The initial delivery transaction and explicit legacy workflows retain their own rules.
  if old.status is distinct from 'done' or new.status = 'cancelled'
     or new.data->>'manual_status_override' = 'PAID_NOT_PICKED_UP' then
    return new;
  end if;

  select r.outstanding_amount,r.original_amount into balance,invoice
  from public.transport_delivery_events e
  join public.transport_receivables r on r.id = e.receivable_id and r.transport_order_id = e.transport_order_id
  where e.transport_order_id = old.id
    and e.event_type in ('DELIVERED_WITH_PAYMENT','DELIVERED_WITH_DEBT')
    and r.status in ('OPEN','PARTIALLY_PAID','PAID');
  if not found then return new; end if;

  new.status := 'done';
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into protected
    from jsonb_each(old.data) where key = any(delivery_keys);
  new.data := coalesce(new.data,'{}'::jsonb) || protected || '{"status":"done","state":"done"}'::jsonb;

  -- These aliases describe the invoice already issued. Keep the established
  -- values when a cached form supplies its earlier quote during a notes edit.
  if jsonb_typeof(old_pay->'euro') = 'number' and (old_pay->>'euro')::numeric = invoice then
    select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into protected
      from jsonb_each(old.data) where key = any(total_keys);
    new_pay := case when jsonb_typeof(new.data->'pay')='object' then new.data->'pay' else '{}'::jsonb end;
    new.data := (new.data - total_keys) || protected;
    new.data := jsonb_set(new.data,'{pay}',(old_pay || new_pay) || jsonb_build_object('euro',invoice));
  end if;

  -- The collector updates the receivable before updating the order. When that
  -- happens the incoming snapshot carries the new balance, including for a partial payment.
  if (jsonb_typeof(old_pay->'debt') = 'number' and (old_pay->>'debt')::numeric = balance)
    or (old_pay->>'debt' is null and new.data->'pay'->>'debt' is null) then
    select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into protected
      from jsonb_each(old.data) where key = any(payment_keys);
    new.data := (new.data - payment_keys) || protected;
    select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into protected
      from jsonb_each(old_pay) where key = any(pay_keys);
    new_pay := case when jsonb_typeof(new.data->'pay')='object' then new.data->'pay' else '{}'::jsonb end;
    new.data := jsonb_set(new.data,'{pay}',old_pay || (new_pay - pay_keys) || protected);
  elsif jsonb_typeof(new.data->'pay'->'debt') is distinct from 'number'
     or (new.data->'pay'->>'debt')::numeric is distinct from balance then
    raise exception 'TRANSPORT_DELIVERY_BALANCE_CHANGED' using errcode = '40001';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_confirmed_transport_delivery_v1() from public, anon, authenticated;

drop trigger if exists zzz_guard_confirmed_transport_delivery_v1 on public.transport_orders;
create trigger zzz_guard_confirmed_transport_delivery_v1
before update of data,status on public.transport_orders
for each row execute function private.guard_confirmed_transport_delivery_v1();
