import assert from 'node:assert/strict';
import fs from 'node:fs';
import latest from '../api/backup/latest.js';
import run from '../api/backup/run.js';
import cron from '../api/cron/backup.js';
import { buildBaseOrderBuckets, baseReportClient } from '../lib/fletoreBase.js';

// Exercise the real handlers and Supabase query builder. All I/O stays in memory.
const clients = [
  { id: 'a', code: '0071', full_name: 'Current A', phone: '+38344123456' },
  { id: 'b', code: '71', full_name: 'Current B', phone: '044123456' },
  { id: 'c', code: '71', full_name: 'Current C', phone: '044123457' },
  { id: 'd', code: '72', full_name: 'Current D', phone: '044123456' },
  ...Array.from({ length: 1000 }, (_, i) => ({ id: `filler-${i}`, code: 10000 + i })),
  { id: 'late-client', code: '9999', full_name: 'Current late name', phone: '049999999' },
];
const makeOrder = (id, extra = {}) => ({
  id, code: '0071', code_str: 'B-0071', client_code: '71', client_tcode: '0071',
  client_name: 'Visit name', client_phone: '044123456', status: 'gati', visit_nr: 3,
  created_at: '2026-01-02T03:04:05Z', updated_at: '2026-02-03T04:05:06Z',
  data: { client: { name: 'Embedded original', phone: '044000000', code: '0071' },
    history: [{ at: '2026-01-02T03:04:05Z', action: 'pranim', actor: 'fixture' }],
    pay: { euro: 12.34, paid: 5 }, inventory_audit: { state: 'found' } },
  ...extra,
});
const orders = [
  makeOrder('missing-link'),
  makeOrder('broken-link', { client_id: 'deleted-client' }),
  makeOrder('similar-code', { client_code: '0071', client_phone: '044123457' }),
  makeOrder('similar-phone', { client_code: 'unmatched', client_phone: '+383 44 123 456' }),
  makeOrder('linked-history', { client_id: 'a', client_name: 'Original A', client_phone: '044000001' }),
  makeOrder('empty-fields', { client_id: 'b', client_name: '', client_phone: null }),
  makeOrder('embedded-only', { client_name: null, client_phone: null }),
  makeOrder('string-data', { data: JSON.stringify({ client: { name: 'Historical string', phone: '044123456' }, history: ['original'] }) }),
  makeOrder('done', { status: 'dorzim' }),
  makeOrder('draft', { status: 'pranim', data: { status: 'incomplete', pranimi_db_draft: true } }),
  ...Array.from({ length: 1000 }, (_, i) => makeOrder(`filler-${i}`, { status: 'archived' })),
  makeOrder('last-page', { client_id: 'late-client', client_name: 'Original late name', client_phone: '049000000' }),
];
const before = structuredClone({ clients, orders });
const transportOrders = [
  makeOrder('transport-embedded', { client_tcode: 'T71', client_name: null, client_phone: null }),
  makeOrder('transport-broken', { client_tcode: 'T72', client_id: 'missing', client_name: null, client_phone: null }),
  makeOrder('transport-blank', { client_tcode: 'T73', client_name: null, client_phone: null, data: {} }),
];
const transportClients = ['T71', 'T72', 'T73'].map(tcode => ({ id: tcode, tcode, name: 'UNVERIFIED CANDIDATE', phone: '044999999' }));
const transportBefore = structuredClone(transportOrders);
let email;
let snapshots = [];
let accesses = [];
let failOrders = false;
const originalFetch = globalThis.fetch;
const envKeys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BACKUP_PIN', 'CRON_SECRET', 'BACKUP_EMAIL_TO', 'RESEND_API_KEY', 'RESEND_FROM'];
const originalEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
Object.assign(process.env, { SUPABASE_URL: 'https://backup-fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only', BACKUP_PIN: 'fixture-pin', CRON_SECRET: 'fixture-cron' });
Object.assign(process.env, { BACKUP_EMAIL_TO: 'fixture@example.invalid', RESEND_API_KEY: 'fixture-only', RESEND_FROM: 'fixture@example.invalid' });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.href === 'https://api.resend.com/emails') {
    email = JSON.parse(init.body);
    return Response.json({ id: 'captured-only' });
  }
  assert.equal(url.origin, 'https://backup-fixture.invalid', 'Network access must stay mocked');
  const table = url.pathname.split('/').pop();
  const method = init.method || 'GET';
  accesses.push({ table, method });
  if (method === 'POST') {
    assert.equal(table, 'app_backups', 'Only a snapshot insert is permitted');
    snapshots.push(...JSON.parse(init.body));
    return new Response(null, { status: 201 });
  }
  assert.equal(method, 'GET', 'No business-data mutations are permitted');
  if (table === 'orders' && failOrders) return Response.json({ message: 'fixture read failed' }, { status: 400 });
  const source = { clients, orders, transport_orders: transportOrders, transport_clients: transportClients, users: [], app_backups: snapshots.slice(-1) }[table];
  assert.ok(source, `Unexpected table: ${table}`);
  const offset = Number(url.searchParams.get('offset') || 0);
  const limit = Number(url.searchParams.get('limit') || source.length);
  return Response.json(source.slice(offset, offset + limit));
};

async function call(handler, query = {}, method = 'GET', headers = {}) {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
  await handler({ method, query, headers }, res);
  return { ...res, json: JSON.parse(res.body) };
}
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
function assertPayload(payload) {
  assert.deepEqual(payload.orders, before.orders, 'All recorded identity, codes, nested history and payments must survive');
  assert.equal(payload.clients.length, clients.length);
  assert.equal(payload.orders_count, orders.length);
  assert.equal(payload.open_orders_count, 9);
}
try {
  await check('live JSON preserves every original row across both pagination boundaries', async () => {
    const res = await call(latest, { pin: 'fixture-pin', live: '1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.source, 'live');
    assertPayload(res.json.backup.payload);
    assert.deepEqual(res.json.backup.orders, before.orders);
    const buckets = buildBaseOrderBuckets(res.json.backup.clients, res.json.backup.orders);
    const allUnresolved = [...buckets.repairActiveOrders, ...buckets.unlinkedActiveOrders];
    for (const id of ['missing-link', 'broken-link', 'similar-code', 'similar-phone']) {
      const entry = allUnresolved.find(e => e.order.id === id);
      assert.ok(entry, `Unresolved identity ${id} stays available for review`);
      assert.equal(baseReportClient(entry).full_name, 'Visit name');
      assert.equal(baseReportClient(entry).code, '0071');
    }
  });
  await check('raw download retains the same source rows', async () => {
    const res = await call(latest, { pin: 'fixture-pin', live: '1', raw: '1' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-disposition'], /^attachment;/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assertPayload(res.json);
  });
  await check('manual snapshot and subsequent JSON/raw reads retain source identity', async () => {
    const saved = await call(run, { pin: 'fixture-pin' }, 'POST');
    assert.equal(saved.json.ok, true);
    assertPayload(snapshots[0].payload);
    assert.equal(snapshots[0].pin, 'fixture-pin');
    for (const raw of ['0', '1']) {
      const res = await call(latest, { pin: 'fixture-pin', raw });
      assert.equal(res.statusCode, 200);
      assertPayload(raw === '1' ? res.json : res.json.backup.payload);
    }
  });
  await check('cron-authorized snapshot uses the same identity policy', async () => {
    const res = await call(run, {}, 'POST', { authorization: 'Bearer fixture-cron' });
    assert.equal(res.json.ok, true);
    assertPayload(snapshots.at(-1).payload);
    assert.equal(snapshots.at(-1).pin, undefined);
  });
  await check('authentication and method rejection occur before database access', async () => {
    const count = accesses.length;
    assert.equal((await call(latest, { live: '1' })).statusCode, 401);
    assert.equal((await call(latest, { pin: 'wrong', live: '1' })).statusCode, 401);
    assert.equal((await call(run, {}, 'POST')).statusCode, 401);
    assert.equal((await call(run, { pin: 'fixture-pin' })).statusCode, 405);
    assert.equal(accesses.length, count);
  });
  await check('failed source read cannot produce a partial snapshot', async () => {
    failOrders = true;
    const count = snapshots.length;
    assert.equal((await call(run, { pin: 'fixture-pin' }, 'POST')).statusCode, 500);
    assert.equal(snapshots.length, count);
    failOrders = false;
  });
  await check('daily transport HTML/JSON keeps embedded identity and leaves unknown contacts blank', async () => {
    const res = await call(cron);
    assert.equal(res.statusCode, 200);
    assert.ok(email, 'Email must be captured in memory');
    assert.ok(!email.html.includes('UNVERIFIED CANDIDATE'));
    assert.ok(!email.html.includes('044999999'));
    const payload = JSON.parse(Buffer.from(email.attachments[0].content, 'base64').toString());
    const cards = payload.transport.flatMap(g => g.active_clients);
    assert.equal(cards.length, 3);
    for (const id of ['transport-embedded', 'transport-broken']) {
      const card = cards.find(c => c.order_id === id);
      assert.equal(card.name, 'Embedded original');
      assert.equal(card.phone, '044000000');
    }
    assert.equal(cards.find(c => c.order_id === 'transport-blank').name, '-');
    assert.equal(cards.find(c => c.order_id === 'transport-blank').phone, '-');
    assert.deepEqual(transportOrders, transportBefore);
  });
  await check('legacy Next identity-rewriting entry points remain removed', () => {
    for (const route of ['latest', 'run']) assert.equal(fs.existsSync(`app/api/backup/${route}/route.js`), false);
  });
  assert.deepEqual({ clients, orders }, before, 'Fixture source records must remain untouched');
  console.log(`BACKUP_IDENTITY_V1: ${checks} behavioral scenarios passed`);
} finally {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}
