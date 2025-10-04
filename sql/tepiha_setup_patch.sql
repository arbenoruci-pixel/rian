
-- tepiha_setup_patch.sql (idempotent, safe to re-run)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relkind='S' AND relname='code_seq') THEN
    CREATE SEQUENCE public.code_seq START 1;
  END IF;
END$$;

CREATE OR REPLACE FUNCTION public.next_code() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE nxt integer;
BEGIN
  SELECT nextval('public.code_seq') INTO nxt;
  RETURN nxt;
END; $$;

GRANT USAGE, SELECT ON SEQUENCE public.code_seq TO anon;

ALTER TABLE IF EXISTS public.orders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.payments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.orders   TO anon;
GRANT SELECT, INSERT            ON public.payments TO anon;

DROP POLICY IF EXISTS "anon read orders"  ON public.orders;
DROP POLICY IF EXISTS "anon write orders" ON public.orders;
CREATE POLICY "anon read orders"  ON public.orders FOR SELECT USING (true);
CREATE POLICY "anon write orders" ON public.orders FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "anon read payments"  ON public.payments;
DROP POLICY IF EXISTS "anon write payments" ON public.payments;
CREATE POLICY "anon read payments"  ON public.payments FOR SELECT USING (true);
CREATE POLICY "anon write payments" ON public.payments FOR INSERT WITH CHECK (true);
