import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { createTransportDraftStorage } from '../lib/transportDraftStorage.js';
import { buildMonthlyPayrollPreview, matchesPayrollRecipient } from '../lib/payrollMonthClose.js';
import { createDispatchListLoader } from '../lib/dispatchList.js';
import { createIncidentDelivery, incidentKey, INCIDENT_PENDING_PREFIX } from '../lib/runtimeIncidentDelivery.js';

let passed = 0;
async function test(name, work) { await work(); passed++; console.log('PASS ' + name); }
function storage() {
  const map = new Map(); let scans = 0;
  return { map, get scans() { return scans; }, get length() { return map.size; }, key: i => { scans++; return [...map.keys()][i] ?? null; },
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
}
const draft = (id = 'draft-1', ts = 100) => ({ id, ts, transport_id: 'driver-a', codeRaw: 'T123', name: 'SYNTHETIC CLIENT',
  phone: '2025550100', phonePrefix: '+1', phoneFull: '12025550100', tepihaRows: [{ qty: 2, m2: 4 }], stazaRows: [],
  stairsQty: 3, stairsPer: 0.3, addressDesc: 'Test', gpsLat: '', gpsLng: '', clientPhotoUrl: '', notes: 'Keep', clientPaid: 10, pricePerM2: 1.8 });
function drafts(options = {}) {
  const indexedDB = new IDBFactory(), localStorage = storage();
  return { indexedDB, localStorage, create: extra => createTransportDraftStorage({ indexedDB, localStorage, timeoutMs: 100, ...options, ...extra }) };
}

await test('full localStorage saves complete draft in IndexedDB and survives reopening', async () => {
  const f = drafts(); f.localStorage.setItem('payment-outbox', 'KEEP');
  f.localStorage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  assert.equal((await f.create().save(draft())).ok, true);
  assert.deepEqual(await f.create().list('driver-a'), [draft()]);
  assert.equal(f.localStorage.getItem('payment-outbox'), 'KEEP');
});
await test('draft capture is immutable while asynchronous storage is pending', async () => {
  const f = drafts(), row = draft(), q = f.create(), saving = q.save(row); row.notes = 'changed later';
  await saving; assert.equal((await q.list())[0].notes, 'Keep');
});
await test('serial and cross-tab stale autosaves cannot replace newer fields', async () => {
  const f = drafts(), a = f.create(), b = f.create();
  await a.save(draft('draft-1', 200));
  assert.equal((await b.save({ ...draft(), notes: 'stale' })).skipped, true);
  assert.equal((await b.list())[0].ts, 200);
});
await test('reads retain legacy indexed and orphan drafts, scoped to the right driver', async () => {
  const f = drafts();
  f.localStorage.setItem('transport_draft_orders_v1', JSON.stringify(['draft-1']));
  f.localStorage.setItem('transport_draft_order_draft-1', JSON.stringify(draft()));
  f.localStorage.setItem('transport_draft_order_orphan', JSON.stringify(draft('orphan')));
  f.localStorage.setItem('transport_draft_order_other', JSON.stringify({ ...draft('other'), transport_id: 'driver-b' }));
  const before = [...f.localStorage.map];
  assert.equal((await f.create().list('driver-a')).length, 2);
  assert.deepEqual([...f.localStorage.map], before);
});
await test('newest IndexedDB draft overrides legacy without destroying the original', async () => {
  const f = drafts(), q = f.create();
  f.localStorage.setItem('transport_draft_order_draft-1', JSON.stringify(draft()));
  await q.save({ ...draft('draft-1', 200), phonePrefix: '+44', notes: 'new' });
  const list = await q.list(); assert.equal(list.length, 1); assert.equal(list[0].notes, 'new');
  assert.equal(list[0].phonePrefix, '+44'); assert(f.localStorage.getItem('transport_draft_order_draft-1'));
});
await test('corrupt legacy index does not hide intact draft entries', async () => {
  const f = drafts();
  f.localStorage.setItem('transport_draft_orders_v1', '{bad json');
  f.localStorage.setItem('transport_draft_order_draft-1', JSON.stringify(draft()));
  assert.deepEqual(await f.create().list(), [draft()]);
  assert.equal(f.localStorage.getItem('transport_draft_orders_v1'), '{bad json');
});
await test('cleanup tombstone prevents stale autosave and legacy resurrection', async () => {
  const f = drafts(), q = f.create();
  f.localStorage.setItem('transport_draft_order_draft-1', JSON.stringify(draft()));
  await q.save(draft()); await q.remove('draft-1');
  // Simulate old tab writing its pre-completion snapshot back to legacy storage.
  f.localStorage.setItem('transport_draft_order_draft-1', JSON.stringify(draft()));
  assert.equal((await f.create().save(draft())).skipped, true);
  assert.deepEqual(await f.create().list(), []);
});
await test('completion also blocks a newer autosave from a second tab and a newer legacy copy', async () => {
  const f = drafts(), first = f.create(), second = f.create();
  await first.save(draft()); await first.remove('draft-1');
  const later = { ...draft('draft-1', Date.now() + 60000), notes: 'late second tab' };
  assert.equal((await second.save(later)).skipped, true);
  f.localStorage.setItem('transport_draft_order_draft-1', JSON.stringify(later));
  assert.deepEqual(await second.list(), []);
});
await test('a later explicit edit saves independently without reopening the completed create', async () => {
  const f = drafts(), q = f.create(); await q.save(draft()); await q.remove('draft-1');
  const edit = { ...draft('draft-1:edit:session-2', Date.now()), orderId: 'draft-1' };
  await q.save(edit); assert.deepEqual(await f.create().list(), [edit]);
  await q.remove(edit.id); assert.deepEqual(await q.list(), []);
});
await test('transaction abort rejects the save, preserves earlier committed work, and allows retry', async () => {
  const f = drafts(), q = f.create(); await q.save(draft());
  const req = f.indexedDB.open('tepiha-transport-drafts-v2', 1);
  const db = await new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = reject; });
  const proto = Object.getPrototypeOf(db), original = proto.transaction;
  proto.transaction = function (...args) {
    const tx = original.apply(this, args);
    if (args[1] === 'readwrite') queueMicrotask(() => tx.abort());
    return tx;
  };
  try { await assert.rejects(q.save({ ...draft('draft-1', 200), notes: 'uncommitted' })); }
  finally { proto.transaction = original; db.close(); }
  assert.equal((await q.list())[0].notes, 'Keep');
  await q.save({ ...draft('draft-1', 300), notes: 'retry' });
  assert.equal((await q.list())[0].notes, 'retry');
});
await test('unavailable IndexedDB preserves legacy work without exposing possibly completed copies', async () => {
  const f = drafts(), q = f.create({ indexedDB: null });
  f.localStorage.setItem('transport_draft_order_draft-1', JSON.stringify(draft()));
  await assert.rejects(q.save(draft()), /UNAVAILABLE/);
  await assert.rejects(q.list(), /UNAVAILABLE/);
  assert.equal(f.localStorage.getItem('transport_draft_order_draft-1'), JSON.stringify(draft()));
});
await test('hung IndexedDB open returns a bounded failure and can be retried', async () => {
  const f = drafts(), q = f.create({ indexedDB: { open: () => ({}) }, timeoutMs: 5 });
  await assert.rejects(q.save(draft()), /TIMEOUT/);
  await assert.rejects(q.save(draft()), /TIMEOUT/);
});

const page = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const persistSource = page.slice(page.indexOf('  async function persistDraft('), page.indexOf('  // Base worker bridge'));
await test('page reports a failed draft honestly and does not acknowledge uncommitted storage', async () => {
  let error = '', finish;
  const ctx = vm.createContext({ isEdit: false, getCurrentDraftStorageKey: id => id, completedDraftsRef: { current: new Set() }, setDraftError: value => { error = value; },
    upsertDraftLocal: () => new Promise(resolve => { finish = resolve; }) });
  vm.runInContext(persistSource, ctx);
  let done = false; const pending = ctx.persistDraft(draft()).then(value => { done = true; return value; });
  await Promise.resolve(); assert.equal(done, false);
  finish({ skipped: true }); assert.equal(await pending, false); assert.match(error, /NUK U RUAJT/);
  ctx.upsertDraftLocal = async () => ({ ok: true });
  assert.equal(await ctx.persistDraft(draft()), true); assert.equal(error, '');
});
await test('page blocks completed draft autosave and awaits every fallback save', async () => {
  const ctx = vm.createContext({ isEdit: false, getCurrentDraftStorageKey: id => id, completedDraftsRef: { current: new Set(['draft-1']) }, setDraftError: () => {}, upsertDraftLocal: () => assert.fail('resurrected') });
  vm.runInContext(persistSource, ctx); assert.equal(await ctx.persistDraft(draft()), false);
  assert.match(page, /const nextSnapshot = JSON.stringify\(\{ \.\.\.draftPayload, ts: 0 \}\)/);
  assert.match(page, /phone, phonePrefix, tepihaRows/);
  assert.match(page, /void removeDraftLocal\(completedDraftKey\)\.catch/);
  assert.match(page, /draftSaved \? 'S’MORI T-KOD/);
  assert.match(page, /draftSaved \? "⚠️ RUJTJA NË SERVER/);
  assert.equal((page.match(/upsertDraftLocal\(/g) || []).length, 2, 'only wrapper and guarded persist helper call low-level storage');
});
await test('edit draft keys are stable within an editor, fresh on re-entry and preserve server identity', async () => {
  const identitySource = page.slice(page.indexOf('  function getCurrentDraftStorageKey('), page.indexOf('  async function persistDraft('));
  let nonce = 0, saved;
  const ctx = vm.createContext({ oid: 'server-order', isEdit: true, crypto: { randomUUID: () => String(++nonce) },
    editDraftKeyRef: { current: { orderId: '', key: '' } }, completedDraftsRef: { current: new Set() }, setDraftError: () => {},
    upsertDraftLocal: async row => { saved = row; return { ok: true }; } });
  vm.runInContext(identitySource + persistSource, ctx);
  const first = ctx.getCurrentDraftStorageKey(); assert.equal(ctx.getCurrentDraftStorageKey(), first);
  await ctx.persistDraft(draft('server-order'));
  assert.equal(saved.id, first); assert.equal(saved.orderId, 'server-order');
  ctx.editDraftKeyRef.current = { orderId: '', key: '' };
  assert.notEqual(ctx.getCurrentDraftStorageKey(), first);
  const rows = [{ id: 'create' }, { id: first, orderId: 'server-order' }, { id: 'other', orderId: 'other-order' }];
  assert.deepEqual(Array.from(ctx.visibleDrafts(rows), row => row.id), [first]);
  ctx.isEdit = false; assert.equal(ctx.getCurrentDraftStorageKey('create'), 'create');
  assert.deepEqual(Array.from(ctx.visibleDrafts(rows), row => row.id), ['create']);
  assert.match(page, /setOid\(d.orderId \|\| d.id\)/);
});
await test('a pre-upgrade edit draft is recoverable only in its matching order editor', async () => {
  const identitySource = page.slice(page.indexOf('  function getCurrentDraftStorageKey('), page.indexOf('  async function persistDraft('));
  const restoreSource = page.slice(page.indexOf('  function loadDraft('), page.indexOf('  async function deleteDraft('));
  let restoredId = '', restoredNotes = '';
  const ctx = vm.createContext({ oid: 'server-order', isEdit: true, phonePrefix: '+1', PRICE_DEFAULT: 1.8, SHKALLORE_M2_PER_STEP_DEFAULT: 0.3,
    editDraftKeyRef: { current: { orderId: 'server-order', key: 'fresh-edit-key' } }, priceSourceRef: { current: 'new' },
    splitTransportPhoneForForm: () => ({ prefix: '+1', local: '2025550100' }), setOid: id => { restoredId = id; }, setNotes: notes => { restoredNotes = notes; } });
  for (const setter of ['setCodeRaw', 'setName', 'setPhonePrefix', 'setPhone', 'setTepihaRows', 'setStazaRows', 'setClientPaid', 'setPricePerM2', 'setPriceTmp', 'setStairsQty', 'setStairsPer', 'setAddressDesc', 'setGpsLat', 'setGpsLng', 'setClientPhotoUrl', 'setCurrentStep', 'setShowDraftsSheet']) ctx[setter] = () => {};
  vm.runInContext(identitySource + restoreSource, ctx);
  const legacy = draft('server-order');
  assert.deepEqual(Array.from(ctx.visibleDrafts([legacy, draft('unrelated')]), row => row.id), ['server-order']);
  ctx.loadDraft(legacy); assert.equal(restoredId, 'server-order'); assert.equal(restoredNotes, 'Keep');
  assert.equal(ctx.editDraftKeyRef.current.key, 'fresh-edit-key', 'next autosave uses a fresh edit operation, not the legacy create key');
  ctx.loadDraft(draft('unrelated')); assert.equal(restoredId, 'server-order');
});

const worker = (pin, name) => ({ pin, name, role: 'PUNTOR', salary: 1000 });
const workers = [worker('a', 'OPERATOR'), worker('b', 'RECIPIENT B'), worker('c', 'RECIPIENT C')];
const advance = (pin, name, amount, day) => ({ type: 'ADVANCE', status: 'ADVANCE', amount,
  created_at: `2026-09-${day}T10:00:00Z`, created_by_pin: pin, created_by_name: name,
  approved_by_pin: 'a', approved_by_name: 'OPERATOR', handed_by_pin: 'a', handed_by_name: 'OPERATOR' });
await test('three reported advances deduct 300/100 from recipients, never 400 from the operator', async () => {
  const rows = [advance('b', 'RECIPIENT B', 100, '10'), advance('b', 'RECIPIENT B', 200, '14'), advance('c', 'RECIPIENT C', 100, '17')];
  const before = structuredClone(rows);
  const result = buildMonthlyPayrollPreview({ workers, paymentRows: rows, month: '2026-09' });
  assert.deepEqual(result.map(r => r.advancesTotal), [0, 300, 100]);
  assert.deepEqual(result.map(r => r.net), [1000, 700, 900]);
  assert.deepEqual(rows, before);
});
await test('earlier recipient advance and manual advances remain counted exactly once', async () => {
  const result = buildMonthlyPayrollPreview({ workers: workers.map(w => ({ ...w, avans_manual: 5 })),
    paymentRows: [advance('c', 'RECIPIENT C', 500, '04'), advance('c', 'RECIPIENT C', 100, '17')], month: '2026-09' });
  assert.deepEqual(result.map(r => r.advancesTotal), [5, 5, 605]);
});
await test('recipient PIN cannot alias to another worker with the same name', async () => {
  assert.equal(matchesPayrollRecipient(advance('b', 'OPERATOR', 100, '10'), workers[0]), false);
  assert.equal(matchesPayrollRecipient(advance('b', 'WRONG NAME', 100, '10'), workers[1]), true);
});
await test('legacy recipient name is allowed only without a recipient PIN; approver never substitutes', async () => {
  assert.equal(matchesPayrollRecipient({ created_by_name: ' recipient b ', approved_by_pin: 'a' }, workers[1]), true);
  assert.equal(matchesPayrollRecipient({ approved_by_pin: 'a', approved_by_name: 'OPERATOR' }, workers[0]), false);
});

await test('personal-account debt list excludes advances handed to somebody else', async () => {
  const source = fs.readFileSync('lib/corporateFinance.js', 'utf8');
  const work = source.slice(source.indexOf('export async function listWorkerDebtRows('), source.indexOf('// ARKA RPC-only submit contract', source.indexOf('export async function listWorkerDebtRows('))).replace('export ', '');
  const own = { ...advance('a', 'OPERATOR', 20, '05'), id: 1 };
  const other = { ...advance('b', 'RECIPIENT B', 400, '10'), id: 2 };
  const debt = { ...other, id: 3, status: 'OWED', type: 'PAYMENT', amount: 30 };
  const ctx = vm.createContext({ clean: value => String(value || '').trim(), matchesPayrollRecipient,
    PENDING_CASH_TABLE: 'payments', LEDGER_TABLE: 'ledger', uniqueById: rows => [...new Map(rows.map(row => [row.id, row])).values()],
    ledgerMatchesWorkerAdvance: () => false,
    supabase: { from: table => {
      let field;
      const q = { select: () => q, eq: name => { field = name; return q; }, in: () => q, order: () => q,
        limit: () => Promise.resolve({ data: table === 'ledger' ? [] : field === 'created_by_pin' ? [own] : [own, other, debt] }) };
      return q;
    } } });
  vm.runInContext(work, ctx);
  const rows = await ctx.listWorkerDebtRows('a');
  assert.deepEqual(Array.from(rows, row => row.id).sort(), [1, 3]);
});

function listFixture() {
  let release, calls = 0, rows = [];
  const blocked = new Promise(resolve => { release = resolve; });
  const loader = createDispatchListLoader({ getActorId: () => 'actor', onBusy: () => {}, onError: () => {}, onRows: fn => { rows = fn(rows); },
    fetchRows: async () => { calls++; return calls === 1 ? blocked : [{ id: 'new', updated_at: '2026-09-19T10:00:00Z' }]; } });
  return { loader, release, get calls() { return calls; }, get rows() { return rows; } };
}
await test('focus/pageshow/visibility/poll storm shares one in-flight list request', async () => {
  const f = listFixture(), first = f.loader.refresh(); await Promise.resolve();
  for (let i = 0; i < 20; i++) f.loader.refresh({ followUp: false });
  f.release([]); await first; assert.equal(f.calls, 1); f.loader.stop();
});
await test('realtime or post-create refresh still runs after an ambient refresh', async () => {
  const f = listFixture(), first = f.loader.refresh({ followUp: false }); await Promise.resolve();
  f.loader.refresh({ followUp: false }); f.loader.refresh(); f.loader.refresh({ followUp: false });
  f.release([]); await first; assert.equal(f.calls, 2); assert.equal(f.rows[0].id, 'new'); f.loader.stop();
});

const body = n => ({ bootId: 'synthetic', incidentType: 'window_error', currentPath: '/dispatch', lastEventType: 'error', lastEventAt: '2026-09-19T10:00:' + n });
await test('diagnostics scans origin keys once, not on every send or idle flush', async () => {
  const s = storage(); for (let i = 0; i < 1000; i++) s.setItem('business-' + i, 'KEEP');
  const q = createIncidentDelivery({ storage: s, online: () => false }); await q.flush();
  const first = s.scans; assert.equal(first, 1000);
  for (let i = 0; i < 20; i++) { await q.send(body(i)); await q.flush(); }
  assert.equal(s.scans, first); assert.equal(s.getItem('business-999'), 'KEEP'); q.dispose();
});
await test('storage events restore another tab pending report without a full origin scan', async () => {
  const s = storage(); let listener, calls = 0;
  const events = { addEventListener: (_, fn) => { listener = fn; }, removeEventListener: () => {} };
  const q = createIncidentDelivery({ storage: s, storageEvents: events, fetcher: async () => { calls++; return { ok: true, json: async () => ({ ok: true, stored: true }) }; } });
  await q.flush(); const name = INCIDENT_PENDING_PREFIX + incidentKey(body(1)), raw = JSON.stringify(body(1));
  s.setItem(name, raw); listener({ key: name, newValue: raw, storageArea: s });
  await q.flush(); assert.equal(calls, 1); assert.equal(s.scans, 0); assert.equal(s.getItem(name), null); q.dispose();
});
await test('other-tab pending entries still enforce the shared capacity budget', async () => {
  const s = storage(); let listener;
  const q = createIncidentDelivery({ storage: s, online: () => false, storageEvents: { addEventListener: (_, fn) => { listener = fn; } } });
  await q.flush();
  for (let i = 0; i < 40; i++) listener({ key: INCIDENT_PENDING_PREFIX + incidentKey(body(i)), newValue: JSON.stringify(body(i)), storageArea: s });
  assert.equal((await q.send(body(99))).reason, 'INCIDENT_QUEUE_CAPACITY'); q.dispose();
});
console.log(`Dispatch / drafts / payroll: ${passed} regression checks passed.`);
