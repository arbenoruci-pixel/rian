-- TEPIHA — FACTORY RESET (SUPABASE)
-- RPC NAME: public.tepiha_factory_reset_v1(p_pin text, p_confirm text)
--
-- ✅ Deletes ONLY operational data:
--   - clients, orders
--   - dispatch_tasks (+ events)
--   - arka_* (moves, days, cycles, expenses, pending)
--   - company_budget_moves / arka_company_moves
--   - backups_daily / app_backups
--   - code_leases / code_reservations
-- ✅ Resets app_state.code_counter = 0 (if app_state exists)
-- ❌ Does NOT touch: users, *_old_* tables
--
-- Run this ONCE in Supabase SQL Editor.

create or replace function public.tepiha_factory_reset_v1(
  p_pin text,
  p_confirm text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
begin
  -- hard guards
  if upper(coalesce(p_confirm,'')) <> 'RESET' then
    return json_build_object('ok', false, 'error', 'BAD_CONFIRM');
  end if;
  if coalesce(trim(p_pin),'') <> '2380' then
    return json_build_object('ok', false, 'error', 'BAD_PIN');
  end if;

  -- helper: delete table if exists
  foreach r in array[
    'dispatch_task_events',
    'dispatch_tasks',

    'arka_pending_payments',
    'arka_expense_requests',
    'arka_expenses',
    'company_budget_moves',
    'arka_company_moves',
    'arka_cycle_moves',
    'arka_cycles',
    'arka_moves',
    'arka_moves_legacy',
    'arka_handoffs',
    'arka_days',
    'arka_days_legacy',

    'backups_daily',
    'app_backups',

    'orders',
    'clients',

    'code_leases',
    'code_reservations'
  ] loop
    if to_regclass('public.'||r) is not null then
      execute format('delete from public.%I;', r);
    end if;
  end loop;

  -- reset code counter if table exists
  if to_regclass('public.app_state') is not null then
    begin
      execute 'update public.app_state set code_counter = 0;';
    exception when others then
      -- ignore if column not present
      null;
    end;
  end if;

  return json_build_object('ok', true);
end;
$$;

-- Allow calling from anon/authenticated (RPC is SECURITY DEFINER)
revoke all on function public.tepiha_factory_reset_v1(text, text) from public;
grant execute on function public.tepiha_factory_reset_v1(text, text) to anon;
grant execute on function public.tepiha_factory_reset_v1(text, text) to authenticated;
