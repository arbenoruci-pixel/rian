-- Restore the operational daily-close flow used by DISPATCH to accept cash handoffs.
-- The functions are SECURITY DEFINER and validate the active actor PIN/role internally.

grant execute on function public.get_arka_daily_close_preview_v4(text, date)
  to anon, authenticated, service_role;

grant execute on function public.close_arka_day_v2(
  text, text, date, bigint[], numeric, text, text, text, boolean
) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
