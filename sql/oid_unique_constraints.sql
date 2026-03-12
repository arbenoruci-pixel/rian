BEGIN;

-- ============================================================
-- PERMANENT CODES + OID SYNC
-- Move uniqueness from reusable client code -> stable order identifiers
--
-- 1) Drop old UNIQUE constraints on reusable codes
-- 2) Add UNIQUE constraints on stable IDs
-- ============================================================

-- Drop old constraints (names from our previous setup)
ALTER TABLE IF EXISTS public.orders
  DROP CONSTRAINT IF EXISTS orders_code_unique;

ALTER TABLE IF EXISTS public.transport_orders
  DROP CONSTRAINT IF EXISTS transport_orders_tcode_unique;

-- Add new constraints
ALTER TABLE IF EXISTS public.orders
  ADD CONSTRAINT orders_local_oid_unique UNIQUE (local_oid);

ALTER TABLE IF EXISTS public.transport_orders
  ADD CONSTRAINT transport_orders_id_unique UNIQUE (id);

COMMIT;
