-- TEPIHA — ARKA STRICT OPEN-DAY FLOW
-- RULE:
--   - CLOSE DAY => handoff_status='HANDED'
--   - DISPATCH MUST "RECEIVE" cash (handoff_status='RECEIVED')
--   - ONLY THEN can a new day be OPENED

-- 1) Ensure a unique day_key per day
CREATE UNIQUE INDEX IF NOT EXISTS arka_days_day_key_uq ON public.arka_days(day_key);

-- 2) Strict RPC: open day only if there is no pending DISPATCH handover
CREATE OR REPLACE FUNCTION public.arka_open_day_strict(
  p_day_key text,
  p_initial_cash numeric,
  p_opened_by text
)
RETURNS TABLE (
  id bigint,
  day_key text,
  handoff_status text,
  opened_by text,
  opened_at timestamptz,
  opening_cash numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pending bigint;
BEGIN
  -- Block if there is any day that was CLOSED and HANDED but not yet RECEIVED by DISPATCH
  SELECT d.id INTO v_pending
  FROM public.arka_days d
  WHERE d.handoff_status = 'HANDED'
    AND d.received_at IS NULL
  ORDER BY d.closed_at DESC NULLS LAST
  LIMIT 1;

  IF v_pending IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_PENDING: pending day id % needs DISPATCH receive', v_pending;
  END IF;

  -- If a day is already OPEN, just return it (avoid duplicates)
  RETURN QUERY
  SELECT d.id, d.day_key, d.handoff_status, d.opened_by, d.opened_at, d.opening_cash
  FROM public.arka_days d
  WHERE d.handoff_status = 'OPEN'
    AND d.closed_at IS NULL
  ORDER BY d.opened_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  -- Insert a new OPEN day
  INSERT INTO public.arka_days (day_key, opened_by, opening_cash, handoff_status, opened_at)
  VALUES (p_day_key, p_opened_by, COALESCE(p_initial_cash, 0), 'OPEN', now())
  ON CONFLICT (day_key) DO UPDATE
    SET opened_by = EXCLUDED.opened_by,
        opening_cash = EXCLUDED.opening_cash,
        handoff_status = 'OPEN',
        opened_at = COALESCE(public.arka_days.opened_at, now()),
        closed_at = NULL
  RETURNING public.arka_days.id, public.arka_days.day_key, public.arka_days.handoff_status,
            public.arka_days.opened_by, public.arka_days.opened_at, public.arka_days.opening_cash
  INTO id, day_key, handoff_status, opened_by, opened_at, opening_cash;

  RETURN NEXT;
END;
$$;

-- 3) Grant anon execute (if you're using anon on frontend)
GRANT EXECUTE ON FUNCTION public.arka_open_day_strict(text, numeric, text) TO anon;
