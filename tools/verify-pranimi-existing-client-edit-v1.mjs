import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBaseClientProfileIdempotencyKey,
  updateBaseClientProfile,
} from '../lib/clientProfileClient.js';
import { updateBaseClientProfileServer } from '../lib/clientProfileServer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const page = read('app/pranimi/page.jsx');
const client = read('lib/clientProfileClient.js');
const server = read('lib/clientProfileServer.js');
const api = read('api/client-profile.js');
const expressServer = read('server/index.mjs');
const pkg = JSON.parse(read('package.json'));

const migrationNames = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter((name) => name.endsWith('_update_base_client_profile_v1.sql'));
assert.equal(migrationNames.length, 1, 'exactly one update_base_client_profile_v1 migration must exist');
const migration = read(`supabase/migrations/${migrationNames[0]}`);
const migrationFlat = migration.replace(/\s+/g, ' ').trim();

const passed = [];
function check(condition, label) {
  assert.ok(condition, label);
  passed.push(label);
}
function has(source, fragment, label) {
  check(source.includes(fragment), label);
}
function count(source, pattern) {
  return Array.from(source.matchAll(pattern)).length;
}

/* ---------------- Pranimi edit state, exact identity and rollback ---------------- */
const openWizard = page.slice(page.indexOf('function openWizard()'), page.indexOf('function closeWizard()'));
const closeWizard = page.slice(page.indexOf('function closeWizard()'), page.indexOf('function clientEditErrorMessage'));
const saveWizard = page.slice(page.indexOf('async function saveClientFromWizard()'), page.indexOf('function wizNext()'));

has(page, "import { updateBaseClientProfile } from '@/lib/clientProfileClient';", 'Pranimi uses the authenticated client-profile update client');
has(page, 'const clientEditSnapshotRef = useRef(null);', 'existing-client edits use an explicit rollback snapshot');
for (const field of ['selectedClient: { ...selectedClient }', "name: String(name || '')", "phone: String(phone || '')", 'noPhone: !!noPhone', "clientPhotoUrl: String(clientPhotoUrl || '')"]) {
  has(openWizard, field, `edit snapshot captures ${field.split(':')[0]}`);
}
for (const restore of [
  'setSelectedClient({ ...snapshot.selectedClient })',
  'setName(snapshot.name)',
  'setPhone(snapshot.phone)',
  'setNoPhone(snapshot.noPhone)',
  'setClientPhotoUrl(snapshot.clientPhotoUrl)',
  'clientEditSnapshotRef.current = null',
]) {
  has(closeWizard, restore, `cancel restores ${restore}`);
}
has(closeWizard, 'if (clientEditUi.saving || photoUploading) return;', 'cancel cannot race an atomic save or photo upload');
has(saveWizard, 'const target = snapshot?.selectedClient;', 'save authority comes from the captured selected client');
has(saveWizard, "const expectedUpdatedAt = String(target?.updated_at || target?.updatedAt || '').trim();", 'save requires the exact optimistic-lock timestamp');
has(saveWizard, 'const result = await updateBaseClientProfile({', 'save uses the dedicated update endpoint');
check(/clientId:\s*target\.id,\s*expectedCode:\s*target\.code,\s*expectedUpdatedAt,/s.test(saveWizard), 'save sends exact UUID, immutable code and stale token together');
check(/String\(client\.id\) !== String\(target\.id\)[\s\S]*String\(client\.code\) !== String\(target\.code\)/.test(saveWizard), 'save rejects an unverified response identity/code');
for (const effect of [
  'setSelectedClient(nextSelected)',
  'setClientMatchDecision((prev)',
  'newOrderUrlClientRef.current = {',
  'updateLocalClientIndexAfterEdit(client)',
  'setName(nextSelected.name)',
  'setPhone(savedPhone)',
]) {
  has(saveWizard, effect, `successful save refreshes ${effect}`);
}
check(count(page, /selectedClient\?\.id && !clientEditSnapshotRef\.current/g) >= 2, 'typing name/phone in edit mode keeps the canonical selected-client binding');
has(page, "if (!clientEditSnapshotRef.current) {\n                          clearSelectedClientBinding('selected_client_switched_to_no_phone_restore_temp_code');", 'no-phone editing also preserves the selected-client binding');
has(page, "if (code.includes('STALE'))", 'stale edits have an explicit user-facing failure state');
has(page, 'role="alert" className="client-edit-error"', 'save failures remain visible without closing the editor');
has(page, 'disabled={clientEditUi.saving || photoUploading}', 'duplicate save taps and in-flight photo changes are blocked');
has(page, 'disabled={clientEditUi.saving || photoUploading}\n                aria-label="Mbylle ndryshimin e klientit"', 'modal X is labeled and blocked while work is in flight');
has(page, 'disabled={clientEditUi.saving || photoUploading || editingCanonicalRealPhone}', 'real identity phones cannot be misleadingly erased');
has(page, "if (showWizard && clientEditSnapshotRef.current?.selectedClient?.id)", 'duplicate matching is suppressed during canonical client edits');
check(count(page, /isValidClientPhoneDigits\((?:nextPhonePrefill|candPhone|nextPhone)\)/g) >= 3, 'all existing-client entry paths reject placeholder digits as a real phone');

/* ----------------------------- Pro selected-client card -------------------------- */
has(page, 'data-client-card-version="pro-v1"', 'selected-client card has a stable professional UI marker');
has(page, "selectedClient?.id ? 'KLIENTI I ZGJEDHUR' : 'KLIENTI I RI'", 'card distinguishes a canonical existing client');
has(page, 'client-card-action client-card-action--edit', 'card exposes a labeled edit action');
has(page, 'client-card-action client-card-action--remove', 'card exposes a labeled remove action');
has(page, '<span>NDRYSHO</span>', 'edit action is text-labeled');
has(page, '<span>HIQE</span>', 'remove action is text-labeled');
check(/\.client-card-action\s*\{[\s\S]*?min-height:\s*48px;/.test(page), 'primary card actions meet a 48px touch target');
check(/@media \(max-width:390px\)[\s\S]*?\.client-card-action\s*\{[^}]*min-height:\s*46px;/.test(page), 'small-screen card actions remain above 44px');
check(count(page, /overflow-wrap:anywhere;/g) >= 2, 'long client names and phone values wrap inside the card');
check(/\.client-selected-card--active\s+\.client-selected-name\s*\{[^}]*max-width:100%;[^}]*overflow-wrap:anywhere;/s.test(page), 'long names cannot overflow the professional card');
check(/\.client-selected-card--active\s*\{[^}]*width:100%;[^}]*overflow:hidden;/s.test(page), 'professional card clips decorative overflow on narrow screens');

/* ------------------------------- Chips and haptics ------------------------------- */
has(page, "const iosBridge = typeof window !== 'undefined' ? window?.webkit?.messageHandlers?.haptics : null;", 'haptic helper supports the native iOS bridge when present');
has(page, "const nativeHaptics = typeof window !== 'undefined' ? window?.Capacitor?.Plugins?.Haptics : null;", 'haptic helper supports a Capacitor bridge when present');
has(page, "typeof navigator.vibrate === 'function'", 'haptic helper retains the web vibration fallback');
check(/function applyChip\([^)]*\)\s*\{\s*vibrateTap\(30\);/.test(page), 'an accepted dimension chip tap triggers haptic feedback exactly in applyChip');
check(count(page, /onPointerCancel=\{\(\) => \{ chipTapRef\.current = \{ \.\.\.\(chipTapRef\.current \|\| \{\}\), moved: true \}; \}\}/g) === 2, 'both Tepih and Staza chips cancel scroll/pointer gestures');
check(count(page, /aria-pressed=\{isActive\}/g) === 0, 'append-only chips do not claim toggle semantics');
check(count(page, /aria-label=\{`Shto (?:tepih|stazë)/g) === 2, 'both chip groups have spoken labels');
check(count(page, /onClick=\{\(e\) => guardedApplyChip\('(?:tepiha|staza)', v, e\)\}/g) === 2, 'native, keyboard and assistive-tech clicks share one chip activation path');
has(page, 'const synthesizedClick = Number(ev?.detail || 0) === 0;', 'assistive-tech and keyboard synthesized chip clicks are accepted');
check(count(page, /onPointerUp=\{\(e\) => guardedApplyChip/g) === 0, 'pointer and click handlers cannot double-add a chip value');
check(count(page, /touch-action:manipulation;/g) >= 2, 'card actions and chips use mobile tap semantics');
has(page, '.chip-bump { animation: chipBump 140ms ease-in-out; }', 'unsupported haptic devices retain visible tap feedback');
check(count(page, /className="chip-haptic-shell"/g) === 2, 'Tepih and Staza each use one delegated haptic shell');
check(count(page, /type="checkbox"\s+switch=""\s+className="chip-ios-haptic-switch"\s+tabIndex=\{-1\}\s+aria-hidden="true"/g) === 2, 'both chip groups expose a directly tapped native iOS switch overlay');
check(count(page, /<button[\s\S]*?<\/button>\s*<input\s+type="checkbox"\s+switch=""\s+className="chip-ios-haptic-switch"/g) >= 2, 'native haptic overlays remain siblings of accessible buttons instead of invalid nested controls');
const hapticSwitchTags = Array.from(page.matchAll(/<input\s+type="checkbox"\s+switch=""\s+className="chip-ios-haptic-switch"[\s\S]*?\/>/g), (match) => match[0]);
check(hapticSwitchTags.length === 2 && hapticSwitchTags.every((tag) => !/on(?:Click|Change|PointerUp)=/.test(tag)), 'native switch overlays own no second activation handler');
check(/\.chip-ios-haptic-switch\{[^}]*position:absolute;[^}]*inset:0;[^}]*width:100%;[^}]*height:100%;[^}]*opacity:0;[^}]*pointer-events:auto;[^}]*-webkit-appearance:auto;[^}]*appearance:auto;/s.test(page), 'the real native switch receives the full visible chip tap target with its native appearance intact');
check(!/\.chip-ios-haptic-switch\{[^}]*(?:display:none|visibility:hidden|appearance:none|-webkit-appearance:none)/s.test(page), 'the native iOS switch is not removed or stripped of its haptic control behavior');

const guardedChipSource = page
  .slice(page.indexOf('function guardedApplyChip('), page.indexOf('const [showWizard'))
  .trim();
check(guardedChipSource.startsWith('function guardedApplyChip('), 'chip activation guard can be executed by the verifier');
let chipApplyCount = 0;
let chipTapAccepted = true;
const guardedChip = Function(
  'isRealTap',
  'applyChip',
  'chipTapRef',
  `${guardedChipSource}\nreturn guardedApplyChip;`,
)(() => chipTapAccepted, () => { chipApplyCount += 1; }, { current: {} });
guardedChip('tepiha', 1.5, { detail: 1 });
check(chipApplyCount === 1, 'one accepted native switch click adds exactly one dimension');
chipTapAccepted = false;
guardedChip('tepiha', 1.5, { detail: 1 });
check(chipApplyCount === 1, 'a moved/scroll pointer gesture adds no dimension');
guardedChip('tepiha', 1.5, { detail: 0 });
check(chipApplyCount === 2, 'one keyboard or assistive-tech click adds exactly one dimension');

/* ----------------------- Browser client retry and cache behavior ----------------- */
has(client, "const UPDATE_ENDPOINT = '/api/client-profile';", 'browser updates share the protected profile endpoint');
check(/fetch\(UPDATE_ENDPOINT,[\s\S]*?credentials:\s*'same-origin'[\s\S]*?cache:\s*'no-store'/.test(client), 'browser update is same-origin and never cached');
has(client, "action: 'UPDATE_BASE_CLIENT'", 'browser update declares the narrow server action');
has(client, 'const attempts = retryAmbiguous === false ? 1 : 2;', 'only ambiguous requests receive one lifecycle-safe retry');
has(client, "error?.requestAmbiguous === true", 'definite 4xx failures are never retried');
has(client, "window.dispatchEvent(new CustomEvent('tepiha:base-client-profile:updated'", 'successful updates notify other live profile consumers');
for (const cacheKey of ['CLIENT_PROFILE_CACHE_PREFIX', 'CLIENT_INDEX_CACHE_KEY', 'BASE_MASTER_CACHE_KEY']) {
  has(client, cacheKey, `successful save invalidates ${cacheKey}`);
}

const idemInput = {
  clientId: '11111111-1111-4111-8111-111111111111',
  expectedCode: '782',
  expectedUpdatedAt: '2026-08-30T08:00:00.123456+00:00',
  name: 'Afrim  Osmani',
  phone: '+383 (44) 150-215',
  photoUrl: 'https://example.test/client.jpg',
};
const idemA = buildBaseClientProfileIdempotencyKey(idemInput);
const idemB = buildBaseClientProfileIdempotencyKey({ ...idemInput, name: 'Afrim Osmani', phone: '+38344150215' });
const idemDifferent = buildBaseClientProfileIdempotencyKey({ ...idemInput, name: 'Afrim Berisha' });
check(idemA === idemB && idemA !== idemDifferent && idemA.length <= 240, 'idempotency keys are deterministic, normalized and payload-specific');

const originalFetch = globalThis.fetch;
try {
  const fetchBodies = [];
  let fetchAttempt = 0;
  globalThis.fetch = async (_url, options = {}) => {
    fetchBodies.push(JSON.parse(String(options.body || '{}')));
    fetchAttempt += 1;
    if (fetchAttempt === 1) throw new TypeError('fetch failed');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        client: {
          id: idemInput.clientId,
          code: '782',
          name: 'Afrim Osmani',
          phone: '+38344150215',
          photoUrl: idemInput.photoUrl,
          updatedAt: '2026-08-30T08:00:01.654321+00:00',
        },
      }),
    };
  };
  const retryResult = await updateBaseClientProfile(idemInput, { timeoutMs: 1000 });
  check(retryResult.client.id === idemInput.clientId && fetchBodies.length === 2, 'ambiguous browser failure retries once and verifies the returned identity');
  check(JSON.stringify(fetchBodies[0]) === JSON.stringify(fetchBodies[1]), 'ambiguous retry reuses the exact request and idempotency key');

  let conflictCalls = 0;
  globalThis.fetch = async () => {
    conflictCalls += 1;
    return { ok: false, status: 409, json: async () => ({ error: 'BASE_CLIENT_PROFILE_STALE' }) };
  };
  await assert.rejects(
    () => updateBaseClientProfile(idemInput, { timeoutMs: 1000 }),
    (error) => error?.code === 'BASE_CLIENT_PROFILE_STALE' && error?.requestAmbiguous === false,
    'stale response must be definite and non-retryable',
  );
  check(conflictCalls === 1, 'stale/version conflict is not retried');
} finally {
  globalThis.fetch = originalFetch;
}

/* --------------------- Authenticated server and exact RPC contract ---------------- */
has(api, "readCookie(req, 'tepiha_device_id')", 'profile update requires the approved-device cookie');
has(api, 'authenticateClientProfileViewer(supabase, deviceId)', 'profile update authenticates the current approved user');
has(api, 'createAdminClientOrThrow()', 'only the server constructs the service-role Supabase client');
has(api, "action === 'UPDATE_BASE_CLIENT'", 'API dispatches only the explicit update action');
has(api, 'requestOriginAllowed(req)', 'update endpoint is protected by same-origin validation');
has(api, "'private, no-store, max-age=0, must-revalidate'", 'update responses cannot enter a shared cache');
has(expressServer, "app.post('/api/client-profile', clientProfileHandler)", 'local production-compatible server exposes the same protected route');

has(server, "supabase.rpc('update_base_client_profile_v1'", 'server performs the update through the atomic RPC');
for (const rpcField of [
  'p_client_id: clientId',
  'p_expected_code: Number(expectedCode)',
  'p_expected_updated_at: expectedUpdatedAt',
  'p_new_name: requestedName',
  'p_new_canonical_phone: requestedPhone',
  'p_actor_user_id: actorUserId',
  'p_idempotency_key: idempotencyKey',
]) {
  has(server, rpcField, `server RPC includes ${rpcField.split(':')[0]}`);
}
has(server, 'if (!supabase || !authUser?.id)', 'server rejects unauthenticated update calls');
has(server, "action !== UPDATE_BASE_CLIENT_ACTION", 'server rejects action confusion');
has(server, "fail('BASE_CLIENT_EXPECTED_UPDATED_AT_REQUIRED'", 'server requires a stale/version token');
check(/id !== clientId \|\| !code \|\| code !== expectedCode \|\| !updatedAt/.test(server), 'server verifies returned UUID, code and new version');
has(server, "new ClientProfileError('BASE_CLIENT_PROFILE_STALE', 409)", 'RPC stale errors map to HTTP 409');
has(server, "new ClientProfileError('BASE_CLIENT_PHONE_CONFLICT', 409)", 'RPC identity/link conflicts map to HTTP 409');

const clientId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const expectedUpdatedAt = '2026-08-30T08:00:00.123456+00:00';
const nextUpdatedAt = '2026-08-30T08:00:01.654321+00:00';
const serverBody = {
  action: 'UPDATE_BASE_CLIENT',
  clientId,
  expectedCode: '782',
  expectedUpdatedAt,
  newName: 'Afrim Osmani',
  newCanonicalPhone: '+38344150215',
  photoUrl: 'https://example.test/client.jpg',
  idempotencyKey: 'BASE_CLIENT_PROFILE_UPDATE_V1:test-contract',
};
let rpcContract = null;
const fakeSupabase = {
  rpc: async (name, args) => {
    rpcContract = { name, args };
    return {
      data: {
        ok: true,
        idempotency_key: serverBody.idempotencyKey,
        client: {
          id: clientId,
          code: '782',
          full_name: 'Afrim Osmani',
          phone: '+38344150215',
          photo_url: serverBody.photoUrl,
          updated_at: nextUpdatedAt,
        },
      },
      error: null,
    };
  },
};
const serverResult = await updateBaseClientProfileServer(serverBody, {
  supabase: fakeSupabase,
  authUser: { id: actorId },
});
check(rpcContract?.name === 'update_base_client_profile_v1', 'server calls only the expected RPC');
check(rpcContract?.args?.p_client_id === clientId && rpcContract?.args?.p_expected_code === 782, 'server forwards exact UUID and numeric immutable code');
check(rpcContract?.args?.p_expected_updated_at === expectedUpdatedAt, 'server preserves PostgreSQL timestamp precision for stale protection');
check(rpcContract?.args?.p_actor_user_id === actorId && rpcContract?.args?.p_idempotency_key === serverBody.idempotencyKey, 'server binds audit actor and idempotency identity');
check(serverResult?.client?.id === clientId && serverResult?.client?.code === '782' && serverResult?.client?.updatedAt === nextUpdatedAt, 'server returns only a fully verified updated client');

await assert.rejects(
  () => updateBaseClientProfileServer(serverBody, { supabase: fakeSupabase, authUser: null }),
  (error) => error?.code === 'AUTH_REQUIRED' && error?.httpStatus === 401,
  'server must reject missing approved user identity',
);
await assert.rejects(
  () => updateBaseClientProfileServer(serverBody, {
    supabase: { rpc: async () => ({ data: null, error: { message: 'BASE_CLIENT_PROFILE_STALE_UPDATED_AT' } }) },
    authUser: { id: actorId },
  }),
  (error) => error?.code === 'BASE_CLIENT_PROFILE_STALE' && error?.httpStatus === 409,
  'server must map stale RPC failures to a definite conflict',
);
passed.push('dynamic server auth and stale-conflict guards');

/* ---------------------- Migration privilege and atomicity checks ------------------ */
has(migration, 'create table if not exists public.base_client_profile_update_audit', 'migration creates an immutable audit ledger');
has(migration, 'idempotency_key text not null unique', 'audit ledger enforces one committed result per idempotency key');
has(migration, 'alter table public.base_client_profile_update_audit enable row level security;', 'audit ledger has RLS enabled');
check(/revoke all on table public\.base_client_profile_update_audit\s+from public, anon, authenticated, service_role;/i.test(migration), 'audit table starts with no implicit role privileges');
check(/grant select on table public\.base_client_profile_update_audit to service_role;/i.test(migration), 'only service role receives audit read access');
has(migration, 'security definer', 'atomic RPC is SECURITY DEFINER');
has(migration, "set search_path = ''", 'SECURITY DEFINER RPC uses an empty search_path');
check(/revoke all on function public\.update_base_client_profile_v1\([\s\S]*?\) from public, anon, authenticated, service_role;/i.test(migration), 'RPC revokes execute from every ambient API role');
check(/grant execute on function public\.update_base_client_profile_v1\([\s\S]*?\) to service_role;/i.test(migration), 'RPC execution is granted only to service role');
check(!/grant execute on function public\.update_base_client_profile_v1\([\s\S]*?\) to (?:anon|authenticated|public)\s*;/i.test(migration), 'browser roles cannot execute the RPC directly');
has(migration, "pg_catalog.pg_advisory_xact_lock(", 'same-key retries serialize before state inspection');
has(migration, 'where idempotency_key = v_idempotency_key', 'committed retries locate the original audit result');
has(migration, 'v_existing_audit.request_payload is distinct from v_request', 'idempotency-key reuse with a different payload fails closed');
has(migration, "'client', v_existing_audit.after_profile", 'idempotent replay returns the original committed client result');
has(migration, 'where id = p_actor_user_id\n    and is_active is true', 'RPC requires an active audited actor');
check(!/actor_pin|v_actor\.pin/i.test(migration), 'audit attribution never copies a login PIN');
check(/from public\.clients\s+where id = p_client_id\s+for update;/i.test(migration), 'RPC locks the exact canonical client UUID');
has(migration, "raise exception 'BASE_CLIENT_CODE_MISMATCH'", 'immutable client code is an independent identity guard');
has(migration, "raise exception 'BASE_CLIENT_PROFILE_STALE_UPDATED_AT'", 'updated_at is an independent stale-write guard');
const clientUpdateStart = migration.indexOf('update public.clients');
const clientUpdateEnd = migration.indexOf('returning * into v_after', clientUpdateStart);
check(clientUpdateStart >= 0 && clientUpdateEnd > clientUpdateStart, 'migration contains one explicit canonical-client update block');
const clientUpdateBlock = migration.slice(clientUpdateStart, clientUpdateEnd);
check(!/\bcode\s*=/.test(clientUpdateBlock), 'canonical client code is never mutated by the profile update');
check(!/\bphone_digits\s*=/.test(clientUpdateBlock), 'generated phone_digits is derived from phone and never assigned directly');
has(migration, "raise exception 'BASE_CLIENT_CODE_IMMUTABILITY_FAILED'", 'RPC verifies identity/code again after update');
for (const guard of [
  'from public.clients c',
  'from public.client_balances b',
  'from public.transport_clients tc',
  'from public.orders o',
  'from public.transport_orders transport_order',
]) {
  has(migration, guard, `phone reassignment checks ${guard.replace('from public.', '')}`);
}
const idempotencyCheckAt = migration.indexOf('where idempotency_key = v_idempotency_key');
const clientLockAt = migration.indexOf('from public.clients\n  where id = p_client_id');
check(idempotencyCheckAt >= 0 && clientLockAt > idempotencyCheckAt, 'idempotent retry is resolved before stale client state is checked');
const auditInsertAt = migration.indexOf('insert into public.base_client_profile_update_audit');
const returnAt = migration.lastIndexOf("return jsonb_build_object(");
check(auditInsertAt > clientUpdateStart && returnAt > auditInsertAt, 'client update and audit insert commit atomically before success returns');
has(migration, "pg_catalog.set_config('tepiha.client_identity_repair', 'on', true)", 'identity-repair bypass is scoped to the guarded transaction');

/* ---------------------------- Full-build test ownership --------------------------- */
check(pkg.scripts?.['test:pranimi-existing-client-edit-v1'] === 'node tools/verify-pranimi-existing-client-edit-v1.mjs', 'package exposes the targeted verifier');
const buildScript = String(pkg.scripts?.build || '');
const buildToken = 'npm run test:pranimi-existing-client-edit-v1';
check(buildScript.includes(buildToken), 'full production build runs the existing-client edit verifier');
check(buildScript.indexOf(buildToken) < buildScript.lastIndexOf('vite build'), 'targeted verifier runs before Vite emits production assets');

console.log(`PASS pranimi existing-client edit V1: ${passed.length} guards verified.`);
