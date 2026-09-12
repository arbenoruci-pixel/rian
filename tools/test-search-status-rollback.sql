-- Synthetic fixture only; always execute this entire file so nothing is committed.
BEGIN;
DO $test$
DECLARE fixture_id bigint := 90000000004101; original_version timestamptz; affected int;
BEGIN
  INSERT INTO public.orders(id,code,local_oid,status,client_name,client_phone,created_at,updated_at,m2_total,price_total,paid,paid_cash,data)
  VALUES(fixture_id,9004101,'codex-search-status-'||gen_random_uuid(),'pastrim','CODEX ROLLBACK TEST','',now(),now()-interval '1 minute',1,1.30,0,0,
    jsonb_build_object('paketimi_v1',jsonb_build_object('status','final_ready'),'pay',jsonb_build_object('euro',1.30,'paid',0,'debt',1.30),'items','[]'::jsonb));
  SELECT updated_at INTO original_version FROM public.orders WHERE id=fixture_id;
  UPDATE public.orders SET status='gati',updated_at=clock_timestamp() WHERE id=fixture_id AND updated_at=original_version;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected<>1 THEN RAISE EXCEPTION 'CURRENT_VERSION_WRITE_FAILED'; END IF;
  UPDATE public.orders SET status='pastrim',updated_at=clock_timestamp() WHERE id=fixture_id AND updated_at=original_version;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected<>0 OR (SELECT status FROM public.orders WHERE id=fixture_id)<>'gati' THEN RAISE EXCEPTION 'STALE_STATUS_OVERWROTE_CURRENT'; END IF;
  IF EXISTS(SELECT 1 FROM public.arka_pending_payments WHERE order_id=fixture_id) THEN RAISE EXCEPTION 'STATUS_ONLY_CREATED_PAYMENT'; END IF;
END $test$;
SELECT 'PASS: current version saved; stale version affected zero rows; no payment created; fixture rolled back' AS result;
ROLLBACK;
