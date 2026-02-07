-- TEPIHA — FULL FACTORY RESET (BASE + TRANSPORT)
--
-- ✅ Fshin krejt të dhënat operative (rreshtat) dhe i nis ID/seq prej 1
-- ✅ Nuk e prek skemën / emrat / kolonat
-- ✅ Nuk i fshin tabelat e konfigurimit (p.sh. tepiha_users) që me mujt me hy prap
-- ✅ (Opsionale) Fotot në Storage i fshin API me service-role, jo këtu
--
-- Instalimi: run këtë SQL ONCE në Supabase SQL Editor.

create or replace function public.factory_reset_full_tepiha_v1(
  pin integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _pin int := pin;
  t text;
  touched jsonb := '{}'::jsonb;
  tables text[] := ARRAY[
    -- BASE
    'public.orders',
    'public.clients',

    -- TRANSPORT
    'public.transport_orders',
    'public.transport_clients',

    -- ARKA / FINANCE (operacionale)
    'public.arka_cycle_moves',
    'public.arka_cycles',
    'public.arka_days',
    'public.arka_moves',
    'public.arka_moves_legacy',
    'public.arka_handoffs',
    'public.arka_pending_payments',
    'public.arka_expense_requests',
    'public.arka_expenses',
    'public.arka_company_moves',
    'public.company_budget_moves',
    'public.arka_month_closes',
    'public.arka_close_requests',
    'public.arka_bank_transfers',
    'public.payments',

    -- DISPATCH / TASKS (nëse ekzistojnë)
    'public.dispatch_task_events',
    'public.dispatch_tasks',

    -- BACKUPS
    'public.app_backups',
    'public.backups',
    'public.backups_daily',

    -- CODE LEASES (legacy)
    'public.code_leases',
    'public.code_reservations'
  ];
begin
  if _pin is null or _pin <> 2380 then
    raise exception 'BAD_PIN';
  end if;

  foreach t in array tables loop
    if to_regclass(t) is not null then
      execute format('truncate table %s restart identity cascade', t);
      touched := touched || jsonb_build_object(t, 'TRUNCATED');
    end if;
  end loop;

  -- Reset counters if present
  if to_regclass('public.app_state') is not null then
    begin
      execute 'update public.app_state set code_counter = 0;';
    exception when others then
      null;
    end;
  end if;

  return jsonb_build_object('ok', true, 'tables', touched, 'at', now());
end;
$$;

grant execute on function public.factory_reset_full_tepiha_v1(integer) to anon;
grant execute on function public.factory_reset_full_tepiha_v1(integer) to authenticated;
