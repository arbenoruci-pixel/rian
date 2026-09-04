-- Disable legacy daily ARKA open/close RPCs for application roles.
-- Historical functions/tables are retained for audit and service-role access.

revoke execute on function public.arka_get_active_day() from public, anon, authenticated;
revoke execute on function public.arka_open_cycle_safe(date) from public, anon, authenticated;
revoke execute on function public.close_arka_day_v2(text,text,date,bigint[],numeric,text,text,text,boolean) from public, anon, authenticated;
revoke execute on function public.get_arka_daily_close_preview_v2(text,date) from public, anon, authenticated;
revoke execute on function public.get_arka_daily_close_preview_v3(text,date) from public, anon, authenticated;
revoke execute on function public.add_arka_closed_day_expense_v1(text,text,date,numeric,text,text) from public, anon, authenticated;
