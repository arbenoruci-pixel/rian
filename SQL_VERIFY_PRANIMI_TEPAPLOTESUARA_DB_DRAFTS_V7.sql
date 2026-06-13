-- Read-only verification for PRANIMI DB-backed incomplete drafts V7

-- 1) Find current DB-backed incomplete drafts
select
  id,
  local_oid,
  code,
  client_name,
  client_phone,
  status,
  data->>'status' as data_status,
  data->>'is_pranimi_incomplete_draft' as is_pranimi_incomplete_draft,
  data#>>'{pranimi_code_lifecycle,draft_id}' as draft_id,
  data#>>'{pranimi_code_lifecycle,created_by_pin}' as created_by_pin,
  updated_at,
  created_at
from public.orders
where lower(coalesce(status, data->>'status', '')) in (
  'draft',
  'incomplete',
  'paplotesuar',
  'pa_plotesuar',
  'pa_plotsuar',
  'e_paplotesuar',
  'e_pa_plotesuar',
  'e_pa_plotsuar',
  'te_paplotesuara',
  'te_pa_plotesuara',
  'te_pa_plotsuara',
  'local_draft',
  'pending_draft'
)
order by updated_at desc
limit 50;

-- 2) Verify one new test draft by code/name. Replace values.
select
  id,
  local_oid,
  code,
  client_name,
  client_phone,
  status,
  data->>'status' as data_status,
  data->>'is_pranimi_incomplete_draft' as is_pranimi_incomplete_draft,
  pieces,
  m2_total,
  price_total,
  updated_at
from public.orders
where code::text = 'PASTE_CODE_HERE'
  and lower(coalesce(client_name, data->>'client_name', data->'client'->>'name', '')) like lower('%PASTE_NAME_HERE%')
order by updated_at desc;

-- 3) Confirm stale Storage objects can exist but are not DB drafts.
select count(*) as stale_storage_objects_still_existing
from storage.objects
where bucket_id = 'tepiha-photos'
  and name like 'drafts/%.json';
