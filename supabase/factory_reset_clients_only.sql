-- FACTORY RESET (CLIENTS ONLY)
-- Deletes ALL data tied to clients/orders/payments/arka operations so you can re-test from scratch,
-- but keeps configuration tables (e.g., arka_owners, arka_staff, tepiha_users).
--
-- Install once in Supabase SQL Editor.

create or replace function public.factory_reset_clients_only(pin integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  _pin int := pin;
  _deleted json;
begin
  if _pin is null or _pin <> 2380 then
    raise exception 'BAD_PIN';
  end if;

  -- Delete operational tables that depend on clients/orders/payments.
  -- Keep config tables: arka_owners, arka_staff, tepiha_users.
  truncate table
    public.app_backups,
    public.backups,
    public.backups_daily,
    public.arka_cycle_moves,
    public.arka_cycles,
    public.arka_days,
    public.arka_moves,
    public.arka_debts,
    public.arka_pending_payments,
    public.arka_company_moves,
    public.arka_expense_requests,
    public.arka_month_closes,
    public.arka_close_requests,
    public.arka_bank_transfers,
    public.payments,
    public.orders,
    public.clients
  restart identity cascade;

  -- (Optional) Clear photo objects if your storage bucket name is tepiha-photos.
  -- This does NOT delete the bucket, just the objects.
  begin
    delete from storage.objects where bucket_id = 'tepiha-photos';
  exception when undefined_table then
    -- storage schema not present in local dev, ignore
    null;
  end;

  _deleted := json_build_object(
    'ok', true,
    'message', 'clients/orders/payments cleared; config kept'
  );

  return _deleted;
end;
$$;

-- Allow calling from anon (RPC runs as SECURITY DEFINER)
grant execute on function public.factory_reset_clients_only(integer) to anon;
