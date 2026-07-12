-- EMERGENCY ROLLBACK ONLY
-- Requires a maintenance window with all Transport writes stopped.
-- This restores the 2026-07-11 pre-patch state for rows present in the backup.
-- Review manually before execution. Do not run during working hours.

begin;
set local lock_timeout='10s';
set local statement_timeout='300s';

lock table public.transport_orders in access exclusive mode;
lock table public.transport_code_pool in access exclusive mode;

alter table public.transport_orders disable trigger all;

update public.transport_orders o
set
  code_n=b.code_n,
  code_str=b.code_str,
  client_id=b.client_id,
  client_name=b.client_name,
  client_phone=b.client_phone,
  status=b.status,
  data=b.data,
  created_at=b.created_at,
  updated_at=b.updated_at,
  reschedule_at=b.reschedule_at,
  reschedule_note=b.reschedule_note,
  client_tcode=b.client_tcode,
  visit_nr=b.visit_nr,
  ready_at=b.ready_at
from backup_internal.transport_orders_before_permanent_tcode_20260711 b
where o.id=b.id;

update public.transport_code_pool p
set owner_id=b.owner_id,status=b.status,created_at=b.created_at
from backup_internal.transport_code_pool_before_permanent_tcode_20260711 b
where p.code=b.code;

insert into public.transport_code_pool(code,owner_id,status,created_at)
select b.code,b.owner_id,b.status,b.created_at
from backup_internal.transport_code_pool_before_permanent_tcode_20260711 b
where not exists(select 1 from public.transport_code_pool p where p.code=b.code);

-- Restore original function bodies captured before the patch.
do $rollback_functions$
declare r record;
begin
  for r in
    select definition
    from backup_internal.transport_function_defs_before_permanent_tcode_20260711
    order by proname,arguments
  loop
    execute r.definition;
  end loop;
end;
$rollback_functions$;

-- Restore original trigger shapes.
drop trigger if exists trg_transport_order_code_canonicalize on public.transport_orders;
create trigger trg_transport_order_code_canonicalize
before insert on public.transport_orders
for each row execute function public.transport_order_code_canonicalize();

drop trigger if exists trg_mark_transport_code_used on public.transport_orders;
create trigger trg_mark_transport_code_used
after insert on public.transport_orders
for each row
when (new.client_tcode is not null)
execute function public.trg_mark_transport_code_used();

-- Restore old defaults and indexes.
alter table public.transport_orders
  alter column code_n set default nextval('transport_code_seq'::regclass);
alter table public.transport_orders
  alter column code_str set default ('T'::text || nextval('transport_code_seq'::regclass)::text);

drop index if exists public.idx_transport_orders_code_transport;
drop index if exists public.idx_transport_orders_client_tcode_created;
drop index if exists public.idx_transport_orders_client_id_created;
drop index if exists public.ux_transport_orders_client_visit;

create unique index if not exists transport_orders_unique_code
  on public.transport_orders(code_n,transport_id);
create unique index if not exists ux_transport_orders_client_visit
  on public.transport_orders(client_tcode,visit_nr);

alter table public.transport_orders drop constraint if exists transport_orders_code_str_tformat;
alter table public.transport_orders drop constraint if exists transport_orders_client_tcode_tformat;
alter table public.transport_clients drop constraint if exists transport_clients_tcode_tformat;

drop function if exists public.release_transport_code_if_unused(text,text);

alter table public.transport_orders enable trigger all;
commit;

-- Run the historical audit after rollback before reopening Transport writes.
