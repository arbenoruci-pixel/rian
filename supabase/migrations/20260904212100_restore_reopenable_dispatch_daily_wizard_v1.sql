-- Restore the full Dispatch daily wizard without bringing back the obsolete
-- permanent closed-day guard. A finalized report stays as history; later
-- distinct worker handoffs or outgoing movements can reopen and refresh it.

do $patch$
declare
  v_oid oid;
  v_def text;
  v_old text;
  v_new text;
  v_changed boolean := false;
begin
  select p.oid
  into v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'close_arka_day_v2'
    and pg_get_function_identity_arguments(p.oid) = 'p_actor_pin text, p_actor_name text, p_date date, p_handoff_ids bigint[], p_counted_cash numeric, p_discrepancy_reason text, p_discrepancy_note text, p_idempotency_key text, p_dry_run boolean'
  limit 1;

  if v_oid is null then
    raise exception 'CLOSE_ARKA_DAY_V2_NOT_FOUND';
  end if;

  v_def := pg_get_functiondef(v_oid);

  v_old := $old$
  if found and v_existing.is_closed is true then
    return jsonb_build_object('ok',true,'already_closed',true,'cycle',to_jsonb(v_existing));
  end if;
$old$;
  v_new := $new$
  -- A previous finalization is a report snapshot, not a permanent lock.
  -- Distinct worker handoffs submitted later reopen the same operational-day flow.
$new$;
  if position(v_old in v_def) > 0 then
    v_def := replace(v_def, v_old, v_new);
    v_changed := true;
  elsif position('A previous finalization is a report snapshot' in v_def) = 0 then
    raise exception 'CLOSED_DAY_EARLY_RETURN_ANCHOR_NOT_FOUND';
  end if;

  v_old := $old$
    set idempotency_key=coalesce(idempotency_key,v_key),updated_at=now()
$old$;
  v_new := $new$
    set idempotency_key=v_key,
        is_closed=false,
        close_status='CLOSING',
        closed_at=null,
        updated_at=now()
$new$;
  if position(v_old in v_def) > 0 then
    v_def := replace(v_def, v_old, v_new);
    v_changed := true;
  elsif position("close_status='CLOSING'" in v_def) = 0 then
    raise exception 'CYCLE_REOPEN_UPDATE_ANCHOR_NOT_FOUND';
  end if;

  v_old := $old$
      selected_handoff_ids=v_ids,
$old$;
  v_new := $new$
      selected_handoff_ids=(
        select coalesce(array_agg(distinct selected_id order by selected_id),'{}'::bigint[])
        from unnest(coalesce(arka_cycles.selected_handoff_ids,'{}'::bigint[]) || v_ids) selected_id
      ),
$new$;
  if position(v_old in v_def) > 0 then
    v_def := replace(v_def, v_old, v_new);
    v_changed := true;
  elsif position('from unnest(coalesce(arka_cycles.selected_handoff_ids' in v_def) = 0 then
    raise exception 'CUMULATIVE_HANDOFF_IDS_ANCHOR_NOT_FOUND';
  end if;

  if v_changed then
    execute v_def;
  end if;
end
$patch$;

grant execute on function public.close_arka_day_v2(
  text,text,date,bigint[],numeric,text,text,text,boolean
) to anon, authenticated, service_role;

comment on function public.close_arka_day_v2(
  text,text,date,bigint[],numeric,text,text,text,boolean
) is 'Dispatch operational-day intake/finalization. A prior report does not block later distinct worker handoffs; the same day can be re-finalized with cumulative receipt history.';
