-- TEPIHA ARKA FIX v2 (matches current arka_days schema)
-- Fixes:
-- - "function name ... is not unique" (drops old overloads)
-- - "opening_cash does not exist" (uses initial_cash)
-- - "handoff_status is ambiguous" (no joins, fully qualified)
-- - history RPC return mismatch (returns id uuid)

BEGIN;

-- OPTIONAL: wipe test data (uncomment if you want to clear everything)
-- TRUNCATE TABLE public.arka_moves, public.arka_days RESTART IDENTITY CASCADE;

-- Drop old/buggy overloads so names are unique
DROP FUNCTION IF EXISTS public.arka_open_day();
DROP FUNCTION IF EXISTS public.arka_open_day(text, numeric, text);
DROP FUNCTION IF EXISTS public.arka_open_day(text, numeric);
DROP FUNCTION IF EXISTS public.arka_open_day(text);
DROP FUNCTION IF EXISTS public.arka_open_day_strict(text, numeric, text);
DROP FUNCTION IF EXISTS public.arka_get_open_day();
DROP FUNCTION IF EXISTS public.arka_get_history_days(int);
DROP FUNCTION IF EXISTS public.arka_handoff_to_dispatch(uuid, text);
DROP FUNCTION IF EXISTS public.arka_receive_from_dispatch(uuid, numeric, text);

-- Drop old overloads (they caused name conflicts and wrong column references)
DROP FUNCTION IF EXISTS public.arka_open_day(text, numeric, text);
DROP FUNCTION IF EXISTS public.arka_open_day(text, numeric, text, text);
DROP FUNCTION IF EXISTS public.arka_open_day(text, numeric);
DROP FUNCTION IF EXISTS public.arka_open_day(text);
DROP FUNCTION IF EXISTS public.arka_open_day();

DROP FUNCTION IF EXISTS public.arka_open_day_strict(text, numeric, text);
DROP FUNCTION IF EXISTS public.arka_get_open_day();
DROP FUNCTION IF EXISTS public.arka_get_history_days(int);
DROP FUNCTION IF EXISTS public.arka_handoff_to_dispatch(uuid, text);
DROP FUNCTION IF EXISTS public.arka_receive_from_dispatch(uuid, numeric, text);

-- Main "open day" RPC used by the app
CREATE OR REPLACE FUNCTION public.arka_open_day_strict(
  p_day_key text,
  p_initial_cash numeric,
  p_opened_by text
)
RETURNS public.arka_days
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_exists int;
  v_day public.arka_days;
  v_day_date date;
BEGIN
  -- Parse YYYY-MM-DD
  BEGIN
    v_day_date := to_date(p_day_key, 'YYYY-MM-DD');
  EXCEPTION WHEN others THEN
    v_day_date := current_date;
  END;

  -- Hard stop: there is a handed day not received yet
  SELECT count(*) INTO v_exists
  FROM public.arka_days d
  WHERE d.handoff_status = 'HANDED'
    AND d.received_at IS NULL;
  IF v_exists > 0 THEN
    RAISE EXCEPTION 'Cannot open a new day: previous handoff not received yet';
  END IF;

  -- If the day is already open, just return it
  SELECT * INTO v_day
  FROM public.arka_days d
  WHERE d.day_key = p_day_key
    AND d.handoff_status = 'OPEN'
    AND d.closed_at IS NULL
  ORDER BY d.opened_at DESC
  LIMIT 1;

  IF v_day.id IS NOT NULL THEN
    RETURN v_day;
  END IF;

  -- Create new open day
  INSERT INTO public.arka_days(
    day_key,
    day_date,
    initial_cash,
    opened_at,
    opened_by,
    handoff_status
  )
  VALUES(
    p_day_key,
    v_day_date,
    COALESCE(p_initial_cash, 0),
    now(),
    COALESCE(p_opened_by, 'unknown'),
    'OPEN'
  )
  RETURNING * INTO v_day;

  RETURN v_day;
END;
$$;

-- Read current open day (or null)
CREATE OR REPLACE FUNCTION public.arka_get_open_day()
RETURNS public.arka_days
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT d.*
  FROM public.arka_days d
  WHERE d.handoff_status = 'OPEN'
    AND d.closed_at IS NULL
  ORDER BY d.opened_at DESC
  LIMIT 1;
$$;

-- History list (used by the app)
CREATE OR REPLACE FUNCTION public.arka_get_history_days(p_days int)
RETURNS TABLE(
  id uuid,
  day_key text,
  day_date date,
  opened_at timestamptz,
  closed_at timestamptz,
  opened_by text,
  closed_by text,
  initial_cash numeric,
  handoff_status text,
  received_at timestamptz,
  received_by text,
  received_amount numeric,
  expected_cash numeric,
  cash_counted numeric,
  discrepancy numeric
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    d.id,
    d.day_key,
    d.day_date,
    d.opened_at,
    d.closed_at,
    d.opened_by,
    d.closed_by,
    d.initial_cash,
    d.handoff_status,
    d.received_at,
    d.received_by,
    d.received_amount,
    d.expected_cash,
    d.cash_counted,
    d.discrepancy
  FROM public.arka_days d
  WHERE d.day_date >= (current_date - make_interval(days => COALESCE(p_days, 60)))
  ORDER BY d.day_date DESC, d.opened_at DESC;
$$;

-- Basic handoff to dispatch (minimal implementation so buttons don't break)
CREATE OR REPLACE FUNCTION public.arka_handoff_to_dispatch(p_day_id uuid, p_by text)
RETURNS public.arka_days
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_day public.arka_days;
BEGIN
  UPDATE public.arka_days d
  SET
    handoff_status = 'HANDED',
    handed_at = now(),
    handed_by = COALESCE(p_by, 'unknown')
  WHERE d.id = p_day_id
  RETURNING * INTO v_day;

  IF v_day.id IS NULL THEN
    RAISE EXCEPTION 'Day not found';
  END IF;

  RETURN v_day;
END;
$$;

-- Receive from dispatch
CREATE OR REPLACE FUNCTION public.arka_receive_from_dispatch(p_day_id uuid, p_amount numeric, p_by text)
RETURNS public.arka_days
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_day public.arka_days;
BEGIN
  UPDATE public.arka_days d
  SET
    handoff_status = 'RECEIVED',
    received_at = now(),
    received_by = COALESCE(p_by, 'unknown'),
    received_amount = COALESCE(p_amount, 0)
  WHERE d.id = p_day_id
  RETURNING * INTO v_day;

  IF v_day.id IS NULL THEN
    RAISE EXCEPTION 'Day not found';
  END IF;

  RETURN v_day;
END;
$$;

-- Permissions (anon)
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.arka_days TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.arka_moves TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.arka_open_day_strict(text, numeric, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arka_get_open_day() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arka_get_history_days(int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arka_handoff_to_dispatch(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arka_receive_from_dispatch(uuid, numeric, text) TO anon, authenticated;

COMMIT;
