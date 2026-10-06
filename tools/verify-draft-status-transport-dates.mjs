import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { runPranimiDraftDbAction } from '../lib/pranimiDraftDb.js';
import { isPranimiArchivedOrder, isPranimiFinalOrderRow } from '../lib/pranimiOrderLifecycle.js';

// Synthetic storage only: never connects to a database or sends messages.
const clone = value => structuredClone(value);
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
function declarations(file, names) {
  const source = fs.readFileSync(file, 'utf8');
  const nodes = parse(source, { sourceType: 'module', plugins: ['jsx'] }).program.body;
  return names.map(name => {
    const node = nodes.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
    assert.ok(node, name);
    return source.slice(node.start, node.end);
  }).join('\n');
}
const draft = () => ({ id: 1, local_oid: 'synthetic-draft', code: 42, status: 'pranim', updated_at: 'v1', data: { status: 'incomplete', pranimi_db_draft: true } });
function storage(initial = null, { race = false, fail = false } = {}) {
  const state = { row: clone(initial), writes: [] };
  const sb = { from(table) {
    assert.equal(table, 'orders');
    let op = 'select', payload, filters = [];
    const query = {
      select() { return this; }, order() { return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      filter(key, comparator, value) { assert.equal(comparator, 'eq'); return this.eq(key, value); },
      insert(value) { op = 'insert'; payload = value; return this; },
      update(value) { op = 'update'; payload = value; return this; },
      limit() { return Promise.resolve(execute(false)); },
      maybeSingle() { return Promise.resolve(execute(true)); },
    };
    function execute(single) {
      if (op !== 'select') {
        state.writes.push(clone(payload));
        if (fail) return { data: null, error: new Error('synthetic write denied') };
        if (!['pranim', 'pastrim', 'gati', 'dorzim', 'transport'].includes(payload.status)) {
          return { data: null, error: Object.assign(new Error('orders_status_check'), { code: '23514' }) };
        }
        if (race) state.row = { ...draft(), status: 'gati', updated_at: 'v2', data: { status: 'gati' } };
      }
      const matches = state.row && filters.every(([key, value]) => {
        const keys = key.split(/->>?/);
        return keys.reduce((v, k) => v?.[k], state.row) === value;
      });
      if (op === 'insert') {
        if (state.row) return { data: null, error: new Error('duplicate local_oid') };
        state.row = { ...clone(payload), id: 1 };
      } else if (op === 'update' && matches) state.row = { ...state.row, ...clone(payload) };
      const row = (op === 'insert' || matches) ? clone(state.row) : null;
      return { data: single ? row : (row ? [row] : []), error: null };
    }
    return query;
  } };
  return { state, sb };
}
const browserCode = declarations('app/pranimi/page.jsx', [
  'normalizePranimiOrderStatus', 'isPranimiDraftLikeOrderStatus', 'isPranimiDbDraftFlaggedOrder',
  'readPranimiDbDraftPreferredStatus', 'readPranimiDraftOrderStatus', 'isBlockingPranimiDraftOrder',
  'buildPranimiDbDraftRowForTopStatus', 'safeDirectPranimiDraftWrite',
]);
function browserWriter(store) {
  const source = fs.readFileSync('app/pranimi/page.jsx', 'utf8');
  const constants = source.match(/const PRANIMI_DB_DRAFT[^\n]+/g).join('\n');
  const ctx = vm.createContext({ supabase: store.sb, PRANIMI_DRAFT_ORDER_SELECT: '*',
    PRANIMI_DRAFT_LIKE_STATUSES: new Set(['incomplete', 'draft']),
    readPlainObject: value => value || {}, isPranimiArchivedOrder, isPranimiFinalOrderRow,
    findBaseOrderByLocalOidAny: async () => ({ row: clone(store.state.row) }),
  });
  vm.runInContext(constants + '\n' + browserCode, ctx);
  return input => ctx.safeDirectPranimiDraftWrite(input);
}
for (const mode of ['server', 'browser']) {
  const writer = store => mode === 'server'
    ? input => runPranimiDraftDbAction({ row: input }, { supabase: store.sb })
    : browserWriter(store);
  for (const existing of [null, draft()]) await check(`${mode}: ${existing ? 'update' : 'insert'} draft succeeds in one valid write`, async () => {
    const store = storage(existing);
    const result = await writer(store)(draft());
    assert.equal(result.ok, true);
    assert.equal(store.state.writes.length, 1);
    assert.equal(store.state.row.status, 'pranim');
    assert.equal(store.state.row.data.status, 'incomplete');
    assert.equal(store.state.row.data.pranimi_db_draft, true);
  });
  await check(`${mode}: completed order blocks stale autosave`, async () => {
    const store = storage({ ...draft(), status: 'pastrim', data: { status: 'pastrim' } });
    assert.equal((await writer(store)(draft())).ok, false);
    assert.equal(store.state.writes.length, 0);
  });
  for (const existing of [null, draft()]) await check(`${mode}: concurrent final ${existing ? 'update' : 'insert'} cannot be overwritten`, async () => {
    const store = storage(existing, { race: true });
    assert.equal((await writer(store)(draft())).ok, false);
    assert.equal(store.state.row.status, 'gati');
    assert.equal(store.state.writes.length, 1);
  });
  await check(`${mode}: write failure does not claim success or retry an invalid status`, async () => {
    const store = storage(draft(), { fail: true });
    if (mode === 'server') await assert.rejects(writer(store)(draft()), /synthetic write denied/);
    else assert.equal((await writer(store)(draft())).ok, false);
    assert.equal(store.state.writes.length, 1);
  });
}

const transportCode = declarations('app/marrje-sot/page.jsx', ['todayKey', 'startOfLocalDay', 'endOfLocalDay', 'toMs', 'parseData', 'pickEventTs', 'hasPickupEventStamp', 'sameLocalDay', 'fetchTransportRowsForDate']);
function transportHarness(records = [], { fail = false } = {}) {
  const calls = [];
  const ctx = vm.createContext({ TRANSPORT_QUERY_LIMIT: 360, cleanText: (v, fallback) => String(v || fallback || '').trim(),
    buildRowsForDate: rows => rows,
    supabase: { from(table) {
      assert.equal(table, 'transport_orders');
      let filter = '';
      const run = (start, end) => {
        calls.push({ filter, start, end });
        if (fail) return { data: null, error: new Error('synthetic read denied') };
        const clauses = [...filter.matchAll(/and\(data->>(\w+)\.gte\.([^,]+),data->>\w+\.lt\.([^\)]+)\)/g)];
        assert.equal(clauses.length, 4, 'query must use all four JSON event fields');
        const matches = records.filter(row => clauses.some(([, key, min, max]) => row.data[key] >= min && row.data[key] < max));
        return { data: matches.slice(start, end + 1), error: null };
      };
      return { select() { return this; }, or(v) { filter = v; return this; }, order() { return this; },
        range(start, end) { return Promise.resolve(run(start, end)); },
        limit(n) { return Promise.resolve(run(0, n - 1)); },
      };
    } },
  });
  vm.runInContext(transportCode, ctx);
  return { ctx, calls };
}
await check('transport: JSON ISO/Postgres stamps and all completion fields are found', async () => {
  const rows = ['delivered_at', 'completed_at', 'done_at', 'picked_up_at'].map((key, id) => ({ id, status: 'done', data: { [key]: id % 2 ? '2026-10-05 12:00:00.123456+00' : '2026-10-05T12:00:00.123Z' } }));
  const { ctx, calls } = transportHarness(rows);
  assert.equal((await ctx.fetchTransportRowsForDate('2026-10-05')).length, 4);
  assert.equal(calls.length, 1);
  assert.equal(ctx.toMs('2026-10-05 12:00:00.123456+00'), Date.parse('2026-10-05T12:00:00.123Z'));
});
await check('transport: exact local midnight boundaries and edits do not invent deliveries', async () => {
  const { ctx } = transportHarness();
  const start = ctx.startOfLocalDay('2026-10-05').getTime();
  const end = ctx.endOfLocalDay('2026-10-05').getTime();
  const rows = [start - 1, start, end - 1, end].map((ms, id) => ({ id, status: 'done', data: { done_at: new Date(ms).toISOString() } }));
  rows.push({ id: 9, status: 'done', updated_at: new Date(start).toISOString(), data: {} });
  const test = transportHarness(rows);
  assert.deepEqual(Array.from(await test.ctx.fetchTransportRowsForDate('2026-10-05'), r => r.id), [1, 2]);
});
await check('transport: more than one page preserves older matching visits', async () => {
  const rows = Array.from({ length: 361 }, (_, id) => ({ id, status: 'done', data: { done_at: '2026-10-05T12:00:00.000Z' } }));
  const { ctx, calls } = transportHarness(rows);
  assert.equal((await ctx.fetchTransportRowsForDate('2026-10-05')).length, 361);
  assert.equal(calls.length, 2);
});
await check('transport: empty days do not trigger a broad history fallback', async () => {
  const { ctx, calls } = transportHarness();
  assert.equal((await ctx.fetchTransportRowsForDate('2026-10-05')).length, 0);
  assert.equal(calls.length, 1);
});
await check('transport: query failure is surfaced without returning partial success', async () => {
  const { ctx, calls } = transportHarness([], { fail: true });
  await assert.rejects(ctx.fetchTransportRowsForDate('2026-10-05'), /synthetic read denied/);
  assert.equal(calls.length, 1);
});
console.log(`${checks} draft status / transport date scenarios passed (${process.env.TZ || 'system timezone'}).`);
