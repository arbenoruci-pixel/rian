
-- fix_code_and_storage.sql — Tepiha one-shot
ALTER TABLE public.orders
  ALTER COLUMN code TYPE BIGINT USING code::bigint;
CREATE SEQUENCE IF NOT EXISTS public.order_code_seq;
ALTER TABLE public.orders
  ALTER COLUMN code SET DEFAULT nextval('public.order_code_seq');
SELECT setval('public.order_code_seq', COALESCE((SELECT MAX(code) FROM public.orders), 0));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='orders_code_key'
  ) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_code_key UNIQUE(code);
  END IF;
END$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.create_order_with_next_code(
  p_name text,
  p_phone text,
  p_items jsonb,
  p_total numeric
)
RETURNS SETOF public.orders
LANGUAGE plpgsql
AS $$
DECLARE
  v_code bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(777);
  v_code := nextval('public.order_code_seq');

  RETURN QUERY
  INSERT INTO public.orders(id, code, name, phone, status, items, total, created_at, updated_at)
  VALUES (gen_random_uuid(), v_code, p_name, p_phone, 'pastrim', p_items, p_total, NOW(), NOW())
  RETURNING *;
END;
$$;

-- Storage policies
CREATE POLICY IF NOT EXISTS "public read tepiha"
ON storage.objects FOR SELECT TO anon
USING (bucket_id = 'tepiha-photos');

CREATE POLICY IF NOT EXISTS "public insert tepiha"
ON storage.objects FOR INSERT TO anon
WITH CHECK (bucket_id = 'tepiha-photos');

CREATE POLICY IF NOT EXISTS "public update tepiha"
ON storage.objects FOR UPDATE TO anon
USING (bucket_id = 'tepiha-photos');

CREATE POLICY IF NOT EXISTS "public delete tepiha"
ON storage.objects FOR DELETE TO anon
USING (bucket_id = 'tepiha-photos');
