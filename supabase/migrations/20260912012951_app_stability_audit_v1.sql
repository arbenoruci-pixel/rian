-- The webhook upsert targets request_id without a predicate. A full unique
-- index has the same non-null uniqueness and allows multiple NULL events.
CREATE UNIQUE INDEX IF NOT EXISTS ring_webhook_events_request_id_unique
  ON public.ring_webhook_events(request_id);
DROP INDEX IF EXISTS public.ring_webhook_events_request_id_uidx;

-- A SELECT with no active actor sets v_role to NULL. SQL NOT IN alone would
-- not reject it. Preserve the existing role lists, signatures and grants.
DO $migration$
DECLARE signature text; definition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.create_and_resolve_arka_expense_v2(text,text,numeric,text,text,text,text,text)',
    'public.resolve_arka_expense_v2(text,text,bigint,text,text,text,text)'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    IF position('if v_role not in' in definition) > 0 THEN
      EXECUTE replace(definition, 'if v_role not in', 'if v_role is null or v_role not in');
    ELSIF position('if v_role is null or v_role not in' in definition) = 0 THEN
      RAISE EXCEPTION 'EXPENSE_ROLE_GUARD_SHAPE_CHANGED:%', signature;
    END IF;
  END LOOP;
END $migration$;
