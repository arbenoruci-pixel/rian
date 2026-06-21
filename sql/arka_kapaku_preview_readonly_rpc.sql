-- =========================================================
-- FAZA 4B-3 FIX — KAPAKU I ARKËS READ-ONLY PREVIEW RPC
-- Security definer RPC for read-only /arka/kapaku preview.
-- Purpose: owner_* tables have RLS enabled without read policies.
-- This function performs SELECT only. No writes, no ledger entries,
-- no budget updates, no owner balance updates.
-- =========================================================

create or replace function public.get_arka_kapaku_preview(
  p_month_start timestamptz default null,
  p_month_end timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month_start timestamptz := coalesce(p_month_start, date_trunc('month', now()));
  v_month_end timestamptz := coalesce(p_month_end, date_trunc('month', now()) + interval '1 month');
  v_result jsonb;
begin
  select jsonb_build_object(
    'summary', (
      select to_jsonb(s)
      from public.company_budget_summary s
      where s.id = 1
      limit 1
    ),

    'ledger', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select *
        from public.company_budget_ledger
        order by created_at desc nulls last
        limit 20
      ) x
    ), '[]'::jsonb),

    'owners', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select
          id,
          owner_key,
          display_name,
          profit_share_percent,
          default_repayment_percent,
          is_active,
          person_pin,
          linked_user_id
        from public.owner_accounts
        order by display_name asc nulls last, id asc
        limit 50
      ) x
    ), '[]'::jsonb),

    'ownerEntries', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select
          id,
          owner_id,
          entry_type,
          direction,
          amount,
          remaining_amount,
          priority,
          status,
          funding_date,
          note,
          company_ledger_entry_id,
          created_at
        from public.owner_capital_entries
        order by priority asc nulls last, created_at asc nulls last, id asc
        limit 500
      ) x
    ), '[]'::jsonb),

    'fixedExpenses', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select *
        from public.company_fixed_expenses
        where active = true
        order by due_day asc nulls last, title asc nulls last, id asc
        limit 500
      ) x
    ), '[]'::jsonb),

    'users', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select *
        from public.users
        limit 1000
      ) x
    ), '[]'::jsonb),

    'monthPayments', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select *
        from public.arka_pending_payments
        where created_at >= v_month_start
          and created_at < v_month_end
        order by created_at desc nulls last
        limit 3000
      ) x
    ), '[]'::jsonb),

    'openPayments', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select *
        from public.arka_pending_payments
        where status in ('PENDING', 'COLLECTED')
        order by created_at desc nulls last
        limit 3000
      ) x
    ), '[]'::jsonb),

    'handoffs', coalesce((
      select jsonb_agg(to_jsonb(x))
      from (
        select *
        from public.cash_handoffs
        where status in ('PENDING_DISPATCH_APPROVAL')
        order by submitted_at desc nulls last
        limit 1000
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all on function public.get_arka_kapaku_preview(timestamptz, timestamptz) from public;
grant execute on function public.get_arka_kapaku_preview(timestamptz, timestamptz) to anon, authenticated;
