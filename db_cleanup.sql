-- db_cleanup.sql
-- TEPIHA: Clean redundant/overlapping UNIQUE constraints on public.orders
-- Goal: keep ONLY
--  - orders_pkey (PRIMARY KEY)
--  - ONE unique constraint for code
--  - ONE unique constraint for code_n
--  - ONE unique constraint for local_oid
--
-- Safe to run multiple times.

BEGIN;

-- Drop known redundant/conflicting constraints (IF EXISTS so it's safe)
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_code_key;
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_code_unique;
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_code_n_key;
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_code_n_unique;
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_code_n_client_phone_uniq;
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_code_client_phone_uniq;
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_code_n_phone_uniq;
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_local_oid_key;
ALTER TABLE IF EXISTS public.orders DROP CONSTRAINT IF EXISTS orders_local_oid_unique;

-- Re-create the minimal, canonical uniques if they don't exist.
DO $$
BEGIN
  -- code unique
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'orders'
      AND c.contype = 'u'
      AND c.conname = 'orders_code_uniq'
  ) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_code_uniq UNIQUE (code);
  END IF;

  -- code_n unique
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'orders'
      AND c.contype = 'u'
      AND c.conname = 'orders_code_n_uniq'
  ) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_code_n_uniq UNIQUE (code_n);
  END IF;

  -- local_oid unique
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'orders'
      AND c.contype = 'u'
      AND c.conname = 'orders_local_oid_uniq'
  ) THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_local_oid_uniq UNIQUE (local_oid);
  END IF;
END $$;

COMMIT;
