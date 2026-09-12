import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('app/transport/board/page.jsx', 'utf8');
const helpers = source.slice(source.indexOf('const TRANSPORT_BOARD_CACHE_VERSION'), source.indexOf('function cleanBoardTransportName'));
const start = source.indexOf('  const load = useCallback(async (opts = {}) => {');
const end = source.indexOf('  }, [session]);', start);
assert(start > 0 && end > start, 'Transport board loader must exist');
const loader = source.slice(start, end).replace('const load = useCallback(', 'var load = ') + '};';
const done = { id: 'synthetic-delivered', status: 'done', client_tcode: 'T101', data: { delivered_at: new Date().toISOString() } };
const active = { id: 'synthetic-assigned', status: 'assigned', client_tcode: 'T102' };

function harness({ rows = [done], query, rest = async () => { throw Error('unexpected REST'); } } = {}) {
  const state = { rows, errors: [], writes: [], restCalls: 0, queries: 0, logs: [] };
  const guard = { current: { active: false, seq: 0, lastStartAt: 0, lastSuccessAt: 0 } };
  const refs = { current: rows };
  const ctx = vm.createContext({
    AbortController, URL, Date, setTimeout: () => 1, clearTimeout() {},
    window: { setTimeout: () => 1 }, console: { error() {} },
    BOARD_SUCCESS_REFRESH_COOLDOWN_MS: 45000, BOARD_FETCH_LIMIT: 80,
    loadGuardRef: guard, boardDiagRef: { current: {} }, itemsRef: refs, session: { role: 'DISPATCH', id: 'synthetic-actor' },
    boardDiagMeta: x => x, bootLog: (event, meta) => state.logs.push({ event, meta }),
    setItems: rows => { state.rows = rows; refs.current = rows; }, setLoading() {}, setLoadError: e => state.errors.push(e),
    getTransportSession: () => ({ role: 'DISPATCH', id: 'synthetic-actor' }), deriveTid: () => 'synthetic-actor', canAccessTransportAdmin: () => true,
    getMasterCacheKey: () => 'synthetic-cache', localStorage: { getItem: () => null },
    startTransition: fn => fn(), scheduleCacheWrite: (_key, rows) => state.writes.push(rows),
    startOfTodayIso: () => new Date().toISOString(), getDeliveredTs: row => row.data?.delivered_at,
    isSameDayIso: () => true, getBoardResumeSafeDelay: x => x, translateBoardError: e => e.message,
    SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'synthetic',
    listTransportOrders: async args => { state.queries++; return query(args, state.queries, guard); },
    fetch: async (...args) => { state.restCalls++; return rest(...args); },
  });
  vm.runInContext(helpers + '\n' + loader, ctx);
  return { state, guard, load: () => ctx.load({ force: true }) };
}
const failures = []; let passed = 0;
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }

await test('delivered query failure retains last rows and reports stale data', async () => {
  const h = harness({ query: async (_args, n) => { if (n === 2) throw Error('TRANSPORT_BOARD_DONE_TIMEOUT'); return [active]; } });
  await h.load();
  assert.deepEqual(h.state.rows.map(x => x.id), [done.id]);
  assert(h.state.errors.at(-1)); assert.equal(h.state.writes.length, 0); assert.equal(h.guard.current.lastSuccessAt, 0);
});
await test('first load with failed delivered query reports failure instead of successful empty history', async () => {
  const h = harness({ rows: [], query: async (_args, n) => { if (n === 2) throw Error('TRANSPORT_BOARD_DONE_TIMEOUT'); return []; } });
  await h.load(); assert(h.state.errors.at(-1)); assert.equal(h.guard.current.lastSuccessAt, 0);
});
await test('aborted primary query never starts a REST fallback', async () => {
  const h = harness({ query: async (_args, _n, guard) => { guard.current.abortController.abort(); throw Error('AbortError'); }, rest: async () => ({ ok: true, json: async () => [active] }) });
  await h.load(); assert.equal(h.state.restCalls, 0); assert.equal(h.state.writes.length, 0);
});
await test('late successful query after navigation cannot overwrite cached rows', async () => {
  const h = harness({ query: async (_args, n, guard) => { if (n === 2) guard.current.abortController.abort(); return n === 1 ? [active] : []; } });
  await h.load(); assert.deepEqual(h.state.rows.map(x => x.id), [done.id]); assert.equal(h.state.writes.length, 0);
});
await test('obsolete load cannot clear a newer load guard', async () => {
  const h = harness({ query: async (_args, _n, guard) => { guard.current.seq++; guard.current.abortController.abort(); guard.current.abortController = new AbortController(); throw Error('obsolete'); } });
  await h.load(); assert.equal(h.guard.current.active, true); assert.equal(h.state.restCalls, 0); assert.equal(h.state.writes.length, 0);
});
await test('successful query keeps both active and delivered visits', async () => {
  const h = harness({ query: async (_args, n) => n === 1 ? [active] : [done] });
  await h.load(); assert.deepEqual(Array.from(h.state.rows, x => x.id), [active.id, done.id]);
  assert.equal(h.state.errors.at(-1), ''); assert.equal(h.state.writes.length, 1); assert(h.guard.current.lastSuccessAt > 0);
});
await test('verified empty response clears previous rows', async () => {
  const h = harness({ query: async () => [] }); await h.load();
  assert.equal(h.state.rows.length, 0); assert.equal(h.state.errors.at(-1), ''); assert.equal(h.state.writes.length, 1);
});
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
console.log(`${passed} passed; ${failures.length} failed: Transport board recovery v3`);
