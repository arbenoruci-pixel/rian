import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPranimiCodeAllocatorCore } from '../lib/pranimiCodeAllocator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const checks = [];

function check(condition, message) {
  const ok = Boolean(condition);
  checks.push({ ok, message });
  if (!ok) console.error(`FAIL: ${message}`);
}

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

function memoryStorage() {
  const assigned = new Map();
  const proofs = new Map();
  return {
    assigned,
    proofs,
    api: {
      getAssigned: (oid) => assigned.get(oid) ?? null,
      setAssigned: (oid, code) => assigned.set(oid, code),
      clearAssigned: (oid) => assigned.delete(oid),
      getProof: (oid) => proofs.get(oid) ?? null,
      setProof: (oid, proof) => proofs.set(oid, proof),
      clearProof: (oid) => proofs.delete(oid),
    },
  };
}

const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

{
  const storage = memoryStorage();
  let onlineReservations = 0;
  let offlineReservations = 0;
  let offlineReleases = 0;
  const allocator = createPranimiCodeAllocatorCore({
    storage: storage.api,
    db: {
      isOnline: async () => false,
      reserveOne: async () => {
        onlineReservations += 1;
        throw new Error('ONLINE_ALLOCATOR_MUST_NOT_RUN_OFFLINE');
      },
      reserveOffline: async ({ pin, oid }) => {
        offlineReservations += 1;
        return {
          code: 901,
          status: 'reserved',
          reserved_by: pin,
          draft_session_id: oid,
          lease_expires_at: future,
          lease_token: '00000000-0000-4000-8000-000000000901',
          device_id: 'device-offline-test-v1',
          verified: true,
          source: 'OFFLINE_BANK',
        };
      },
      releaseOffline: async () => {
        offlineReleases += 1;
        return { ok: true };
      },
    },
  });

  const result = await allocator.getOrAllocateForDraft({ pin: '1968', oid: 'draft-offline-1' });
  check(result.code === 901, 'Offline Base allocation returns the exclusive bank code');
  check(result.source === 'OFFLINE_BANK', 'Offline Base allocation is explicitly marked OFFLINE_BANK');
  check(offlineReservations === 1, 'Offline allocator consumes exactly one bank slot');
  check(onlineReservations === 0, 'Normal online allocator is never called while offline');

  const verified = await allocator.verifyAssignedCode({ pin: '1968', oid: 'draft-offline-1', code: 901 });
  check(verified.displayable === true && verified.offline === true, 'Offline bank proof remains displayable without network');
  check(verified.proof?.offline_bank === true, 'Offline proof carries the bank lifecycle marker');

  const released = await allocator.releaseForDraft({ pin: '1968', oid: 'draft-offline-1', code: 901 });
  check(released.ok === true && released.offlineBank === true, 'Blank offline draft returns its code to the local bank');
  check(offlineReleases === 1, 'Offline release path is called once');
  check(storage.assigned.size === 0 && storage.proofs.size === 0, 'Offline release clears the local draft binding');
}

{
  const storage = memoryStorage();
  let onlineReservations = 0;
  let offlineReservations = 0;
  const allocator = createPranimiCodeAllocatorCore({
    storage: storage.api,
    db: {
      isOnline: async () => true,
      reserveOne: async ({ pin, oid }) => {
        onlineReservations += 1;
        return {
          code: 777,
          status: 'reserved',
          reserved_by: pin,
          draft_session_id: oid,
          lease_expires_at: future,
          verified: true,
          source: 'GET_OR_ASSIGN',
        };
      },
      reserveOffline: async () => {
        offlineReservations += 1;
        throw new Error('OFFLINE_BANK_MUST_NOT_BE_USED_ONLINE');
      },
    },
  });

  const result = await allocator.getOrAllocateForDraft({ pin: '1968', oid: 'draft-online-1' });
  check(result.code === 777, 'Online Base behavior still uses the normal DB allocator');
  check(onlineReservations === 1, 'Online allocator is called exactly once online');
  check(offlineReservations === 0, 'Offline bank is never consumed for a new online order');
}

const bankSource = await read('lib/offlineCodeBank.js');
const baseAllocatorSource = await read('lib/pranimiCodeAllocator.js');
const transportCodesSource = await read('lib/transportCodes.js');
const runtimeSource = await read('lib/offlineRuntime.js');
const sessionSource = await read('lib/sessionStore.js');
const mainSource = await read('src/main.jsx');
const migrationBank = await read('supabase/migrations/20260712020000_offline_code_bank_v1.sql');
const migrationTriggers = await read('supabase/migrations/20260712020100_offline_code_triggers_v1.sql');
const migrationOwnerCap = await read('supabase/migrations/20260712020200_offline_code_owner_cap_v1.sql');

check(/OFFLINE_CODE_BANK_TARGET\s*=\s*10/.test(bankSource), 'Offline code bank target is fixed at 10');
check(bankSource.includes('token omitted by the server has been consumed'), 'Server-active lease set is authoritative after sync');
check(!bankSource.includes('LOCAL_ASSIGNED_SERVER_OMITTED'), 'Consumed leases are not retained forever in the local bank');
check(bankSource.includes('session?.transport_pin'), 'Transport bank identity prefers the real transport PIN');
check(bankSource.includes('cleanStaleAssignments'), 'Stale draft-to-lease mappings are removed after server reconciliation');

check(baseAllocatorSource.includes("source: 'OFFLINE_BANK'"), 'Base allocator supports an explicit offline-bank source');
check(baseAllocatorSource.includes('reserveOffline'), 'Base allocator has a dedicated offline reservation dependency');
check(baseAllocatorSource.includes('if (!(await onlineNow()))'), 'Base allocator switches automatically on network absence');

check(/DEFAULT_POOL_SIZE\s*=\s*1/.test(transportCodesSource), 'Transport online mirror remains one normal online code');
check(transportCodesSource.includes('navigator.onLine === false'), 'Transport switches to the bank only when offline');
check(transportCodesSource.includes('takeOfflineTransportCode'), 'Transport consumes a server-leased offline T-code');
check(transportCodesSource.includes('popVerifiedOnlineCode'), 'Existing online smallest-safe-code flow remains present');
check(transportCodesSource.includes('session?.transport_pin'), 'Transport online and offline allocators use the same real owner PIN');

check(runtimeSource.includes('BASE_ACTIVE_STATUSES'), 'Offline snapshot caches Base workflow states');
check(runtimeSource.includes('TRANSPORT_ACTIVE_STATUSES'), 'Offline snapshot caches Transport workflow states');
check(runtimeSource.includes("from('clients')"), 'Offline snapshot caches Base clients for search');
check(runtimeSource.includes("from('transport_clients')"), 'Offline snapshot caches Transport clients for search');
check(runtimeSource.includes("mode: snapshot?.snapshot_at ? 'offline-ready' : 'offline-limited'"), 'Automatic runtime distinguishes ready and limited offline modes');
check(runtimeSource.includes('isDirtyLocalRow'), 'Remote snapshots never overwrite dirty local work');
check(runtimeSource.includes("window.addEventListener('offline'"), 'Browser offline event activates offline mode');
check(runtimeSource.includes("window.addEventListener('online'"), 'Browser online event triggers reconnect and refresh');
check(mainSource.includes('installOfflineRuntime();'), 'Offline runtime is installed globally at app startup');
check(sessionSource.includes("'tepiha:session-changed'"), 'Session changes emit a runtime refresh signal');
check(mainSource.includes('installOfflineSessionRefreshBridge();'), 'Login immediately refreshes snapshots and offline code banks');

check(migrationBank.includes('create table if not exists public.offline_code_leases'), 'Migration creates the server-side lease table');
check(migrationBank.includes('alter table public.offline_code_leases enable row level security'), 'Lease table has RLS enabled');
check(migrationBank.includes('revoke all on table public.offline_code_leases'), 'Lease tokens are not directly readable by app roles');
check(migrationBank.includes('least(greatest(coalesce(p_target,10),1),10)'), 'Server enforces a maximum request size of 10 offline codes');
check(migrationBank.includes('for update skip locked'), 'Server allocator uses row locks to prevent duplicate leases');
check(migrationBank.includes('reserve_base_offline_codes'), 'Migration includes Base offline reservation RPC');
check(migrationBank.includes('reserve_transport_offline_codes'), 'Migration includes Transport offline reservation RPC');

check(migrationOwnerCap.includes("'offline-bank:base:'||clean_pin,0"), 'Base reservation is serialized at the user level');
check(migrationOwnerCap.includes("'offline-bank:transport:'||clean_owner,0"), 'Transport reservation is serialized at the user level');
check(migrationOwnerCap.includes('ten exclusive codes per user'), 'Corrective migration documents the per-user cap');
check(!migrationOwnerCap.includes("'offline-bank:base:'||clean_pin||':'||clean_device"), 'Base cap cannot be multiplied by changing device ID');
check(!migrationOwnerCap.includes("'offline-bank:transport:'||clean_owner||':'||clean_device"), 'Transport cap cannot be multiplied by changing device ID');

check(migrationTriggers.includes('offline_base_code_lease_before_write'), 'Base DB trigger binds an offline lease before upsert');
check(migrationTriggers.includes('mark_base_code_used_after_verify'), 'Base DB trigger finalizes only after the exact order exists');
check(migrationTriggers.includes('offline_transport_code_lease_before_write'), 'Transport DB trigger binds an offline lease');
check(migrationTriggers.includes('offline_transport_code_lease_after_write'), 'Transport DB trigger consumes or releases the lease after canonicalization');
check(migrationTriggers.includes("v_data := v_data - 'offline_code_lease'"), 'DB triggers strip the secret lease token before storage');

const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.error(`\n${failed.length} offline-first check(s) failed.`);
  process.exit(1);
}

console.log(`PASS: ${checks.length} offline-first checks passed.`);
