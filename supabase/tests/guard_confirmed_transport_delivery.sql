-- Rollback-only test. Bind the deployed trigger body to isolated fixture tables.
begin;
create temporary table delivery_guard_orders(id integer primary key, status text, data jsonb);
create temporary table delivery_guard_receivables(id integer, transport_order_id integer, outstanding_amount numeric, original_amount numeric, status text);
create temporary table delivery_guard_events(transport_order_id integer, receivable_id integer, event_type text);

do $$
declare
  definition text := pg_get_functiondef('private.guard_confirmed_transport_delivery_v1()'::regprocedure);
begin
  definition := replace(definition,'private.guard_confirmed_transport_delivery_v1()', 'pg_temp.delivery_guard_test_fn()');
  definition := replace(definition,'public.transport_delivery_events','pg_temp.delivery_guard_events');
  definition := replace(definition,'public.transport_receivables','pg_temp.delivery_guard_receivables');
  execute definition;
end $$;
create trigger delivery_guard_test before update of status,data on delivery_guard_orders
  for each row execute function pg_temp.delivery_guard_test_fn();

insert into delivery_guard_orders values
 (1,'done','{"status":"done","state":"done","paid":34.78,"isPaid":true,"paid_at":"yesterday","delivered_at":"yesterday","pay":{"paid":34.78,"arkaRecordedPaid":34.78,"debt":0,"euro":35.28}}'),
 (2,'done','{"status":"done","delivered_at":"yesterday","pay":{"paid":0,"debt":15}}'),
 (3,'delivery','{"status":"delivery","pay":{"debt":20}}');
insert into delivery_guard_receivables values (11,1,0,35.28,'PAID'),(12,2,15,15,'OPEN');
insert into delivery_guard_events values (1,11,'DELIVERED_WITH_PAYMENT'),(2,12,'DELIVERED_WITH_DEBT');

-- Old full-row upsert before dispatch handoff and data-only edit after handoff.
update delivery_guard_orders set status='delivery', data='{"status":"delivery","pay":{"paid":0},"notes":"new note"}' where id=1;
update delivery_guard_orders set data=data || '{"state":"gati","isPaid":false,"total":0,"pay":{"debt":35.28,"euro":0}}' where id=1;
do $$ declare o record;
begin
 select * into strict o from delivery_guard_orders where id=1;
 if o.status <> 'done' or not (o.data @> '{"status":"done","state":"done","paid":34.78,"isPaid":true,"paid_at":"yesterday","delivered_at":"yesterday","notes":"new note","pay":{"paid":34.78,"arkaRecordedPaid":34.78,"debt":0,"euro":35.28}}') then
   raise exception 'Settled delivery or payment was overwritten: %',o;
 end if;
end $$;

-- Collect installments after delivery with debt. The ledger changes first.
update delivery_guard_receivables set outstanding_amount=10,status='PARTIALLY_PAID' where id=12;
update delivery_guard_orders set data=data || '{"paid":5,"pay":{"debt":10,"paid":5}}' where id=2;
update delivery_guard_orders set status='delivery',data='{"pay":{"debt":15,"paid":0}}' where id=2;
do $$ begin
 if not exists (select 1 from delivery_guard_orders where id=2 and status='done' and data @> '{"paid":5,"pay":{"debt":10,"paid":5}}') then
   raise exception 'Installment was blocked or lost';
 end if;
end $$;
update delivery_guard_receivables set outstanding_amount=0,status='PAID' where id=12;
update delivery_guard_orders set data=data || '{"paid":15,"isPaid":true,"pay":{"debt":0,"paid":15}}' where id=2;
update delivery_guard_orders set status='cancelled' where id=1;
update delivery_guard_orders set status='gati',data=data || '{"manual_status_override":"PAID_NOT_PICKED_UP"}' where id=2;
update delivery_guard_orders set status='gati' where id=3;
do $$ begin
 if not exists(select 1 from delivery_guard_orders where id=1 and status='cancelled')
   or not exists(select 1 from delivery_guard_orders where id=2 and status='gati' and data @> '{"isPaid":true,"pay":{"paid":15}}')
   or not exists(select 1 from delivery_guard_orders where id=3 and status='gati') then
   raise exception 'Final settlement or explicit non-delivery workflow was blocked';
 end if;
end $$;
rollback;
