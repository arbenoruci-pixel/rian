begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

-- TRANSPORT_TCODE_ALLOCATOR_HOT_PATH_V3
--
-- The strict-smallest V2 allocator evaluated the full lifecycle guard for
-- every available pool row before ORDER BY/LIMIT. With 115 released rows, one
-- allocation repeated the same cross-table guard 115 times while holding the
-- allocator-wide advisory lock. PostgREST's eight-second statement timeout
-- then cancelled Dispatch creates and queued retries behind that lock.
--
-- Walk the pool in numeric order and stop at the first lifecycle-safe row.
-- This preserves the exact strict-smallest rule and all fail-closed guards,
-- while the normal hot path evaluates the expensive guard once.
select pg_advisory_xact_lock(
  hashtextextended('transport-code-allocator-v3', 0)
);

create or replace function public.reserve_transport_codes_batch(
  p_owner_id text,
  p_n integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text := coalesce(nullif(btrim(p_owner_id), ''), 'UNKNOWN_USER');
  -- The public legacy signature is intentionally one-code-only. Without an
  -- immutable request id, a multi-code response cannot be retried safely.
  v_wanted constant integer := 1;
  v_codes text[] := array[]::text[];
  v_pool_code text;
  v_pool_code_n bigint;
  v_pool_scan_after bigint;
  v_code text;
  v_candidate text;
  v_fresh_n bigint;
  v_cursor_exhausted boolean;
  v_guard integer;
begin
  -- Every allocator that can claim a transport pool row takes this same lock.
  -- Waiting for the candidate row preserves strict numeric ordering.
  perform pg_advisory_xact_lock(
    hashtextextended('transport-code-allocator-v3', 0)
  );

  while coalesce(array_length(v_codes, 1), 0) < v_wanted loop
    v_pool_code := null;
    v_pool_code_n := null;
    v_pool_scan_after := 0;
    v_fresh_n := null;
    v_candidate := null;
    v_guard := 0;

    -- Find the first safe number at/after the transactional fresh frontier.
    -- Collision skips also roll back if the surrounding order fails.
    loop
      v_guard := v_guard + 1;
      if v_guard > 10000 then
        raise exception using
          errcode = 'P0001',
          message = 'TRANSPORT_CODE_ALLOCATOR_EXHAUSTED';
      end if;

      select s.next_fresh, s.exhausted
      into v_fresh_n, v_cursor_exhausted
      from public.transport_code_allocator_state_v2 s
      where s.singleton
      for update;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'TRANSPORT_CODE_CURSOR_STATE_MISSING';
      end if;

      if v_cursor_exhausted then
        v_fresh_n := null;
        exit;
      end if;

      v_candidate := 'T' || v_fresh_n::text;

      if exists (
          select 1
          from public.transport_code_pool p
          where public.transport_tcode_number_v2(p.code) = v_fresh_n
        )
        or public.transport_tcode_has_lifecycle_reference_v2(v_candidate)
      then
        if v_fresh_n = 9223372036854775807 then
          update public.transport_code_allocator_state_v2 s
          set exhausted = true,
              updated_at = now()
          where s.singleton
            and s.next_fresh = v_fresh_n
            and not s.exhausted;
        else
          update public.transport_code_allocator_state_v2 s
          set next_fresh = v_fresh_n + 1,
              updated_at = now()
          where s.singleton
            and s.next_fresh = v_fresh_n
            and not s.exhausted;
        end if;

        if not found then
          raise exception using
            errcode = '40001',
            message = 'TRANSPORT_CODE_CURSOR_ADVANCE_RACE';
        end if;
        continue;
      end if;

      exit;
    end loop;

    -- Compare the safe fresh frontier with the smallest explicitly released
    -- row. Fetch one numeric candidate at a time so the full lifecycle guard
    -- runs only until the first safe row instead of once for the whole pool.
    loop
      select p.code, parsed.code_n
      into v_pool_code, v_pool_code_n
      from public.transport_code_pool p
      cross join lateral (
        select public.transport_tcode_number_v2(p.code) as code_n
      ) parsed
      where p.status = 'available'
        and p.owner_id = 'POOL'
        and p.reserved_at is null
        and parsed.code_n is not null
        and parsed.code_n > v_pool_scan_after
        and p.code = 'T' || parsed.code_n::text
      order by parsed.code_n asc, p.code asc
      limit 1
      for update;

      if not found then
        v_pool_code := null;
        v_pool_code_n := null;
        exit;
      end if;

      v_pool_scan_after := v_pool_code_n;
      if not public.transport_tcode_has_lifecycle_reference_v2(v_pool_code) then
        exit;
      end if;

      v_pool_code := null;
      v_pool_code_n := null;
    end loop;

    if v_pool_code is not null
       and (v_fresh_n is null or v_pool_code_n <= v_fresh_n)
    then
      v_code := 'T' || v_pool_code_n::text;

      update public.transport_code_pool p
      set status = 'used',
          owner_id = v_owner,
          reserved_at = now()
      where p.code = v_pool_code
        and p.status = 'available';

      if not found then
        raise exception using
          errcode = '40001',
          message = 'TRANSPORT_SMALLEST_AVAILABLE_CLAIM_RACE';
      end if;

      v_codes := array_append(v_codes, v_code);
      continue;
    end if;

    if v_fresh_n is null then
      raise exception using
        errcode = 'P0001',
        message = 'TRANSPORT_CODE_ALLOCATOR_EXHAUSTED';
    end if;

    if v_fresh_n = 9223372036854775807 then
      update public.transport_code_allocator_state_v2 s
      set exhausted = true,
          updated_at = now()
      where s.singleton
        and s.next_fresh = v_fresh_n
        and not s.exhausted;
    else
      update public.transport_code_allocator_state_v2 s
      set next_fresh = v_fresh_n + 1,
          updated_at = now()
      where s.singleton
        and s.next_fresh = v_fresh_n
        and not s.exhausted;
    end if;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'TRANSPORT_CODE_CURSOR_CLAIM_RACE';
    end if;

    insert into public.transport_code_pool(
      code,
      owner_id,
      status,
      reserved_at
    ) values (
      v_candidate,
      v_owner,
      'used',
      now()
    );

    v_codes := array_append(v_codes, v_candidate);
  end loop;

  return to_jsonb(v_codes);
end;
$$;

revoke all on function public.reserve_transport_codes_batch(text, integer)
  from public;
grant execute on function public.reserve_transport_codes_batch(text, integer)
  to anon, authenticated, service_role;

comment on function public.reserve_transport_codes_batch(text, integer) is
  'Strict-smallest transport T-code allocator; V3 stops lifecycle scans at the first safe numeric pool row.';

notify pgrst, 'reload schema';

commit;
