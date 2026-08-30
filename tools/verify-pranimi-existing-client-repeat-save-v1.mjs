import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const page = read('app/pranimi/page.jsx');
const syncEngine = read('lib/syncEngine.js');
const syncRecovery = read('lib/syncRecovery.js');
const pkg = JSON.parse(read('package.json'));
const migrationNames = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter((name) => name.endsWith('_pranimi_existing_client_repeat_save_v1.sql'));
const catalogFixNames = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
  .filter((name) => name.endsWith('_pranimi_existing_client_repeat_save_v1_catalog_fix.sql'));

assert.equal(
  migrationNames.length,
  1,
  'exactly one existing-client repeat-save migration must exist',
);
const migration = read(`supabase/migrations/${migrationNames[0]}`);
assert.equal(
  catalogFixNames.length,
  1,
  'the forward-only COALESCE catalog fix must exist exactly once',
);
const effectiveMigration = read(`supabase/migrations/${catalogFixNames[0]}`);

const passed = [];
function check(condition, label) {
  assert.ok(condition, label);
  passed.push(label);
}

function sourceBetween(source, startToken, endToken, label) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `${label}: source boundaries must exist`);
  return source.slice(start, end);
}

/* -------------------- Incident identity and repeat-visit guard ------------------- */
const incident = Object.freeze({
  code: 782,
  clientId: '385b2b9a-27d4-4ee2-b090-321e14da424a',
  oldName: 'afrim afrim',
  newName: 'afrim shabani',
  phone: '+38344150215',
  localOid: 'ff835822-47d0-45dd-9086-8fa50711bd44',
  saveAttemptId: 'e7d63d6e-c1d0-4076-879b-5a9293193bc1',
});

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').replace(/^383/, '0');
}

// Executable acceptance model for the SQL identity precedence. Static checks
// below bind every authoritative branch to the installed trigger body.
function repeatVisitBelongsToOwner({ owner, historical, incoming }) {
  const incomingPhone = normalizePhone(incoming.phone);
  const ownerPhone = normalizePhone(owner.phone);
  if (incoming.clientId && incoming.clientId !== owner.id) return false;
  const authoritativeClientId = incoming.clientId
    || (incomingPhone && incomingPhone === ownerPhone ? owner.id : '');
  if (authoritativeClientId && historical.clientId === authoritativeClientId) return true;
  if (incomingPhone && (!authoritativeClientId || !historical.clientId)) {
    if (normalizePhone(historical.phone) === incomingPhone) return true;
  }
  if (
    authoritativeClientId === owner.id
    && (!historical.clientId || historical.clientId === owner.id)
    && (!normalizePhone(historical.phone) || normalizePhone(historical.phone) === ownerPhone)
  ) return true;
  return !authoritativeClientId
    && !incomingPhone
    && !historical.clientId
    && !normalizePhone(historical.phone)
    && String(historical.name || '').trim().toLowerCase() === String(incoming.name || '').trim().toLowerCase();
}

const owner = { id: incident.clientId, code: incident.code, name: incident.newName, phone: incident.phone };
const historical = { clientId: incident.clientId, code: incident.code, name: incident.oldName, phone: incident.phone };
const renamedRepeat = { clientId: incident.clientId, code: incident.code, name: incident.newName, phone: incident.phone };
check(
  repeatVisitBelongsToOwner({ owner, historical, incoming: renamedRepeat }),
  'a renamed repeat visit with the same canonical UUID remains one client',
);
check(
  !repeatVisitBelongsToOwner({
    owner,
    historical,
    incoming: { ...renamedRepeat, clientId: '99999999-9999-4999-8999-999999999999' },
  }),
  'a contradictory canonical UUID cannot claim code 782',
);
check(!/pg_catalog\.coalesce\s*\(/i.test(effectiveMigration), 'effective trigger never schema-qualifies SQL COALESCE syntax');
check(/v_client_id\s+uuid\s*:=\s*new\.client_id/i.test(effectiveMigration), 'trigger reads the order canonical client UUID first');
check(/v_client_id\s+is\s+not\s+null\s+and\s+v_client_id\s+is\s+distinct\s+from\s+v_code_owner\.id/i.test(effectiveMigration), 'trigger rejects a canonical UUID/code-owner mismatch');
check(/v_client_id\s+is\s+not\s+null\s+and\s+o\.client_id\s*=\s*v_client_id/i.test(effectiveMigration), 'historical name snapshots are allowed when client UUID matches');
check(/v_client_id\s+is\s+null\s+and\s+v_phone_key\s+is\s+null[\s\S]*o\.client_id\s+is\s+null[\s\S]*norm_client_name\(o\.client_name\)/i.test(effectiveMigration), 'name comparison is only the final identity fallback');
check(/errcode\s*=\s*'23514'/i.test(effectiveMigration), 'true permanent-code identity conflicts still fail closed');

/* ---------------- Execute the real page DB-verification helper ------------------ */
const verifierFunctions = sourceBetween(
  page,
  'function extractPranimiSyncSafety',
  'function readVerifiedBaseOrderCode',
  'Pranimi verification helpers',
);

function makeSupabase(resolver) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, 'orders');
      return {
        select() {
          const state = { kind: '', field: '', value: null };
          const query = {
            eq(field, value) {
              state.kind = 'eq';
              state.field = field;
              state.value = value;
              return query;
            },
            filter(field, operator, value) {
              state.kind = 'filter';
              state.field = field;
              state.operator = operator;
              state.value = value;
              return query;
            },
            order() { return query; },
            limit() { return query; },
            async maybeSingle() {
              const snapshot = { ...state };
              calls.push(snapshot);
              return resolver(snapshot);
            },
          };
          return query;
        },
      };
    },
  };
}

function loadActualVerifier(supabase) {
  return Function(
    'supabase',
    `'use strict';\n${verifierFunctions}\nreturn { verifyBaseOrderInDbBySafetyIds };`,
  )(supabase).verifyBaseOrderInDbBySafetyIds;
}

const incidentPayload = {
  local_oid: incident.localOid,
  code: incident.code,
  client_id: incident.clientId,
  client_name: incident.newName,
  client_phone: incident.phone,
  data: {
    local_oid: incident.localOid,
    client_id: incident.clientId,
    client: { id: incident.clientId, code: incident.code, name: incident.newName, phone: incident.phone },
    pranimi_code_lifecycle: {
      local_oid: incident.localOid,
      save_attempt_id: incident.saveAttemptId,
      selected_client_id: incident.clientId,
      code_lifecycle_mode: 'EXISTING_CLIENT_HISTORICAL_CODE',
      db_verify_state: 'DB_VERIFY_PENDING',
    },
  },
};

{
  const supabase = makeSupabase(() => ({ data: null, error: null }));
  const verify = loadActualVerifier(supabase);
  const result = await verify(incidentPayload);
  check(result.found === false && result.unknown === false, 'authoritative DB absence is distinct from an unreadable DB result');
}

{
  const supabase = makeSupabase(() => ({ data: null, error: { code: '57014', message: 'statement timeout' } }));
  const verify = loadActualVerifier(supabase);
  const result = await verify(incidentPayload);
  check(result.found === false && result.unknown === true, 'DB query errors produce unknown instead of false absence');
  check(String(result.error || '').includes('statement timeout'), 'unknown verification retains the real query error');
}

{
  const expectedRow = { id: 3201, local_oid: incident.localOid, code: incident.code };
  const supabase = makeSupabase((query) => {
    if (query.kind === 'filter' && query.field.includes('save_attempt_id')) return { data: expectedRow, error: null };
    return { data: null, error: { code: '57014', message: 'local_oid lookup unavailable' } };
  });
  const verify = loadActualVerifier(supabase);
  const result = await verify(incidentPayload);
  check(result.found === true && result.via === 'save_attempt_id' && result.row.id === 3201, 'save-attempt identity can verify after a local-OID query error');
}

{
  const expectedRow = { id: 3202, local_oid: incident.localOid, code: incident.code };
  const supabase = makeSupabase((query) => (
    query.kind === 'eq' && query.field === 'id' && query.value === 3202
      ? { data: expectedRow, error: null }
      : { data: null, error: null }
  ));
  const verify = loadActualVerifier(supabase);
  const result = await verify(incidentPayload, { server_id: '3202' });
  check(result.found === true && result.via === 'server_id', 'numeric server ID is a safe final verification key');
}

/* ----------------------- Pending -> verified state ordering ---------------------- */
const initialLifecycle = sourceBetween(
  page,
  'applyPranimiFinalLifecycleToPayload(payload, {',
  "appendPranimiCodeDebug('order_started'",
  'initial final lifecycle',
);
check(/verifyState:\s*canAttemptDirectDbFinalSave\s*\?\s*'DB_VERIFY_PENDING'/s.test(initialLifecycle), 'final payload starts as DB_VERIFY_PENDING while online');
check(/source:\s*canAttemptDirectDbFinalSave\s*\?\s*'DB_FINAL_PENDING'/s.test(initialLifecycle), 'pre-write lifecycle source is explicitly pending');

const createPath = sourceBetween(
  page,
  "pranimiDiagLog('[PRANIMI handleContinue] save body', { mode: 'create'",
  'const isOffline =',
  'direct create path',
);
const savePath = sourceBetween(
  page,
  'let queuedOpId = String(',
  'function openDrafts()',
  'create save and retry coordinator',
);
const directWriteAt = Math.min(
  ...['updateOrderRecord(\'orders\'', 'upsertOrderRecord(\'orders\'']
    .map((token) => createPath.indexOf(token))
    .filter((index) => index >= 0),
);
assert.ok(Number.isFinite(directWriteAt), 'direct create path contains a DB write');
const beforeDirectWrite = createPath.slice(0, directWriteAt);
check(/local_sync_status\s*=\s*'DB_VERIFY_PENDING'/.test(beforeDirectWrite), 'direct write remains pending before Supabase returns');
check(/db_verify_state\s*=\s*'DB_VERIFY_PENDING'/.test(beforeDirectWrite), 'DB lifecycle remains pending before Supabase returns');
check(!/local_sync_status\s*=\s*'DB_VERIFIED'/.test(beforeDirectWrite), 'create path cannot claim DB_VERIFIED before the DB write');
const verifiedBranchAt = createPath.indexOf('if (verifyRes?.found)');
const verifiedPromotionAt = createPath.indexOf("verifyState: 'DB_VERIFIED'", verifiedBranchAt);
check(verifiedBranchAt >= 0 && verifiedPromotionAt > verifiedBranchAt, 'DB_VERIFIED promotion occurs only inside the successful readback branch');

const normalizeInsert = sourceBetween(syncEngine, 'function normalizeBaseInsertPayload', 'async function fetchCurrentBaseRowByIdOrLocalOid', 'sync insert normalization');
check(/verifyState:\s*'DB_VERIFY_PENDING'/.test(normalizeInsert), 'outbox insert normalization remains pending before remote readback');
check(!/verifyState:\s*'DB_VERIFIED'/.test(normalizeInsert), 'outbox normalization cannot pre-verify a DB insert');

/* ---------------- Online failure queues the same idempotent order ---------------- */
check(/let\s+queuedOpId\s*=\s*String\s*\(/.test(savePath), 'create path keeps a mutable captured outbox operation ID');
const enqueueHelper = sourceBetween(
  savePath,
  'const enqueueExactPranimiCreateForRetry = async',
  'try {\n        if (isBaseEdit && editTargetId)',
  'exact create retry helper',
);
check(/await\s+enqueueBaseOrder\s*\(/.test(enqueueHelper), 'retry helper writes a real BASE outbox operation');
check(/id:\s*retryCreateLocalOid/.test(enqueueHelper) && /local_oid:\s*retryCreateLocalOid/.test(enqueueHelper), 'retry helper uses one stable local OID for queue identity');
check(/save_attempt_id:\s*saveAttemptId/.test(enqueueHelper), 'retry helper copies the original save-attempt ID into queued data');
check(/queuedOpId\s*=\s*String\s*\(/.test(enqueueHelper), 'retry helper records the generated outbox operation ID');
const verifyFailureAt = createPath.indexOf("payload.data.local_sync_status = 'LOCAL / NOT SYNCED'", verifiedBranchAt);
const verifyFailureBlock = createPath.slice(verifyFailureAt);
check(verifyFailureAt >= 0 && /await\s+enqueueExactPranimiCreateForRetry\(verifyFailureState\)/.test(verifyFailureBlock), 'DB verify miss enqueues the final payload before warning');
check(/outbox_op_id:\s*queuedOpId/.test(verifyFailureBlock), 'DB verify miss exposes the generated outbox operation ID');

const nonOfflineFailure = sourceBetween(
  savePath,
  'if (!isOffline) {',
  'try {\n          if (isBaseEdit && editTargetId)',
  'online non-network failure branch',
);
check(/await\s+enqueueExactPranimiCreateForRetry\('DIRECT_ONLINE_SAVE_THROW'\)/.test(nonOfflineFailure), 'online save exception enqueues the exact final payload');
check(/const\s+directSaveError\s*=\s*String\(err\?\.message/.test(nonOfflineFailure), 'online failure captures the real database error');
check(/last_error:\s*directSaveWarningError/.test(nonOfflineFailure), 'online failure warning retains the combined database/outbox error');
check(/outbox_op_id:\s*queuedOpId/.test(nonOfflineFailure), 'online failure warning exposes the captured outbox ID');

const retryBlock = sourceBetween(
  syncEngine,
  "const lifecycleSafeRetryCode = String(e?.code || '');",
  'if (structural) {',
  'DB verify retry branch',
);
check(/buildRetriedOp\(op, e/.test(retryBlock) && /await pushOp\(nextOp\)/.test(retryBlock), 'sync engine retries DB_VERIFY_FAILED with the same outbox operation');
check(!/discardPermanentOp/.test(retryBlock), 'DB_VERIFY_FAILED is never discarded as a permanent error');
const retryBuilder = sourceBetween(syncEngine, 'function buildRetriedOp', 'function markFailedPermanently', 'retry builder');
check(/return\s*\{\s*\.\.\.op,/s.test(retryBuilder), 'retry keeps the original payload, local OID, save-attempt ID and op ID');

check(/function isRecoverableHistoricalClientRenameFailure/.test(syncRecovery), 'recovery recognizes the historical-client rename incident narrowly');
check(/code_lifecycle_mode[^\n]*EXISTING_CLIENT_HISTORICAL_CODE/.test(syncRecovery), 'recovery revival requires historical-client lifecycle mode');
check(/!isRecoverableHistoricalClientRenameFailure\(item, payload\)/.test(syncRecovery), 'the known false historical-name conflict does not remain terminal');
check(/revive:\s*true/.test(syncRecovery), 'orphan recovery explicitly revives only the eligible terminal entry');

class MemoryStorage {
  constructor() { this.items = new Map(); }
  getItem(key) { return this.items.has(key) ? this.items.get(key) : null; }
  setItem(key, value) { this.items.set(String(key), String(value)); }
  removeItem(key) { this.items.delete(String(key)); }
}

function makeWindow(storage) {
  return { localStorage: storage, dispatchEvent() {} };
}

const recoveryCoreSource = sourceBetween(
  syncRecovery,
  'function writeEntries',
  'async function remoteOrderExists',
  'recovery core state machine',
);
const recoveryRegistrySource = sourceBetween(
  syncRecovery,
  'function toRecoveryEntry',
  'export function clearBaseCreateRecovery',
  'recovery registry state machine',
);
const recoveryStateSource = `${recoveryCoreSource}\n${recoveryRegistrySource}`
  .replaceAll('export function', 'function')
  .replaceAll('export async function', 'async function');

function loadActualRecoveryStateMachine(windowObject, writeOp = async (op) => op) {
  return Function(
    'window',
    'RECOVERY_KEY',
    'MAX_ENTRIES',
    'safeParse',
    'isBrowser',
    'isTerminalStatus',
    'nowIso',
    'syncDebugLog',
    'CustomEvent',
    'loadPranimiCodeAllocatorModule',
    'loadPranimiBaseCodesModule',
    'pushOp',
    'supabase',
    `'use strict';\n${recoveryStateSource}\nreturn { rememberBaseCreateRecovery, listBaseCreateRecovery, isRecoverableHistoricalClientRenameFailure, reviveRetainedHistoricalRenameOps, finalizePranimiCodeLifecycleAfterRecovery, persistRecoveredPranimiLifecycle };`,
  )(
    windowObject,
    'tepiha_sync_recovery_v1',
    80,
    (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } },
    () => true,
    (status) => ['synced', 'abandoned_missing_local', 'failed_permanently'].includes(String(status || '')),
    () => '2026-08-30T10:30:00.000Z',
    () => {},
    class TestCustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    async () => ({ getPranimiCodeAllocator: () => null }),
    async () => ({}),
    writeOp,
    { from() { throw new Error('unused supabase'); } },
  );
}

{
  const storage = new MemoryStorage();
  const storedOps = [];
  const machine = loadActualRecoveryStateMachine(makeWindow(storage), async (op) => {
    storedOps.push(structuredClone(op));
    return op;
  });
  storage.setItem('tepiha_sync_recovery_v1', JSON.stringify([{
    id: incident.localOid,
    local_oid: incident.localOid,
    code: String(incident.code),
    status: 'failed_permanently',
    source: 'syncEngine',
    note: 'Kodi 782 tashmë është i lidhur me klient tjetër: afrim afrim',
    terminal: true,
  }]));
  const terminalMirror = {
    ...incidentPayload,
    _synced: false,
    _syncPending: false,
    _syncFailed: true,
    _syncError: 'DB_VERIFY_FAILED',
    data: {
      ...incidentPayload.data,
      sync_error: 'DB_VERIFY_FAILED',
      pranimi_code_lifecycle: {
        ...incidentPayload.data.pranimi_code_lifecycle,
        db_verify_state: 'DB_VERIFY_FAILED',
      },
    },
  };
  check(
    machine.isRecoverableHistoricalClientRenameFailure(machine.listBaseCreateRecovery()[0], terminalMirror),
    'known historical-name false conflict remains recoverable when the old terminal mirror has _syncPending false',
  );
  const retainedOps = [{
    op_id: 'retained-op-782',
    type: 'insert_order',
    id: incident.localOid,
    status: 'failed_permanently',
    nextRetryAt: null,
    lastError: { message: 'Kodi 782 tashmë është i lidhur me klient tjetër: afrim afrim' },
    last_error: { message: 'Kodi 782 tashmë është i lidhur me klient tjetër: afrim afrim' },
    failed_at: '2026-08-29T09:50:00.000Z',
    payload: terminalMirror,
  }];
  const retainedResult = await machine.reviveRetainedHistoricalRenameOps(
    machine.listBaseCreateRecovery()[0],
    terminalMirror,
    retainedOps,
    'startup_repair_test',
  );
  check(retainedResult.revived === 1 && storedOps.length === 1, 'executable recovery revives the retained failed_permanently ops record');
  check(storedOps[0].op_id === 'retained-op-782' && retainedOps[0].op_id === 'retained-op-782', 'retained recovery preserves the exact outbox op ID');
  check(retainedOps[0].status === 'pending' && retainedOps[0].nextRetryAt === null && retainedOps[0].lastError === null, 'retained outbox op becomes immediately eligible for syncEngine');
  const unrelatedRetainedOps = [{
    ...retainedOps[0],
    op_id: 'unrelated-retained-op',
    status: 'failed_permanently',
    lastError: { message: 'different structural failure' },
  }];
  const unrelatedRetainedResult = await machine.reviveRetainedHistoricalRenameOps(
    machine.listBaseCreateRecovery()[0],
    terminalMirror,
    unrelatedRetainedOps,
    'startup_repair_negative_test',
  );
  check(unrelatedRetainedResult.revived === 0 && unrelatedRetainedOps[0].status === 'failed_permanently', 'retained op with unrelated own error text remains terminal');
  machine.rememberBaseCreateRecovery(terminalMirror, {
    status: 'queued',
    source: 'startup_repair',
    note: 'repaired_enqueue',
    revive: true,
  });
  const revived = machine.listBaseCreateRecovery()[0];
  check(revived.status === 'queued' && revived.terminal === false, 'executable recovery transition revives failed_permanently into queued');

  storage.setItem('tepiha_sync_recovery_v1', JSON.stringify([{
    id: incident.localOid,
    local_oid: incident.localOid,
    code: String(incident.code),
    status: 'failed_permanently',
    source: 'syncEngine',
    note: 'different structural failure',
    terminal: true,
  }]));
  machine.rememberBaseCreateRecovery(terminalMirror, {
    status: 'queued',
    source: 'startup_repair',
    note: 'repaired_enqueue',
    revive: true,
  });
  check(machine.listBaseCreateRecovery()[0].terminal === true, 'unrelated terminal failures remain terminal');
}

/* -------- Execute background allocator finalization + durable acknowledgement ---- */
function loadActualLifecycleRecovery({ allocator, baseCodes, supabase }) {
  const storage = new MemoryStorage();
  const windowObject = makeWindow(storage);
  const machine = Function(
    'window',
    'RECOVERY_KEY',
    'MAX_ENTRIES',
    'safeParse',
    'isBrowser',
    'isTerminalStatus',
    'nowIso',
    'syncDebugLog',
    'CustomEvent',
    'loadPranimiCodeAllocatorModule',
    'loadPranimiBaseCodesModule',
    'pushOp',
    'supabase',
    `'use strict';\n${recoveryStateSource}\nreturn { finalizePranimiCodeLifecycleAfterRecovery, persistRecoveredPranimiLifecycle };`,
  )(
    windowObject,
    'tepiha_sync_recovery_v1',
    80,
    (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } },
    () => true,
    (status) => ['synced', 'abandoned_missing_local', 'failed_permanently'].includes(String(status || '')),
    () => '2026-08-30T10:31:00.000Z',
    () => {},
    class TestCustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    async () => ({ getPranimiCodeAllocator: () => allocator }),
    async () => baseCodes,
    async (op) => op,
    supabase,
  );
  return machine;
}

{
  const events = [];
  const tempCode = 1200;
  const remoteRow = {
    id: 3208,
    local_oid: incident.localOid,
    code: incident.code,
    client_phone: incident.phone,
    status: 'pastrim',
    data: { ...incidentPayload.data },
  };
  const localRow = {
    ...incidentPayload,
    _synced: false,
    _syncPending: true,
    _syncFailed: true,
    data: {
      ...incidentPayload.data,
      pranimi_code_lifecycle: {
        ...incidentPayload.data.pranimi_code_lifecycle,
        pin: '4563',
        code_lifecycle_pin: '4563',
        code_lifecycle_pre_final_assignment_present: true,
        code_lifecycle_pre_final_assignment_code: tempCode,
        code_lifecycle_temp_assignment_existed: true,
        code_lifecycle_temp_code: tempCode,
      },
    },
  };
  let persistedPatch = null;
  const persistenceFilters = [];
  const supabase = {
    from(table) {
      assert.equal(table, 'orders');
      const query = {
        update(patch) { persistedPatch = patch; return query; },
        eq(field, value) {
          persistenceFilters.push([field, value]);
          if (field === 'id') assert.equal(value, 3208);
          else if (field === 'local_oid') assert.equal(value, incident.localOid);
          else assert.fail(`unexpected recovery persistence filter: ${field}`);
          return query;
        },
        select() { return query; },
        async maybeSingle() { return { data: { ...remoteRow, data: persistedPatch.data }, error: null }; },
      };
      return query;
    },
  };
  const allocator = {
    assignedCodeForDraft(oid) { assert.equal(oid, incident.localOid); return tempCode; },
    async finalizeExistingClientDraft(args) {
      events.push(['allocator_finalize', args]);
      return { ok: false, reason: 'OFFLINE_BANK_RELEASE_DEFERRED_TO_OUTBOX_SYNC', tempCode };
    },
    acknowledgeFinalizedDraft(args) { events.push(['local_ack', args]); return { ok: true }; },
  };
  const baseCodes = {
    async releasePranimiTempCodeAfterExistingClientSaveInDb(args) {
      events.push(['db_release', args]);
      return { ok: true, reason: 'TEMP_CODE_RELEASED' };
    },
  };
  const machine = loadActualLifecycleRecovery({ allocator, baseCodes, supabase });
  const lifecycle = await machine.finalizePranimiCodeLifecycleAfterRecovery({ localRow, remoteRow, source: 'test_existing_remote' });
  check(lifecycle.ok === true && lifecycle.state === 'ACKNOWLEDGED' && lifecycle.tempCode === String(tempCode), 'background recovery completes historical-client allocator lifecycle');
  check(events.map(([name]) => name).join('>') === 'allocator_finalize>db_release>local_ack', 'DB temp-code release completes before local allocator acknowledgement');
  check(events[1][1].pin === '4563' && events[1][1].oid === incident.localOid && events[1][1].orderId === '3208', 'background finalization uses exact lifecycle PIN, draft and DB order ID');

  const durable = await machine.persistRecoveredPranimiLifecycle(remoteRow, localRow, lifecycle, 'test_existing_remote');
  const durableLife = durable.data.pranimi_code_lifecycle;
  check(durableLife.code_lifecycle_finalize_state === 'ACKNOWLEDGED', 'remote order durably records allocator acknowledgement');
  check(durableLife.code_lifecycle_temp_code === tempCode && durableLife.db_verify_state === 'DB_VERIFIED', 'durable acknowledgement keeps exact temp code and verified state');
  check(
    durableLife.code_lifecycle_finalize_order_id === '3208'
      && durableLife.code_lifecycle_finalize_local_oid === incident.localOid
      && durableLife.code_lifecycle_finalize_code === incident.code
      && durableLife.code_lifecycle_finalize_mode === 'EXISTING_CLIENT_HISTORICAL_CODE',
    'durable acknowledgement records exact order, local OID, code and lifecycle mode',
  );
  check(
    persistenceFilters.some(([field, value]) => field === 'id' && value === 3208)
      && persistenceFilters.some(([field, value]) => field === 'local_oid' && value === incident.localOid),
    'recovery acknowledgement update is constrained by both server ID and local OID',
  );

  let durableAssigned = tempCode;
  let durableReplayAcks = 0;
  let durableSecondFinalizations = 0;
  const durableReplayMachine = loadActualLifecycleRecovery({
    allocator: {
      assignedCodeForDraft() { return durableAssigned; },
      acknowledgeFinalizedDraft(args) {
        assert.equal(args.pin, '4563');
        assert.equal(args.oid, incident.localOid);
        assert.equal(args.orderId, '3208');
        assert.equal(args.code, String(tempCode));
        durableReplayAcks += 1;
        durableAssigned = null;
        return { ok: true };
      },
      async finalizeExistingClientDraft() {
        durableSecondFinalizations += 1;
        return { ok: true };
      },
    },
    baseCodes: {
      async releasePranimiTempCodeAfterExistingClientSaveInDb() {
        durableSecondFinalizations += 1;
        return { ok: true };
      },
    },
    supabase,
  });
  const replayOne = await durableReplayMachine.finalizePranimiCodeLifecycleAfterRecovery({
    localRow,
    remoteRow: durable,
    source: 'test_exact_durable_background_ack_first',
  });
  const replayTwo = await durableReplayMachine.finalizePranimiCodeLifecycleAfterRecovery({
    localRow,
    remoteRow: durable,
    source: 'test_exact_durable_background_ack_second',
  });
  check(
    replayOne.ok === true && replayTwo.ok === true && durableReplayAcks === 1 && durableSecondFinalizations === 0,
    'background recovery trusts an exact durable ACK, replays local acknowledgement once, and never finalizes DB twice',
  );
  const mismatchedDurable = structuredClone(durable);
  mismatchedDurable.data.pranimi_code_lifecycle.code_lifecycle_finalize_local_oid = 'wrong-local-oid';
  await assert.rejects(
    () => durableReplayMachine.finalizePranimiCodeLifecycleAfterRecovery({
      localRow,
      remoteRow: mismatchedDurable,
      source: 'test_mismatched_durable_background_ack',
    }),
    (error) => error?.code === 'PRANIMI_CODE_LIFECYCLE_PENDING'
      && error?.reason === 'DURABLE_CODE_LIFECYCLE_ACK_IDENTITY_MISMATCH',
  );
  check(durableSecondFinalizations === 0, 'background durable ACK identity mismatch fails closed without DB finalization');

  const missingBindingEvents = [];
  const missingBindingMachine = loadActualLifecycleRecovery({
    allocator: {
      assignedCodeForDraft() { return null; },
      acknowledgeFinalizedDraft() { missingBindingEvents.push('unexpected_local_ack'); return { ok: true }; },
    },
    baseCodes: {
      async releasePranimiTempCodeAfterExistingClientSaveInDb(args) {
        missingBindingEvents.push(['db_release_recorded_temp', args]);
        return { ok: true, reason: 'TEMP_CODE_RELEASED_FROM_RECORDED_PAYLOAD' };
      },
    },
    supabase,
  });
  const missingBindingLifecycle = await missingBindingMachine.finalizePranimiCodeLifecycleAfterRecovery({
    localRow,
    remoteRow,
    source: 'test_recorded_temp_without_local_binding',
  });
  check(missingBindingLifecycle.ok === true && missingBindingLifecycle.tempCode === String(tempCode), 'recorded exact temp code finalizes when local allocator binding is missing');
  check(
    missingBindingEvents.length === 1
      && missingBindingEvents[0][0] === 'db_release_recorded_temp'
      && missingBindingEvents[0][1].tempCode === String(tempCode),
    'missing-binding recovery releases the exact recorded temp code through the official DB path',
  );

  const missingTempCodeRow = structuredClone(localRow);
  delete missingTempCodeRow.data.pranimi_code_lifecycle.code_lifecycle_temp_code;
  await assert.rejects(
    () => missingBindingMachine.finalizePranimiCodeLifecycleAfterRecovery({ localRow: missingTempCodeRow, remoteRow, source: 'test_missing_recorded_temp' }),
    (error) => error?.code === 'PRANIMI_CODE_LIFECYCLE_PENDING' && error?.reason === 'HISTORICAL_TEMP_ASSIGNMENT_CODE_MISSING',
  );
  check(true, 'payload claiming a historical temp assignment without its exact code fails closed');

  const legacyUnknownRow = structuredClone(localRow);
  delete legacyUnknownRow.data.pranimi_code_lifecycle.code_lifecycle_pre_final_assignment_present;
  delete legacyUnknownRow.data.pranimi_code_lifecycle.code_lifecycle_pre_final_assignment_code;
  delete legacyUnknownRow.data.pranimi_code_lifecycle.code_lifecycle_temp_assignment_existed;
  delete legacyUnknownRow.data.pranimi_code_lifecycle.code_lifecycle_temp_code;
  await assert.rejects(
    () => missingBindingMachine.finalizePranimiCodeLifecycleAfterRecovery({ localRow: legacyUnknownRow, remoteRow, source: 'test_legacy_unknown_assignment' }),
    (error) => error?.code === 'PRANIMI_CODE_LIFECYCLE_PENDING' && error?.reason === 'LEGACY_HISTORICAL_ASSIGNMENT_STATE_UNKNOWN',
  );
  check(true, 'legacy historical payload without assignment markers fails closed when local binding is missing');

  const zeroRowMachine = loadActualLifecycleRecovery({
    allocator,
    baseCodes,
    supabase: {
      from() {
        const query = {
          update() { return query; },
          eq() { return query; },
          select() { return query; },
          async maybeSingle() { return { data: null, error: null }; },
        };
        return query;
      },
    },
  });
  await assert.rejects(
    () => zeroRowMachine.persistRecoveredPranimiLifecycle(remoteRow, localRow, lifecycle, 'test_zero_row_ack_update'),
    (error) => error?.code === 'PRANIMI_CODE_LIFECYCLE_PENDING' && error?.reason === 'PRANIMI_CODE_LIFECYCLE_ACK_PERSIST_ZERO_ROWS',
  );
  check(true, 'syncRecovery zero-row acknowledgement update throws a retryable lifecycle error');

  const recoveryMismatchMachine = loadActualLifecycleRecovery({
    allocator,
    baseCodes,
    supabase: {
      from() {
        const query = {
          update() { return query; },
          eq() { return query; },
          select() { return query; },
          async maybeSingle() { return { data: { ...remoteRow, local_oid: 'wrong-local-oid' }, error: null }; },
        };
        return query;
      },
    },
  });
  await assert.rejects(
    () => recoveryMismatchMachine.persistRecoveredPranimiLifecycle(remoteRow, localRow, lifecycle, 'test_mismatched_ack_update'),
    (error) => error?.code === 'PRANIMI_CODE_LIFECYCLE_PENDING' && error?.reason === 'PRANIMI_CODE_LIFECYCLE_ACK_PERSIST_IDENTITY_MISMATCH',
  );
  check(true, 'syncRecovery verifies exact returned server ID and local OID before clearing recovery');

  let failedPathAcknowledged = false;
  const failingMachine = loadActualLifecycleRecovery({
    allocator: {
      assignedCodeForDraft() { return tempCode; },
      async finalizeExistingClientDraft() { return { ok: false, reason: 'TEMP_RELEASE_NOT_CONFIRMED' }; },
      acknowledgeFinalizedDraft() { failedPathAcknowledged = true; return { ok: true }; },
    },
    baseCodes: {},
    supabase,
  });
  await assert.rejects(
    () => failingMachine.finalizePranimiCodeLifecycleAfterRecovery({ localRow, remoteRow, source: 'test_failed_finalize' }),
    (error) => error?.code === 'PRANIMI_CODE_LIFECYCLE_PENDING' && error?.reason === 'TEMP_RELEASE_NOT_CONFIRMED',
  );
  check(failedPathAcknowledged === false, 'failed DB code finalization never clears the local allocator binding');
}

check(/code_lifecycle_temp_assignment_existed:\s*historicalTempAssignmentExisted/.test(page), 'page records whether an exact historical temp assignment existed');
check(/code_lifecycle_temp_code:\s*Number\(allocatorAssignmentBeforeFinalCode\)/.test(page), 'page records the exact pre-final allocator temp code');

const remoteStateUpdaterSource = sourceBetween(
  syncEngine,
  'function buildDbVerifyStateUpdateError',
  'async function findExistingRemoteOrder',
  'syncEngine remote verification-state updater',
);
function loadActualRemoteStateUpdater(supabase) {
  return Function(
    'supabase',
    'buildDbVerifiedBaseData',
    `'use strict';\n${remoteStateUpdaterSource}\nreturn markRemoteBaseOrderDbVerified;`,
  )(supabase, () => ({ pranimi_code_lifecycle: { db_verify_state: 'DB_VERIFIED' } }));
}
function makeRemoteUpdateSupabase(resultFactory) {
  return {
    from(table) {
      assert.equal(table, 'orders');
      const query = {
        update() { return query; },
        eq(field, value) {
          if (field === 'id') assert.equal(value, 3208);
          else if (field === 'local_oid') assert.equal(value, incident.localOid);
          else assert.fail(`unexpected syncEngine verification filter: ${field}`);
          return query;
        },
        select() { return query; },
        async maybeSingle() { return resultFactory(); },
      };
      return query;
    },
  };
}
{
  const args = [
    'orders',
    { id: 3208, local_oid: incident.localOid },
    { local_oid: incident.localOid, data: { local_oid: incident.localOid } },
    { local_oid: incident.localOid, data: { local_oid: incident.localOid } },
    { row: { id: 3208 }, via: 'test' },
    { op_id: 'zero-row-test-op' },
  ];
  const zeroUpdater = loadActualRemoteStateUpdater(makeRemoteUpdateSupabase(() => ({ data: null, error: null })));
  await assert.rejects(
    () => zeroUpdater(...args),
    (error) => error?.code === 'DB_VERIFY_STATE_UPDATE_FAILED' && error?.reason === 'DB_VERIFY_STATE_UPDATE_ZERO_ROWS',
  );
  check(true, 'syncEngine zero-row DB verification-state update throws a retryable state error');

  const mismatchUpdater = loadActualRemoteStateUpdater(makeRemoteUpdateSupabase(() => ({
    data: { id: 3208, local_oid: 'wrong-local-oid', data: {} },
    error: null,
  })));
  await assert.rejects(
    () => mismatchUpdater(...args),
    (error) => error?.code === 'DB_VERIFY_STATE_UPDATE_FAILED' && error?.reason === 'DB_VERIFY_STATE_UPDATE_IDENTITY_MISMATCH',
  );
  check(true, 'syncEngine verifies exact returned server ID and local OID before success');
}

const retryLifecycleSource = sourceBetween(
  page,
  'async function finalizeRetryCodeLifecycle',
  'async function retryLocalSyncWarning',
  'manual retry code lifecycle',
);
function loadActualRetryLifecycle({ getAssigned, acknowledge, consume, finalizeExisting }) {
  return Function(
    'normalizeRealPin',
    'resolvePranimiActorPin',
    'actor',
    'normalizeCode',
    'getAssignedPranimiCode',
    'acknowledgeFinalizedPranimiCode',
    'consumePranimiCode',
    'finalizeExistingClientPranimiCode',
    `'use strict';\n${retryLifecycleSource}\nreturn finalizeRetryCodeLifecycle;`,
  )(
    (value) => (/^\d{3,12}$/.test(String(value || '').trim()) ? String(value).trim() : ''),
    () => 'actor-fallback-pin',
    {},
    (value) => {
      const raw = String(value ?? '').trim();
      return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
    },
    getAssigned,
    acknowledge,
    consume,
    finalizeExisting,
  );
}
{
  let assigned = incident.code;
  let consumeCalls = 0;
  const ackPins = [];
  const retryLifecycle = loadActualRetryLifecycle({
    getAssigned: () => assigned,
    acknowledge: (pin, oid, code, orderId) => {
      ackPins.push({ pin, oid, code, orderId });
      assigned = null;
      return { ok: true };
    },
    consume: async () => { consumeCalls += 1; return { ok: true }; },
    finalizeExisting: async () => { throw new Error('unexpected existing-client finalize'); },
  });
  const retryPayload = {
    local_oid: incident.localOid,
    code: incident.code,
    data: {
      local_oid: incident.localOid,
      code: incident.code,
      pranimi_code_lifecycle: {
        local_oid: incident.localOid,
        pin: '9999',
        code_lifecycle_pin: '4563',
        final_code: incident.code,
        code_lifecycle_mode: 'NEW_ASSIGNED_CODE',
      },
    },
  };
  const retryRemote = {
    id: 3208,
    local_oid: incident.localOid,
    code: incident.code,
    data: {
      local_oid: incident.localOid,
      code: incident.code,
      pranimi_code_lifecycle: {
        local_oid: incident.localOid,
        server_id: '3208',
        final_code: incident.code,
        code_lifecycle_mode: 'NEW_ASSIGNED_CODE',
        code_lifecycle_finalize_state: 'ACKNOWLEDGED',
        code_lifecycle_finalize_order_id: '3208',
        code_lifecycle_finalize_local_oid: incident.localOid,
        code_lifecycle_finalize_code: incident.code,
        code_lifecycle_finalize_mode: 'NEW_ASSIGNED_CODE',
        code_lifecycle_temp_code: incident.code,
      },
    },
  };
  const firstRetry = await retryLifecycle(retryRemote, retryPayload, {});
  const secondRetry = await retryLifecycle(retryRemote, retryPayload, {});
  check(firstRetry.ok === true && secondRetry.ok === true && consumeCalls === 0, 'NEW_ASSIGNED_CODE durable marker prevents double DB finalization across repeated manual retries');
  check(ackPins.length === 1 && ackPins[0].pin === '4563', 'manual durable replay acknowledges local binding once using code_lifecycle_pin before pin');

  const mismatchedRemote = structuredClone(retryRemote);
  mismatchedRemote.data.pranimi_code_lifecycle.code_lifecycle_finalize_code = 999;
  const mismatch = await retryLifecycle(mismatchedRemote, retryPayload, {});
  check(mismatch.ok === false && mismatch.reason === 'DURABLE_CODE_LIFECYCLE_ACK_IDENTITY_MISMATCH' && consumeCalls === 0, 'durable acknowledgement identity mismatch fails closed without second finalization');
}

check((syncEngine.match(/finalizePranimiCodeLifecycleAfterBackgroundVerify\s*\(/g) || []).length >= 3, 'sync engine invokes lifecycle finalization on existing-remote and post-upsert success paths');
check(/PRANIMI_CODE_LIFECYCLE_PENDING/.test(retryBlock), 'allocator lifecycle failure uses the lifecycle-safe retry branch');
check(/code_lifecycle_finalize_state:\s*'ACKNOWLEDGED'/.test(syncEngine), 'sync engine persists allocator acknowledgement into the verified remote order');
check(/finalizePranimiCodeLifecycleAfterRecovery\([\s\S]*persistRecoveredPranimiLifecycle\([\s\S]*clearPendingArtifacts\(/.test(syncRecovery), 'startup recovery finalizes and persists lifecycle before clearing pending artifacts');

// JavaScript object spread is the queue call contract: the immutable safety IDs
// survive the added local queue addressing fields unchanged.
const queuedIncident = { id: incident.localOid, local_oid: incident.localOid, ...incidentPayload };
check(queuedIncident.local_oid === incident.localOid, 'queue payload preserves incident local_oid');
check(queuedIncident.data.pranimi_code_lifecycle.save_attempt_id === incident.saveAttemptId, 'queue payload preserves incident save_attempt_id');

/* ---------------------------- Full-build ownership ------------------------------- */
check(
  pkg.scripts?.['test:pranimi-existing-client-repeat-save-v1'] === 'node tools/verify-pranimi-existing-client-repeat-save-v1.mjs',
  'package exposes the focused repeat-save verifier',
);
const build = String(pkg.scripts?.build || '');
for (const token of [
  'npm run test:pranimi-code',
  'npm run test:pranimi-allocator',
  'npm run test:pranimi-new-client-mode',
  'npm run test:pranimi-final-status',
  'npm run test:pranimi-existing-client-lock',
  'npm run test:pranimi-existing-client-repeat-save-v1',
]) {
  check(build.includes(token), `full production build includes ${token}`);
  check(build.indexOf(token) < build.lastIndexOf('vite build'), `${token} runs before production assets are emitted`);
}

console.log(`PASS pranimi existing-client repeat save V1: ${passed.length} guards verified.`);
