-- Execute the whole file. Synthetic order only, no lasting ledger entries.
BEGIN;
DO $test$
DECLARE
  oid bigint := 90000000005101;
  actor_pin text;
  intent text := 'codex-payment-rollback-' || gen_random_uuid();
  r jsonb; first_receipt jsonb; denied boolean; i int;
BEGIN
  SELECT pin INTO actor_pin FROM public.users WHERE is_active IS TRUE AND role='DISPATCH' LIMIT 1;
  IF actor_pin IS NULL THEN RAISE EXCEPTION 'TEST_ACTOR_UNAVAILABLE'; END IF;
  INSERT INTO public.orders(id,code,local_oid,status,client_name,client_phone,created_at,updated_at,m2_total,price_total,total,paid,paid_cash,data)
  VALUES(oid,9005101,'codex-payment-rollback-'||gen_random_uuid(),'pastrim','CODEX ROLLBACK TEST','',now(),now(),12.8,16.64,16.64,0,0,
    jsonb_build_object('pay',jsonb_build_object('euro',16.64,'paid',0,'debt',16.64),'items','[]'::jsonb));

  r:=public.record_base_order_cash_payment_atomic_v1(oid,5,16.64,actor_pin,p_payment_outcome=>'PREPAY_STAYS_PASTRIMI',p_status_on_full_payment=>'pastrim',p_idempotency_key=>intent||'-1');
  first_receipt:=r->'payment';
  IF r->>'ok'<>'true' OR r#>>'{order,status}'<>'pastrim' OR (r#>>'{order,paid}')::numeric<>5 OR (r#>>'{order,data,pay,debt}')::numeric<>11.64 THEN RAISE EXCEPTION 'PARTIAL_PREPAY_FAILED'; END IF;

  FOR i IN 1..10 LOOP
    r:=public.record_base_order_cash_payment_atomic_v1(oid,5,16.64,actor_pin,p_payment_outcome=>'PREPAY_STAYS_PASTRIMI',p_status_on_full_payment=>'pastrim',p_idempotency_key=>intent||'-1');
    IF r->>'duplicate'<>'true' OR r->'payment'<>first_receipt OR (r#>>'{order,paid}')::numeric<>5 THEN RAISE EXCEPTION 'REPLAY_DUPLICATED_CASH'; END IF;
  END LOOP;

  denied:=false;
  BEGIN
    PERFORM public.record_base_order_cash_payment_atomic_v1(oid,5,16.64,actor_pin,p_payment_outcome=>'PREPAY_STAYS_PASTRIMI',p_status_on_full_payment=>'pastrim',p_idempotency_key=>intent||'-stale');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BASE_PAYMENT_STALE_DEBT%' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'STALE_DEBT_ACCEPTED'; END IF;

  denied:=false;
  BEGIN
    PERFORM public.record_base_order_cash_payment_atomic_v1(oid,6,16.64,actor_pin,p_payment_outcome=>'PREPAY_STAYS_PASTRIMI',p_status_on_full_payment=>'pastrim',p_idempotency_key=>intent||'-1');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='BASE_ARKA_IDEMPOTENCY_CONFLICT' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'CHANGED_AMOUNT_REUSED_KEY'; END IF;

  denied:=false;
  BEGIN
    PERFORM public.record_base_order_cash_payment_atomic_v1(oid,12,11.64,actor_pin,p_payment_outcome=>'PREPAY_STAYS_PASTRIMI',p_status_on_full_payment=>'pastrim',p_idempotency_key=>intent||'-over');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='BASE_PAYMENT_OVER_DEBT' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'OVERPAYMENT_ACCEPTED'; END IF;

  denied:=false;
  BEGIN
    PERFORM public.record_base_order_cash_payment_atomic_v1(oid,5,11.64,actor_pin,p_payment_outcome=>'CLIENT_PICKED_UP_TO_DORZIM',p_status_on_full_payment=>'dorzim',p_idempotency_key=>intent||'-pickup');
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='PICKUP_REQUIRES_FULL_PAYMENT' THEN denied:=true; ELSE RAISE; END IF; END;
  IF NOT denied THEN RAISE EXCEPTION 'PARTIAL_PICKUP_ACCEPTED'; END IF;

  r:=public.record_base_order_cash_payment_atomic_v1(oid,5,11.64,actor_pin,p_payment_outcome=>'PREPAY_STAYS_PASTRIMI',p_status_on_full_payment=>'pastrim',p_idempotency_key=>intent||'-2');
  IF (r#>>'{order,paid}')::numeric<>10 OR (r#>>'{order,data,pay,debt}')::numeric<>6.64 THEN RAISE EXCEPTION 'SECOND_EQUAL_PAYMENT_LOST'; END IF;
  r:=public.record_base_order_cash_payment_atomic_v1(oid,6.64,6.64,actor_pin,p_payment_outcome=>'CLIENT_PICKED_UP_TO_DORZIM',p_status_on_full_payment=>'dorzim',p_idempotency_key=>intent||'-3');
  IF r#>>'{order,status}'<>'dorzim' OR (r#>>'{order,paid}')::numeric<>16.64 OR (r#>>'{order,data,pay,debt}')::numeric<>0 THEN RAISE EXCEPTION 'FULL_SETTLEMENT_FAILED'; END IF;
  r:=public.record_base_order_cash_payment_atomic_v1(oid,5,16.64,actor_pin,p_payment_outcome=>'PREPAY_STAYS_PASTRIMI',p_status_on_full_payment=>'pastrim',p_idempotency_key=>intent||'-1');
  IF r#>>'{order,status}'<>'dorzim' OR (r#>>'{order,paid}')::numeric<>16.64 THEN RAISE EXCEPTION 'OLD_REPLAY_REOPENED_ORDER'; END IF;
  IF (SELECT count(*) FROM public.arka_pending_payments WHERE order_id=oid)<>3 OR (SELECT sum(amount) FROM public.arka_pending_payments WHERE order_id=oid)<>16.64 THEN RAISE EXCEPTION 'LEDGER_TOTAL_FAILED'; END IF;
  IF EXISTS(SELECT 1 FROM public.arka_pending_payments WHERE order_id=oid AND status<>'PENDING') THEN RAISE EXCEPTION 'CASH_HANDOFF_STATUS_CHANGED'; END IF;
END $test$;
SELECT 'PASS: partial payment, 10 exact retries, stale debt, changed payload, overpayment, pickup guard, second equal payment, full settlement, late replay and ledger total' AS result;
ROLLBACK;
