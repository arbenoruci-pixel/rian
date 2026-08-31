import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const recoveryPath = resolve(
  root,
  'supabase/migrations/20260831090500_transport_blerim_measurement_recovery_v1.sql',
);
const releasePath = resolve(
  root,
  'supabase/migrations/20260831091000_transport_stranded_code_release_v4.sql',
);

const recovery = readFileSync(recoveryPath, 'utf8');
const release = readFileSync(releasePath, 'utf8');
const lowerRecovery = recovery.toLowerCase();
const lowerRelease = release.toLowerCase();

const targetOrders = new Map([
  ['T1231', '138dd736-47d0-47c9-a79c-4c58ba67b0be'],
  ['T1267', '08d1610a-fc38-48e6-9cd7-498bd0363f3f'],
  ['T1279', 'a177d457-a42b-421d-8464-e8c454a4c725'],
  ['T1299', 'cf51230b-69aa-4618-a7ae-d85d646e102a'],
]);

for (const [code, orderId] of targetOrders) {
  assert.ok(recovery.includes(`'${code}'`), `${code} missing from recovery migration`);
  assert.ok(recovery.includes(`'${orderId}'::uuid`), `${code} exact order UUID missing`);
  assert.ok(release.includes(`'${code}'`), `${code} missing from protected release set`);
  assert.ok(release.includes(`'${orderId}'::uuid`), `${code} protected order UUID missing`);
}

assert.match(recovery, /array\['3\.7','3\.7','3\.7','3\.7'\]::text\[\]/);
assert.match(recovery, /array\['5\.8','5\.8','3\.7','2\.0','1\.0'\]::text\[\]/);
assert.match(recovery, /array\['3\.7','2\.0','1\.0','1\.2','1\.2'\]::text\[\]/);
assert.match(recovery, /array\['3\.7','4\.0'\]::text\[\]/);
assert.match(recovery, /if v_expected_count <> 4 then/i);
assert.ok(
  lowerRecovery.indexOf("hashtextextended('transport-code-allocator-v3', 0)")
    < lowerRecovery.indexOf('lock table'),
  'recovery must take the canonical allocator advisory before table locks',
);
assert.ok(
  lowerRecovery.indexOf('public.transport_code_pool')
    < lowerRecovery.indexOf('lock table public.transport_orders in access exclusive mode'),
  'recovery must follow allocator pool-before-order lock ordering',
);
assert.match(recovery, /o\.data->'pickup_plan'->'items' is distinct from '\[\]'::jsonb/i);
assert.match(recovery, /o\.data->'pickup_plan'->'pieces' is distinct from '0'::jsonb/i);
assert.match(recovery, /o\.data->'pickup_plan'->'source_text' is distinct from '""'::jsonb/i);
assert.match(recovery, /o\.data->'planned_tepiha' is distinct from '\[\]'::jsonb/i);
assert.match(recovery, /select count\(\*\)[\s\S]{0,100}from public\.transport_orders o[\s\S]{0,100}where o\.code_n = e\.code_n/i);
assert.match(recovery, /nullif\(btrim\(l\.draft_session_id\), ''\) = coalesce\(/i);
assert.match(recovery, /nullif\(btrim\(l\.order_id\), ''\) = o\.id::text/i);
assert.match(recovery, /coalesce\(o\.data, '\{\}'::jsonb\) \|\| jsonb_build_object\(/i);
assert.match(recovery, /'pickup_plan', coalesce\(o\.data->'pickup_plan', '\{\}'::jsonb\)\s+\|\| jsonb_build_object\(/i);
assert.match(recovery, /set status = 'pickup'/i);
assert.match(recovery, /'rate', 1\.8/i);
assert.match(recovery, /'pieces', p\.pieces/i);
assert.match(recovery, /'totals', jsonb_build_object\(/i);
assert.match(recovery, /'arkaRecordedPaid', 0/i);
assert.match(recovery, /'staza', '\[\]'::jsonb/i);
assert.match(recovery, /'shkallore', jsonb_build_object\('qty', 0, 'per', 0\.3\)/i);
assert.match(recovery, /to_jsonb\(o\) - array\['status','data','updated_at'\]::text\[\]/i);
assert.match(recovery, /'assigned_driver_id'.*e0f09793-3539-4242-81fe-c725baa615bc/is);
assert.match(recovery, /b\.row_before = to_jsonb\(o\)/i);
assert.match(recovery, /b\.row_before = to_jsonb\(l\)/i);
assert.match(recovery, /disable trigger trg_capture_transport_order_location/i);
assert.match(recovery, /enable trigger trg_capture_transport_order_location/i);
assert.match(recovery, /enable row level security/i);
assert.match(recovery, /revoke all on table public\.backup_transport_blerim_measurement_recovery_20260831_v1\s+from public, anon, authenticated/is);
assert.ok(!/delete\s+from\s+public\.(?:transport_orders|transport_clients)/i.test(recovery));
assert.ok(!/insert\s+into\s+public\.(?:transport_orders|transport_clients)/i.test(recovery));

const expectedReleaseCodes = [
  'T989',
  'T1159', 'T1160',
  'T1162', 'T1163', 'T1164', 'T1165', 'T1166', 'T1167', 'T1168', 'T1169', 'T1170',
  'T1172', 'T1173', 'T1174', 'T1175', 'T1176',
  'T1199', 'T1200', 'T1201',
  'T1204', 'T1205',
  'T1209', 'T1210', 'T1211',
  'T1228',
];

const expectedBlock = release.slice(
  release.indexOf('insert into transport_stranded_code_release_expected_v4'),
  release.indexOf('create temporary table transport_stranded_code_protected_v4'),
);
const actualReleaseCodes = [...expectedBlock.matchAll(/'T\d+'/g)].map((hit) => hit[0].slice(1, -1));
assert.deepEqual(actualReleaseCodes, expectedReleaseCodes, 'stranded release set must remain exact and ordered');
assert.match(release, /if v_expected_count <> 26 then/i);
assert.match(release, /transport_tcode_has_lifecycle_reference_v2\(e\.code\)/i);
assert.equal(
  [...release.matchAll(/public\.transport_tcode_has_lifecycle_reference_v2\(e\.code\)/gi)].length,
  1,
  'expensive lifecycle helper must be materialized in exactly one locked pass',
);
assert.match(release, /create temporary table transport_stranded_code_reference_snapshot_v4/i);
assert.match(release, /from public\.offline_code_leases l[\s\S]{0,220}upper\(btrim\(l\.code\)\) = e\.code/i);
const releaseUpdate = release.slice(
  release.indexOf('update public.transport_code_pool p'),
  release.indexOf('get diagnostics v_updated = row_count'),
);
assert.match(releaseUpdate, /join transport_stranded_code_reference_snapshot_v4 refs/i);
assert.match(releaseUpdate, /not refs\.has_lifecycle_reference[\s\S]{0,80}not refs\.has_any_lease/i);
assert.match(release, /b\.row_before = to_jsonb\(p\)/i);
assert.match(release, /set status = 'available',\s+owner_id = 'POOL',\s+reserved_at = null/i);
assert.match(release, /if v_updated <> 26 then/i);
assert.match(release, /if v_protected_count <> 4 then/i);
assert.match(release, /lower\(btrim\(p\.status\)\) = 'used'\s+and p\.reserved_at is null/i);
assert.match(release, /upper\(btrim\(coalesce\(o\.client_tcode, ''\)\)\) = protected\.code/i);
assert.match(release, /enable row level security/i);
assert.match(release, /revoke all on table public\.backup_transport_stranded_code_release_20260831_v4\s+from public, anon, authenticated/is);
assert.ok(!/delete\s+from\s+public\.(?:transport_code_pool|transport_orders|transport_clients)/i.test(release));

assert.ok(lowerRecovery.startsWith('begin;') && lowerRecovery.trimEnd().endsWith('commit;'));
assert.ok(lowerRelease.startsWith('begin;') && lowerRelease.trimEnd().endsWith('commit;'));

console.log(
  'PASS transport incident recovery V1: four exact Blerim visits are JSON-merge recovered and 26 exact unreferenced codes are released behind fail-closed backups and pre/postchecks.',
);
