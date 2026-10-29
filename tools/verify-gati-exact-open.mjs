import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { fetchGatiExactTarget } from '../lib/gatiExactOpen.js';

const ready = { id: 3739, code: 1403, status: 'gati', client_name: 'Klienti test', data: { ready_location: 'A3' } };
let calls = [];
const read = async (table, opts) => { calls.push({ table, opts }); return [ready]; };
assert.equal((await fetchGatiExactTarget({ openCode: '01403', openId: '99' }, read)).row.id, 3739);
assert.deepEqual(calls[0].opts.eq, { code: 1403 });
assert.equal(calls[0].opts.limit, 1);
assert.equal(calls[0].opts.eq.status, undefined);
console.log('PASS current client-code visit overrides stale HOME id and is read outside the overview limit');
await fetchGatiExactTarget({ openId: '3739' }, read);
assert.deepEqual(calls[1].opts.eq, { id: 3739 });
assert.equal((await fetchGatiExactTarget({ openCode: 'T1403', openId: '3739' }, read)).kind, 'missing');
assert.equal(calls.length, 2);
assert.equal((await fetchGatiExactTarget({ openCode: '1403' }, async () => [])).kind, 'missing');
await assert.rejects(fetchGatiExactTarget({ openCode: '1403' }, async () => { throw Error('offline'); }));
console.log('PASS id-only links, transport boundary, absent orders and network failure');

// Execute the actual page's parallel-query/merge block, including its catches.
const page = fs.readFileSync('app/gati/page.jsx', 'utf8');
const block = page.slice(page.indexOf('    const rootGatiPromise ='), page.indexOf('    let syncSnapshot = []', page.indexOf('    const rootGatiPromise =')));
async function pageRead({ overview = [], exactRow = ready, online = true, failOverview = false, failExact = false } = {}) {
  const context = vm.createContext({
    onlineAtStart: online, target: { exactMode: true, openId: '99', openCode: '1403' },
    GATI_FETCH_LIMIT: 200, GATI_DB_TIMEOUT_MS: 12000, dataError: null,
    fetchGatiExactTarget,
    listOrderRecords: async (_, opts) => {
      if (opts.eq.status) { if (failOverview) throw Error('overview unavailable'); return overview; }
      if (failExact) throw Error('exact unavailable');
      return exactRow ? [exactRow] : [];
    },
  });
  return vm.runInContext(`(async()=>{${block};return { rows: await dataPromise, exact: await exactPromise };})()`, context);
}
const overview = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, status: 'gati' }));
let result = await pageRead({ overview });
assert.equal(result.rows.length, 201);
assert.equal(result.rows.find(r => r.id === 3739).code, 1403);
result = await pageRead({ overview: [{ ...ready, status: 'gati' }], exactRow: { ...ready, status: 'dorzim' } });
assert.equal(result.rows.length, 1);
assert.equal(result.rows[0].status, 'dorzim');
result = await pageRead({ failOverview: true });
assert.equal(result.rows[0].id, 3739);
result = await pageRead({ overview, failExact: true });
assert.equal(result.exact.kind, 'error');
assert.equal(result.rows.length, 200);
result = await pageRead({ online: false });
assert.equal(result.rows, null);
assert.equal(result.exact.kind, 'offline');
console.log('PASS actual page merges missing targets, replaces stale statuses, survives overview failure and preserves offline mode');

const filterCode = page.slice(page.indexOf('  const filtered = useMemo('), page.indexOf('  const discrepancyRows = useMemo('));
const filtered = (state, orders) => vm.runInNewContext(`${filterCode}; filtered`, {
  useMemo: fn => fn(), exactMode: true, openId: '99', openCode: '1403', search: '1403',
  orders, exactOpenState: state, normalizeCode: value => String(value || ''),
});
assert.equal(filtered({ kind: 'found', row: ready }, [{ id: 99, code: 1403 }, ready]).length, 1);
assert.equal(filtered({ kind: 'found', row: { ...ready, status: 'dorzim' } }, [{ id: 99, code: 1403 }]).length, 0);
assert.equal(filtered({ kind: 'missing' }, [{ id: 99, code: 1403 }]).length, 0);
console.log('PASS actual exact filter cannot substitute a prior visit for the freshly resolved order');

const ui = buildSync({ stdin: { contents: `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import Notice from './components/GatiExactOpenNotice.jsx';export const render=p=>renderToStaticMarkup(React.createElement(Notice,p));`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom/server'] }).outputFiles[0].text;
const { createRequire } = await import('node:module');
const ctx = vm.createContext({ module: { exports: {} }, require: createRequire(import.meta.url) });
vm.runInContext(ui, ctx);
const render = state => ctx.module.exports.render({ exactMode: true, code: '1403', state });
const blocked = render({ kind: 'found', row: ready, blocked: true });
assert(blocked.includes('#1403') && blocked.includes('A3') && blocked.includes('Kontrollo sinkronizimin'));
assert(!blocked.includes('PAGUAJ') && !blocked.includes('Nuk ka porosi GATI'));
assert(render({ kind: 'found', row: { ...ready, status: 'dorzim' } }).includes('DORZIM'));
assert(render({ kind: 'error' }).includes('nuk u verifikua'));
assert(render({ kind: 'offline' }).includes('Lidhu me internet'));
console.log('PASS actual UI explains local delivery conflicts, moved orders and connectivity without enabling a second payment');

// Guard the race wiring: route changes enqueue a latest-ref refresh; old work
// cannot mark the new target loaded. Existing delivery guards remain in place.
assert(page.includes('}, [exactTargetKey]);'));
assert(page.includes("if (autoReason || reason === 'exact_target') queuedAutoRefreshReasonRef.current"));
assert(page.includes('refreshOrdersRef.current(queuedReason)'));
assert(page.includes('if (exactTargetRef.current?.key === target?.key) setLoading(false)'));
assert(page.includes('.filter((row) => !isGatiRowBlockedByDeliveryTombstone(row))'));
assert(page.includes('if (isGatiRowBlockedByDeliveryTombstone(row)) {'));
console.log('PASS latest-route refresh wiring and list/payment safeguards');
