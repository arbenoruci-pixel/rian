-- FACTORY RESET (DESTRUKTIVE)
-- Run këtë SQL në Supabase SQL Editor.
--
-- Qëllimi: me e kthy sistemin në 0 (porosi/klienta/arka/pagesa/pending/backup/foto).
--
-- Shënim: Kjo NUK i fshin puntorët/PIN (public.tepiha_users), që me mujt me hy prap.

create or replace function public.factory_reset_tepiha(
  p_confirm text,
  p_requested_by text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
  deleted_photos int := 0;
  deleted_rows jsonb := '{}'::jsonb;
  who text := coalesce(nullif(trim(p_requested_by),''), 'SYSTEM');
  tables text[] := ARRAY[
    'public.orders',
    'public.clients',
    'public.arka_cycle_moves',
    'public.arka_cycles',
    'public.arka_days',
    'public.arka_moves',
    'public.arka_staff',
    'public.arka_debts',
    'public.arka_owners',
    'public.arka_month_closes',
    'public.arka_pending_payments',
    'public.arka_company_moves',
    'public.arka_expense_requests',
    'public.app_backups',
    'public.backups',
    'public.backups_daily'
  ];
begin
  if upper(coalesce(trim(p_confirm),'')) <> 'RESET' then
    raise exception 'CONFIRM_REQUIRED';
  end if;

  foreach t in array tables loop
    if to_regclass(t) is not null then
      execute format('truncate table %s restart identity cascade', t);
      deleted_rows := deleted_rows || jsonb_build_object(t, 'TRUNCATED');
    end if;
  end loop;

  -- Storage: fshi fotot (bucket tepiha-photos)
  if to_regclass('storage.objects') is not null then
    execute $$delete from storage.objects where bucket_id in ('tepiha-photos','tepiha_photos','photos','tepiha')$$;
    get diagnostics deleted_photos = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'by', who,
    'tables', deleted_rows,
    'photos_deleted', deleted_photos,
    'at', now()
  );
end;
$$;
