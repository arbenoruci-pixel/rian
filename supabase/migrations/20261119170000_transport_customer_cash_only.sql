-- A transport order can also be the reference for a worker's control bonus.
create or replace function public.transport_order_active_arka_paid_v1(p_order_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  customer_cash numeric;
  opening_cash numeric := 0;
begin
  select coalesce(sum(p.amount), 0)
    into customer_cash
    from public.arka_pending_payments p
   where p.transport_order_id = p_order_id
     and p.type = 'TRANSPORT'
     and p.status in ('ACCEPTED_BY_DISPATCH', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL');

  -- Installations that archived their cash ledger retain its opening balances.
  if to_regclass('private.finance_opening_cash_v1') is not null then
    select coalesce(sum(o.amount), 0)
      into opening_cash
      from private.finance_opening_cash_v1 o
     where o.source_module = 'TRANSPORT' and o.order_key = p_order_id::text;
  end if;
  return round(customer_cash + opening_cash, 2);
end;
$function$;
