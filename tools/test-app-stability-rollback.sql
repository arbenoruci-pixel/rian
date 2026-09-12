-- Execute only inside BEGIN + candidate migration + this script + ROLLBACK.
-- No customer order, message or lasting money write is created.
CREATE TEMP TABLE app_stability_results(test text, passed boolean) ON COMMIT DROP;
DO $test$
DECLARE k text := 'CODEX-AUDIT-ROLLBACK-' || gen_random_uuid()::text;
  p text; worker_pin text; first_result jsonb; replay jsonb;
  before_balance numeric; after_first numeric; after_replay numeric;
  denied boolean;
BEGIN
  INSERT INTO public.ring_webhook_events(request_id,payload) VALUES(k,'{}') ON CONFLICT(request_id) DO NOTHING;
  INSERT INTO public.ring_webhook_events(request_id,payload) VALUES(k,'{}') ON CONFLICT(request_id) DO NOTHING;
  IF (SELECT count(*) FROM public.ring_webhook_events WHERE request_id=k) <> 1 THEN RAISE EXCEPTION 'RING_REPLAY_FAILED'; END IF;
  INSERT INTO public.ring_webhook_events(request_id,payload) VALUES(NULL,jsonb_build_object('synthetic',k)),(NULL,jsonb_build_object('synthetic',k));
  IF (SELECT count(*) FROM public.ring_webhook_events WHERE payload->>'synthetic'=k) <> 2 THEN RAISE EXCEPTION 'RING_NULL_EVENTS_LOST'; END IF;
  INSERT INTO app_stability_results VALUES('Ring: upsert replay once / NULL events preserved',true);

  denied := false;
  BEGIN
    PERFORM public.create_and_resolve_arka_expense_v2('CODEX_AUDIT_NONEXISTENT_ACTOR','Synthetic actor',1.25,'Synthetic rollback expense','BUSINESS_EXPENSE',NULL,NULL,k);
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='DISPATCH_ONLY' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'UNKNOWN_EXPENSE_ACTOR_ALLOWED'; END IF;
  denied := false;
  BEGIN
    PERFORM public.resolve_arka_expense_v2('CODEX_AUDIT_NONEXISTENT_ACTOR','Synthetic actor',-9223372036854775000,'BUSINESS_EXPENSE');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='DISPATCH_ONLY' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'UNKNOWN_RESOLUTION_ACTOR_ALLOWED'; END IF;
  INSERT INTO app_stability_results VALUES('Expense creation and resolution: absent actor rejected before data access',true);

  SELECT pin INTO worker_pin FROM public.users WHERE is_active IS TRUE AND role='PUNTOR' LIMIT 1;
  IF worker_pin IS NOT NULL THEN
    denied:=false;
    BEGIN PERFORM public.create_and_resolve_arka_expense_v2(worker_pin,'Synthetic worker',1.25,'Synthetic rollback expense','BUSINESS_EXPENSE',NULL,NULL,k);
    EXCEPTION WHEN OTHERS THEN IF SQLERRM='DISPATCH_ONLY' THEN denied:=true; ELSE RAISE; END IF; END;
    IF NOT denied THEN RAISE EXCEPTION 'WORKER_EXPENSE_ACTOR_ALLOWED'; END IF;
    INSERT INTO app_stability_results VALUES('Expense: unsupported worker role remains denied',true);
  END IF;

  SELECT pin INTO p FROM public.users WHERE is_active IS TRUE AND role='DISPATCH' LIMIT 1;
  IF p IS NULL THEN RAISE EXCEPTION 'TEST_DISPATCH_UNAVAILABLE'; END IF;
  SELECT current_balance INTO before_balance FROM public.company_budget_summary WHERE id=1;
  first_result := public.create_and_resolve_arka_expense_v2(p,'Synthetic rollback actor',1.25,'Synthetic rollback expense','BUSINESS_EXPENSE',NULL,NULL,k);
  SELECT current_balance INTO after_first FROM public.company_budget_summary WHERE id=1;
  replay := public.create_and_resolve_arka_expense_v2(p,'Synthetic rollback actor',1.25,'Synthetic rollback expense','BUSINESS_EXPENSE',NULL,NULL,k);
  SELECT current_balance INTO after_replay FROM public.company_budget_summary WHERE id=1;
  IF first_result->>'ok' IS DISTINCT FROM 'true' OR replay->>'already_exists' IS DISTINCT FROM 'true'
    OR first_result->>'expense_payment_id' IS DISTINCT FROM replay->>'expense_payment_id'
    OR after_first IS DISTINCT FROM after_replay OR before_balance-after_first IS DISTINCT FROM 1.25::numeric
    OR (SELECT count(*) FROM public.arka_pending_payments WHERE idempotency_key=k) <> 1
  THEN RAISE EXCEPTION 'EXPENSE_ATOMIC_REPLAY_FAILED'; END IF;
  INSERT INTO app_stability_results VALUES('Dispatch: expense, decision and budget debit exactly once on retry',true);
END $test$;
SELECT * FROM app_stability_results;
