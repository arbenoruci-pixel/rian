import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (file) => fs.readFileSync(file, 'utf8');

const page = read('app/dispatch/page.jsx');
const api = read('api/transport/order.js');
const server = read('lib/transport/dispatchOrderServer.js');
const transportDb = read('lib/transport/transportDb.js');
const migration = read('supabase/migrations/20260902094308_dispatch_existing_client_guard_v1.sql');
const epoch = read('lib/appEpoch.js');

assert.match(api, /action === 'PHONE_CHECK'/, 'approved-device API must expose the phone inspection action');
assert.match(api, /inspectDispatchTransportPhoneServer/, 'phone inspection must stay server-side');
assert.match(server, /inspect_dispatch_transport_phone/, 'server must call the service-only inspection RPC');
assert.match(server, /DISPATCH_ACTIVE_ORDER_EXISTS/, 'server must recognize the DB duplicate guard');
assert.match(server, /deduplicatedActive: true/, 'a blocked concurrent request must return the existing active order');

assert.match(transportDb, /inspectDispatchTransportPhoneViaApi/, 'browser must use the approved-device phone check');
assert.match(transportDb, /assertDeduplicatedActiveDispatchOrder/, 'browser must verify a deduplicated active order');
assert.match(page, /existingClientDecisionKey/, 'existing client selection must bind phone, client and permanent T-code');
assert.match(page, /existingClientConfirmed/, 'send must require an explicit existing-client decision');
assert.match(page, /inspectDispatchTransportPhoneViaApi\(cleanPhone/, 'send must repeat the authoritative lookup immediately before create');
assert.match(page, /PËRDOR KODIN/, 'Dispatch must present the existing permanent code');
assert.doesNotMatch(page, /JO, VAZHDO PA LIDHJE/, 'Dispatch must not offer an identity-bypass action');

assert.match(migration, /create or replace function public\.inspect_dispatch_transport_phone/, 'inspection RPC migration missing');
assert.match(migration, /revoke all on function public\.inspect_dispatch_transport_phone\(text\) from public,anon,authenticated/, 'inspection RPC must not be callable by browsers');
assert.match(migration, /grant execute on function public\.inspect_dispatch_transport_phone\(text\) to service_role/, 'inspection RPC must remain available to the approved-device API');
assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('transport-phone:'\|\|v_phone_key,0\)\)/, 'duplicate guard must share the canonical phone lock');
assert.match(migration, /message='DISPATCH_ACTIVE_ORDER_EXISTS'/, 'duplicate guard must expose one stable error code');
assert.match(migration, /before insert on public\.transport_orders/, 'duplicate guard must run before the order is inserted');
assert.match(migration, /backup_dispatch_t1233_duplicate_cleanup_20260902_v1/, 'T1233 cleanup needs a forensic backup');
assert.match(migration, /status='cancelled'/, 'T1233 duplicates must be soft-cancelled');
assert.match(migration, /DUPLIKATË NGA DISPATCH TIMEOUT\/RETRY/, 'T1233 cleanup needs an audit reason');
assert.doesNotMatch(migration, /delete\s+from\s+public\.transport_orders/i, 'T1233 history must never be deleted');

for (const id of [
  'af25205f-d76e-4510-b71a-3dedbe4889b4',
  '1d987222-92ab-4121-ac49-f4d93b87e7f8',
  '9889fb01-1a6b-4aed-9416-958b4a55b65f',
]) {
  assert.ok(migration.includes(id), `T1233 cleanup precondition lost ${id}`);
}

assert.match(epoch, /DISPATCH-EXISTING-CLIENT-GUARD-V1/, 'app data epoch must invalidate stale Dispatch clients');
assert.match(epoch, /dispatch-existing-client-guard-v1/, 'runtime version must identify this release');

console.log('PASS verify-dispatch-existing-client-guard-v1');
