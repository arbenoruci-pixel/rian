import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeRealPin } from '../lib/pinIdentity.js';

// Execute the actual page consumers with controlled network/storage boundaries.
// These scenarios protect saved draft content while table access moves behind
// the approved-device status endpoint.
const pranimi = fs.readFileSync(new URL('../app/pranimi/page.jsx', import.meta.url), 'utf8');
const pastrimi = fs.readFileSync(new URL('../app/pastrimi/page.jsx', import.meta.url), 'utf8');
const baseCodes = fs.readFileSync(new URL('../lib/baseCodes.js', import.meta.url), 'utf8');

function between(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0 && end > start, `source boundaries: ${startToken}`);
  return source.slice(start, end);
}

const commonCode = between(baseCodes, 'export function normalizeCode(', 'export function computeM2FromRows(')
  .replace(/^export /, '');
const draftCode = [
  commonCode,
  between(pranimi, 'function safeJsonParse(', 'function readPranimiEntryIntent('),
  between(pranimi, 'function normalizeMatchPhone(', 'function isNoPhonePlaceholder('),
  between(pranimi, 'function snapshotHasMeaningfulWork(', 'function sessionSnapshotHasContent('),
  between(pranimi, 'function readPlainObject(', 'function normalizePranimiOrderStatus('),
  between(pranimi, 'function normalizeLegacyOrderIdCandidate(', 'function legacyOrderIdForSupabase('),
  between(pranimi, 'function getPranimiDraftFileKey(', 'function isPranimiRemoteDraftLike('),
  between(pranimi, 'function extractPranimiDraftSafetyIds(', 'function orderRowMatchesPranimiDraft('),
  between(pranimi, 'function draftReservationKey(', 'function writeDraftReservationLocal('),
  between(pranimi, 'function readLockedDraftOwnerPinFromPool(', 'function removeDraftReservationLocal('),
  between(pranimi, 'function readPranimiDraftCodeForGuard(', 'async function draftHasVerifiedOrderInDb('),
  between(pranimi, 'async function filterDraftSummariesAgainstDb(', 'async function fetchRemoteDraftsSummary('),
  between(pranimi, '  async function loadDraftIntoForm(', '  async function deleteDraft('),
  between(pranimi, '  async function verifyRestoredDraftCodeOrAllocate(', '  function clearActiveEditBridge('),
].join('\n');
const pastrimiCode = commonCode + '\n'
  + between(pastrimi, 'async function fetchPastrimiBaseCodePoolInfo(', 'function isPastrimiProblemNoPhone(');

function makeDraftHarness({ rows = [], error = null, remoteDraft = null } = {}) {
  const calls = { reads: [], readOptions: [], debug: [], renewed: [], deleted: [], reservationDeleted: [], opened: [], allocated: [], writtenReservations: [], alerts: [] };
  const storage = new Map();
  const ctx = vm.createContext({
    Map, Date, normalizeRealPin,
    PRANIMI_DRAFT_RESERVATION_PREFIX: 'pranimi_draft_reservation:',
    window: { localStorage: { getItem: key => storage.get(key) ?? null } },
    fetchBaseCodeStatuses: async (codes, options) => {
      calls.reads.push(Array.from(codes));
      calls.readOptions.push(options);
      if (error) throw error;
      return rows;
    },
    appendPranimiCodeDebug: (event, detail) => calls.debug.push({ event, detail }),
    fetchBlockingOrderRowsForDrafts: async () => ({ rows: [], uncertain: false }),
    isPranimiUnsafeRemoteDraftSummary: () => false,
    findBlockingOrderForDraftInRows: () => ({ blocked: false }),
    resolvePranimiActorPin: () => '900002',
    renewPranimiCodeLease: async (...args) => { calls.renewed.push(args); return { ok: true }; },
    removeDraftLocal: id => calls.deleted.push(id),
    removeDraftReservationLocal: id => calls.reservationDeleted.push(id),
    markPranimiDraftUiVerified: item => ({ ...item, ui_verified: true }),
    draftTimer: { current: null }, remoteDraftTimerRef: { current: null },
    findBlockingOrderForDraftInDb: async () => ({ blocked: false, uncertain: false }),
    readDraftRemote: async () => remoteDraft,
    collectPranimiDraftAliasKeys: () => [],
    unsuppressDraftId() {},
    applyDraftSnapshotToForm: (draft, id, options) => calls.opened.push({ draft, id, options }),
    sessionSnapshotHasContent: () => true,
    writeCurrentSessionLocal() {},
    alert: message => calls.alerts.push(message),
    refreshDrafts: async () => {},
    hideBlockedDraftFromUi() {},
    getActor: () => ({ pin: '900002' }),
    codeRawRef: { current: '' }, oidRef: { current: '' },
    setCodeRaw() {}, setCodeReserveUi() {},
    allocatePranimiCode: async (...args) => { calls.allocated.push(args); return { code: args[2], source: 'DB_VERIFIED_FIXTURE' }; },
    writeDraftReservationLocal: value => calls.writtenReservations.push(value),
    getDraftCreatedAt: () => '2026-01-01T00:00:00Z',
    friendlyCodeReserveMessage: value => value,
  });
  vm.runInContext(draftCode, ctx);
  return { ctx, calls, storage };
}

function makePastrimiHarness({ rows = [], error = null } = {}) {
  const calls = [];
  const readOptions = [];
  const ctx = vm.createContext({
    fetchBaseCodeStatuses: async (codes, options) => {
      calls.push(Array.from(codes));
      readOptions.push(options);
      if (error) throw error;
      return rows;
    },
  });
  vm.runInContext(pastrimiCode, ctx);
  return { ctx, calls, readOptions };
}

const project = row => ({ code: row.code, status: row.status, lease_expires_at: row.lease_expires_at });
const row = (code, status) => ({
  code: String(code), status, lease_expires_at: '2099-01-01T00:00:00Z',
  owner_id: 'private-owner', reserved_by: 'private-worker',
  draft_session_id: 'private-draft', used_by_pin: 'private-worker', used_order_id: 'private-order',
});
const remote = Object.freeze({ id: 'remote-draft', code: 201, name: 'Example client', source: 'REMOTE', file_key: 'remote-draft', ts: 1 });
const local = Object.freeze({ id: 'local-draft', code: 201, name: 'Example client', source: 'LOCAL', tepihaRows: [{ qty: 2, m2: 4 }], ts: 2 });
const dbDraft = Object.freeze({ id: 'db-draft', code: 201, source: 'DB DRAFT', db_order_id: 'example-order', data: { is_pranimi_incomplete_draft: true }, ts: 3 });

// The minimal projection preserves every canonical status decision, including
// used codes with old reservation metadata still present on the original row.
{
  const h = makeDraftHarness();
  const p = makePastrimiHarness();
  for (const status of ['available', 'reserved', 'used']) {
    const full = row(201, status);
    const minimal = project(full);
    assert.equal(h.ctx.readBaseCodePoolVerdict(minimal).state, h.ctx.readBaseCodePoolVerdict(full).state);
    assert.equal(p.ctx.pastrimiBaseCodePoolBlocksInsert(minimal), p.ctx.pastrimiBaseCodePoolBlocksInsert(full));
    assert.equal(p.ctx.pastrimiBaseCodePoolBlocksInsert(minimal), status !== 'used');
    for (const draft of [remote, local, dbDraft]) {
      const oldVerdict = h.ctx.evaluateDraftCodePoolGuard(draft, { byCode: new Map([['201', full]]) });
      const newVerdict = h.ctx.evaluateDraftCodePoolGuard(draft, { byCode: new Map([['201', minimal]]) });
      for (const key of ['allow', 'reason', 'reassign', 'rehold', 'code']) {
        assert.equal(newVerdict[key], oldVerdict[key], `${status} / ${draft.source} / ${key}`);
      }
    }
  }
}

// Reserved remote drafts remain visible. Used remote ghosts stay hidden,
// whereas meaningful local and database-backed drafts survive for reassignment.
{
  const h = makeDraftHarness({ rows: [project(row(201, 'reserved'))] });
  const result = await h.ctx.filterDraftSummariesAgainstDb([remote, local, dbDraft]);
  assert.deepEqual(Array.from(result, x => x.id), ['db-draft', 'local-draft', 'remote-draft']);
  assert.equal(h.calls.reads.length, 1, 'one batch read for the draft list');
  assert.deepEqual(h.calls.reads[0], [201], 'duplicate codes share the same read');
  assert.equal(h.calls.readOptions[0]?.draft, undefined, 'listing never requests a reservation owner');
  assert.equal(h.calls.renewed.length, 0);
  assert.equal(h.calls.deleted.length, 0);
}

// Opening a shared draft needs its exact DB reservation owner. The active
// worker and stale saved metadata must not replace that owner and allocate a
// second code. Only this one-draft open path requests owner context.
{
  const shared = {
    ...dbDraft, id: 'shared-summary', local_oid: 'shared-local-draft',
    name: 'Example client', draft_lifecycle: { pin: '900003', code: 201 },
  };
  const ownedRow = {
    ...project(row(201, 'reserved')),
    reserved_by: '900001', draft_session_id: 'shared-local-draft',
  };
  const h = makeDraftHarness({ rows: [ownedRow] });
  await h.ctx.loadDraftIntoForm(shared);
  assert.equal(h.calls.opened.length, 1, 'shared draft reaches the existing open flow');
  assert.equal(h.calls.alerts.length, 0);
  assert.equal(h.calls.readOptions[0]?.draft?.code, 201);
  assert.equal(h.calls.readOptions[0]?.draft?.draft_session_id, 'shared-local-draft');
  const opened = h.calls.opened[0];
  assert.equal(opened.options.codePoolVerdict.row.reserved_by, '900001');
  h.ctx.oidRef.current = 'shared-local-draft';
  await h.ctx.verifyRestoredDraftCodeOrAllocate('shared-local-draft', 201, shared, shared.id, opened.options);
  assert.deepEqual(h.calls.allocated[0], ['900001', 'shared-local-draft', 201, true]);
  assert.equal(h.calls.writtenReservations[0].created_by_pin, '900001');
  assert.equal(h.calls.writtenReservations[0].opened_by_pin, '900002');

  for (const changed of [
    { draft_session_id: 'another-draft' }, { code: 202 }, { status: 'used' },
  ]) {
    const owner = h.ctx.resolveDraftCodeLifecyclePin({
      localOid: 'shared-local-draft', code: 201, fallbackPin: '900002', draft: {},
      poolRow: { ...ownedRow, ...changed },
    });
    assert.equal(owner, '900002', 'unrelated code/draft/status cannot supply an owner');
  }

  const bulk = makeDraftHarness();
  await bulk.ctx.fetchBaseCodePoolRowsForDrafts([shared, local], { includeDraftOwner: true });
  assert.equal(bulk.calls.readOptions[0]?.draft, undefined, 'bulk reads never request owner context');
}

// Older remote payloads can carry identity only inside data. The summary's id
// remains the form's fallback id and must also be used for the scoped lookup.
{
  const id = 'remote-nested-identity';
  const h = makeDraftHarness({
    rows: [{ ...project(row(201, 'reserved')), reserved_by: '900001', draft_session_id: id }],
    remoteDraft: { name: 'Example client', data: { code: 201, local_oid: id } },
  });
  await h.ctx.loadDraftIntoForm({ id, code: 201, source: 'REMOTE', file_key: id });
  assert.equal(h.calls.opened.length, 1);
  assert.equal(h.calls.opened[0].draft.id, undefined, 'fixture exercises the legacy fallback');
  assert.equal(h.calls.opened[0].id, id);
  assert.equal(h.calls.readOptions[0]?.draft?.draft_session_id, id);
  h.ctx.oidRef.current = id;
  await h.ctx.verifyRestoredDraftCodeOrAllocate(id, 201, h.calls.opened[0].draft, id, h.calls.opened[0].options);
  assert.deepEqual(h.calls.allocated[0], ['900001', id, 201, true]);
  assert.equal(h.calls.alerts.length, 0);
}
{
  const h = makeDraftHarness({ rows: [project(row(201, 'used'))] });
  const pool = await h.ctx.fetchBaseCodePoolRowsForDrafts([remote, local, dbDraft]);
  assert.equal(h.ctx.evaluateDraftCodePoolGuard(remote, pool).allow, false);
  for (const draft of [local, dbDraft]) {
    const verdict = h.ctx.evaluateDraftCodePoolGuard(draft, pool);
    assert.equal(verdict.allow, true);
    assert.equal(verdict.reassign, true, 'saved draft cannot reuse a finalized code');
  }
  const result = await h.ctx.filterDraftSummariesAgainstDb([remote, local, dbDraft]);
  assert.deepEqual(Array.from(result, x => x.id), ['db-draft', 'local-draft']);
  assert.deepEqual(h.calls.deleted, [], 'hiding a remote ghost never deletes local draft data');
  assert.deepEqual(h.calls.reservationDeleted, []);
  assert.equal(h.calls.renewed.length, 0, 'used codes are not renewed');
}

// An available code may be re-held by a database draft or a matching local
// reservation. A reservation for another code never authorizes the current one.
{
  const h = makeDraftHarness({ rows: [project(row(201, 'available'))] });
  h.storage.set('pranimi_draft_reservation:local-draft', JSON.stringify({ code: 201, has_meaningful_work: true }));
  const pool = await h.ctx.fetchBaseCodePoolRowsForDrafts([local, dbDraft]);
  assert.equal(h.ctx.evaluateDraftCodePoolGuard(local, pool).rehold, true);
  assert.equal(h.ctx.evaluateDraftCodePoolGuard(dbDraft, pool).rehold, true);
  const result = await h.ctx.filterDraftSummariesAgainstDb([remote, local, dbDraft]);
  assert.deepEqual(Array.from(result, x => x.id), ['db-draft', 'local-draft']);
  assert.equal(h.calls.renewed.length, 2);
  h.storage.set('pranimi_draft_reservation:local-draft', JSON.stringify({ code: 202, has_meaningful_work: true }));
  assert.equal(h.ctx.evaluateDraftCodePoolGuard(local, pool).reassign, true);
}

// Network and authorization failures remain uncertain, not authoritative
// empty results. Local and DB drafts stay intact; remote-only drafts fail closed.
for (const code of ['NETWORK_TIMEOUT', 'AUTH_REQUIRED', 'DEVICE_NOT_APPROVED']) {
  const h = makeDraftHarness({ error: Object.assign(new Error(code), { code }) });
  const pool = await h.ctx.fetchBaseCodePoolRowsForDrafts([local, remote, dbDraft]);
  assert.equal(pool.ok, false);
  assert.equal(pool.uncertain, true);
  assert.equal(h.ctx.evaluateDraftCodePoolGuard(local, pool).allow, true);
  assert.equal(h.ctx.evaluateDraftCodePoolGuard(dbDraft, pool).allow, true);
  assert.equal(h.ctx.evaluateDraftCodePoolGuard(remote, pool).reason, 'CODE_POOL_UNCERTAIN_REMOTE_FAIL_CLOSED');
  const before = JSON.stringify([local, remote, dbDraft]);
  const result = await h.ctx.filterDraftSummariesAgainstDb([local, remote, dbDraft]);
  assert.deepEqual(Array.from(result, x => x.id), ['db-draft', 'local-draft']);
  assert.equal(JSON.stringify([local, remote, dbDraft]), before);
  assert.deepEqual(h.calls.deleted, []);
  assert.deepEqual(h.calls.reservationDeleted, []);
}
{
  const h = makeDraftHarness();
  const pool = await h.ctx.fetchBaseCodePoolRowsForDrafts([remote]);
  assert.equal(pool.ok, true);
  assert.equal(pool.uncertain, false, 'a genuine successful empty result is distinct from failure');
  assert.equal(h.ctx.evaluateDraftCodePoolGuard(remote, pool).reason, 'REMOTE_CODE_POOL_MISSING');
  assert.equal(h.ctx.evaluateDraftCodePoolGuard({ ...local, code: null }, pool).reassign, true);
}

// Invalid or absent codes do not send requests; large lists retain the existing
// 160-code bound. Conflicting duplicate rows choose the strongest used state.
{
  const h = makeDraftHarness();
  await h.ctx.fetchBaseCodePoolRowsForDrafts([{ code: null }, { code: 'T4' }, { code: 0 }, { code: -1 }]);
  assert.equal(h.calls.reads.length, 0);
  await h.ctx.fetchBaseCodePoolRowsForDrafts(Array.from({ length: 170 }, (_, i) => ({ code: i + 1 })));
  assert.equal(h.calls.reads[0].length, 160);
  const ranked = makeDraftHarness({ rows: [project(row(201, 'used')), project(row(201, 'reserved'))] });
  const pool = await ranked.ctx.fetchBaseCodePoolRowsForDrafts([local]);
  assert.equal(pool.byCode.get('201').status, 'used');
}

// Pastrimi keeps the status guard and exposes diagnostic lookup failures to its
// caller. This migration does not change its pre-existing repair decisions.
{
  for (const status of ['available', 'reserved', 'used']) {
    const h = makePastrimiHarness({ rows: [project(row(201, status))] });
    const result = await h.ctx.fetchPastrimiBaseCodePoolInfo(201);
    assert.equal(result.status, status);
    assert.equal(h.ctx.pastrimiBaseCodePoolBlocksInsert(result), status !== 'used');
    assert.deepEqual(h.calls, [[201]]);
    assert.equal(h.readOptions[0]?.draft, undefined, 'Pastrimi status diagnostics never request owner context');
  }
  const missing = makePastrimiHarness();
  assert.equal(await missing.ctx.fetchPastrimiBaseCodePoolInfo(201), null);
  const failed = makePastrimiHarness({ error: new Error('DEVICE_NOT_APPROVED') });
  const result = await failed.ctx.fetchPastrimiBaseCodePoolInfo(201);
  assert.equal(result.code, 201);
  assert.equal(result.lookup_error, 'DEVICE_NOT_APPROVED');
  assert.notEqual(result, null, 'a denied lookup remains diagnosable');
}

for (const [name, source] of [['Pranimi', pranimi], ['Pastrimi', pastrimi]]) {
  assert.doesNotMatch(source, /\.from\(\s*['"]base_code_pool['"]\s*\)/, `${name} cannot bypass the protected status endpoint`);
}
console.log('PASS base code status consumers: canonical projection, shared/legacy draft owner, retention, reassignment, errors, bounded reads and Pastrimi diagnostics');
