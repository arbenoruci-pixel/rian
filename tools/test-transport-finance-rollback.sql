-- Run as one transaction: isolated synthetic client/orders; no lasting cash.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '45s';
DO $test$
DECLARE
  cid uuid := '90052010-0000-4000-8000-000000000001';
  older uuid := '90052010-0000-4000-8000-000000000002';
  current_oid uuid := '90052010-0000-4000-8000-000000000003';
  cancelled_oid uuid := '90052010-0000-4000-8000-000000000004';
  actor public.users%rowtype;
  intent text := 'codex-transport-rollback-' || gen_random_uuid();
  r jsonb; first_batch uuid; denied boolean; i integer;
BEGIN
  SELECT * INTO actor FROM public.users WHERE is_active IS TRUE
    AND (role='TRANSPORT' OR is_hybrid_transport IS TRUE)
    ORDER BY is_hybrid_transport DESC NULLS LAST LIMIT 1;
  IF actor.id IS NULL THEN RAISE EXCEPTION 'TEST_TRANSPORT_ACTOR_UNAVAILABLE'; END IF;
  INSERT INTO public.transport_clients(id,name,phone,address,search_code,tcode)
    VALUES(cid,'CODEX TRANSPORT ROLLBACK TEST','12025550177','TEST ONLY',9005201,'T9005201');
  INSERT INTO public.transport_orders(id,code_n,code_str,client_id,client_tcode,client_name,client_phone,status,data)
  SELECT id,9005201,'T9005201',cid,'T9005201','CODEX TRANSPORT ROLLBACK TEST','12025550177',st,
    jsonb_build_object('transport_id',actor.id::text,'status',st,'state',st,'pay',jsonb_build_object('euro',total,'m2',m2,'paid',0,'debt',total))
  FROM (VALUES(older,'delivery',10::numeric,5::numeric),(current_oid,'loaded',16.64::numeric,12.8::numeric),(cancelled_oid,'cancelled',9::numeric,4::numeric)) AS fixture(id,st,total,m2);

  r := public.transport_deliver_with_debt_v1(older,actor.pin,current_date+1,'TEST ONLY',intent||'-debt');
  IF r#>>'{order,status}' IS DISTINCT FROM 'done' OR (r#>>'{receivable,outstanding_amount}')::numeric IS DISTINCT FROM 10 THEN RAISE EXCEPTION 'DEBT_DELIVERY_FAILED'; END IF;
  -- Establish older debt ordering independently of timestamp precision.
  UPDATE public.transport_receivables SET delivered_at=now()-interval '1 day' WHERE transport_order_id=older;
  FOR i IN 1..10 LOOP
    r := public.transport_deliver_with_debt_v1(older,actor.pin,current_date+1,'TEST ONLY',intent||'-debt');
    IF r->>'duplicate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'DEBT_REPLAY_FAILED'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.arka_pending_payments WHERE transport_order_id=older) THEN RAISE EXCEPTION 'DEBT_CREATED_CASH'; END IF;

  r := public.transport_client_receivable_summary_v1(current_oid,cid);
  IF (r->>'totalForPayment')::numeric IS DISTINCT FROM 26.64 OR (r->>'previousOutstanding')::numeric IS DISTINCT FROM 10 THEN RAISE EXCEPTION 'CLIENT_TOTAL_FAILED'; END IF;
  denied := false;
  BEGIN
    PERFORM public.transport_collect_client_payment_guarded_v2(current_oid,actor.pin,15,'CASH',NULL,intent||'-unconfirmed',false,26.64);
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='LOADED_ORDER_REQUIRES_DELIVERY_CONFIRMATION' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'UNCONFIRMED_DELIVERY_ACCEPTED'; END IF;
  denied := false;
  BEGIN
    PERFORM public.transport_collect_client_payment_guarded_v2(current_oid,actor.pin,15,'CASH',NULL,intent||'-legacy',true,NULL);
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='EXPECTED_TOTAL_DUE_REQUIRED' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'FRESH_LEGACY_PAYMENT_ACCEPTED'; END IF;

  r := public.transport_collect_client_payment_guarded_v2(current_oid,actor.pin,15,'CASH',NULL,intent||'-1',true,26.64);
  first_batch := (r#>>'{batch,id}')::uuid;
  IF r->>'paymentVerified' IS DISTINCT FROM 'true' OR r#>>'{order,status}' IS DISTINCT FROM 'done'
    OR (r#>>'{order,data,pay,paid}')::numeric IS DISTINCT FROM 5
    OR (r#>>'{order,data,pay,debt}')::numeric IS DISTINCT FROM 11.64 THEN RAISE EXCEPTION 'PARTIAL_DELIVERY_FAILED'; END IF;
  IF (SELECT outstanding_amount FROM public.transport_receivables WHERE transport_order_id=older) IS DISTINCT FROM 0::numeric THEN RAISE EXCEPTION 'OLDEST_DEBT_NOT_PAID_FIRST'; END IF;
  IF (SELECT count(*) FROM public.transport_payment_allocations WHERE batch_id=first_batch)<>2 THEN RAISE EXCEPTION 'CLIENT_ALLOCATION_FAILED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.transport_delivery_events WHERE transport_order_id=current_oid AND cash_received=5 AND debt_created=11.64 AND payment_batch_id=first_batch) THEN RAISE EXCEPTION 'DELIVERY_EVENT_TOTAL_FAILED'; END IF;
  FOR i IN 1..100 LOOP
    r := public.transport_collect_client_payment_guarded_v2(current_oid,actor.pin,15,'CASH',NULL,intent||'-1',true,26.64);
    IF r->>'duplicate' IS DISTINCT FROM 'true' OR (r#>>'{batch,id}')::uuid IS DISTINCT FROM first_batch THEN RAISE EXCEPTION 'REPLAY_DUPLICATED_PAYMENT'; END IF;
  END LOOP;
  denied := false;
  BEGIN
    PERFORM public.transport_collect_client_payment_guarded_v2(current_oid,actor.pin,15,'CASH',NULL,intent||'-stale',false,26.64);
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAYMENT_BALANCE_CHANGED' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'STALE_BALANCE_ACCEPTED'; END IF;
  denied := false;
  BEGIN
    PERFORM public.transport_collect_client_payment_guarded_v2(current_oid,actor.pin,16,'CASH',NULL,intent||'-1',false,26.64);
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'CHANGED_PAYLOAD_ACCEPTED'; END IF;

  r := public.transport_collect_client_payment_guarded_v2(current_oid,actor.pin,20,'CASH',NULL,intent||'-2',false,11.64);
  IF (r#>>'{batch,amount_applied}')::numeric IS DISTINCT FROM 11.64 OR (r#>>'{batch,change_amount}')::numeric IS DISTINCT FROM 8.36
    OR (r#>>'{order,data,pay,paid}')::numeric IS DISTINCT FROM 16.64 OR (r#>>'{order,data,pay,debt}')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'SETTLEMENT_OR_CHANGE_FAILED'; END IF;
  r := public.transport_collect_client_payment_guarded_v2(current_oid,actor.pin,15,'CASH',NULL,intent||'-1',true,NULL);
  IF r#>>'{order,status}' IS DISTINCT FROM 'done' OR (r#>>'{order,data,pay,debt}')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'LATE_REPLAY_REGRESSED_ORDER'; END IF;
  denied := false;
  BEGIN
    PERFORM public.transport_collect_client_payment_guarded_v2(cancelled_oid,actor.pin,9,'CASH',NULL,intent||'-cancelled',false,9);
  EXCEPTION WHEN OTHERS THEN IF SQLERRM IN ('TRANSPORT_ORDER_NOT_IN_DELIVERY','TRANSPORT_ORDER_CANCELLED') THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'CANCELLED_ORDER_PAYMENT_ACCEPTED'; END IF;

  IF (SELECT count(*) FROM public.transport_payment_batches WHERE client_id=cid)<>2
    OR (SELECT sum(amount) FROM public.arka_pending_payments WHERE transport_order_id IN(older,current_oid)) IS DISTINCT FROM 26.64
    OR (SELECT count(*) FROM public.transport_delivery_events WHERE client_id=cid)<>2 THEN RAISE EXCEPTION 'FINAL_LEDGER_TOTAL_FAILED'; END IF;
  IF EXISTS(SELECT 1 FROM public.arka_pending_payments WHERE transport_order_id IN(older,current_oid) AND (status<>'COLLECTED' OR type<>'TRANSPORT' OR source_module<>'TRANSPORT')) THEN RAISE EXCEPTION 'LEDGER_CLASSIFICATION_FAILED'; END IF;
  IF EXISTS(SELECT 1 FROM public.transport_payment_allocations a JOIN public.transport_receivables r ON r.id=a.receivable_id WHERE r.client_id=cid GROUP BY r.transport_order_id HAVING sum(a.commission_m2)>CASE WHEN r.transport_order_id=older THEN 5 ELSE 12.8 END) THEN RAISE EXCEPTION 'COMMISSION_DUPLICATED'; END IF;
END $test$;
SELECT 'PASS: debt delivery, 10 debt retries, client totals, loaded confirmation, legacy guard, partial delivery, oldest-debt allocation, 100 payment retries, stale balance, changed payload, settlement/change, late replay, cancelled payment, cash ledger and commission cap' AS result;
ROLLBACK;
