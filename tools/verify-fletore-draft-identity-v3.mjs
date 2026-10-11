import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as fletore from '../lib/fletoreBase.js';

// Synthetic identities only. The cron transport is captured in memory.
const clients = [{ id: 'client-a', code: 71, full_name: 'Recorded Person', phone: '+38344123456' },
  { id: 'client-b', code: 72, full_name: 'Different Person', phone: '+38344654321' }];
const draft = (id, extra = {}) => ({ id, code: 901, client_name: 'Recorded Person', client_phone: '+38344123456',
  status: 'pranim', data: { status: 'incomplete', pranimi_db_draft: true, tepiha: [{ qty: 1, m2: 3.7 }],
    pay: { euro: 4.81, m2: 3.7 }, draft_lifecycle: { db_draft: true, db_draft_status: 'incomplete' } }, ...extra });
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }

await check('drafts stay available while active totals and repair alerts exclude them', () => {
  const row = draft(1);
  const before = structuredClone(row);
  const b = fletore.buildBaseOrderBuckets(clients, [row]);
  assert.equal(b.activeOrderCount, 0);
  assert.equal(b.repairActiveOrders.length, 0);
  assert.equal(b.unlinkedActiveOrders.length, 0);
  assert.equal(b.draftOrders.length, 1);
  assert.equal(b.draftOrders[0].order, row);
  assert.deepEqual(row, before);
});
await check('legacy archived duplicate and DB_ARCHIVED markers exclude stale top-level pranim', () => {
  for (const data of [{ status: 'archived_duplicate' }, { state: 'archived_duplicate' }, { source: 'DB_ARCHIVED' }]) {
    const b = fletore.buildBaseOrderBuckets(clients, [draft(2, { data })]);
    assert.equal(b.activeOrderCount, 0);
    assert.equal(b.draftOrders.length, 0);
    assert.equal(b.archivedDraftOrders.length, 1);
    assert.equal(b.lastOrdersByClientKey.size, 0);
  }
});
await check('real ready/cleaning visits survive stale nested draft markers', () => {
  for (const status of ['gati', 'pastrim']) {
    const b = fletore.buildBaseOrderBuckets(clients, [draft(3, { status, client_id: 'client-a' })]);
    assert.equal(b.activeOrderCount, 1);
    assert.equal(b.draftOrders.length, 0);
  }
});
await check('plain pranim stays active and completed visits stay completed', () => {
  assert.equal(fletore.isBaseOrderActive({ status: 'pranim', data: {} }), true);
  const b = fletore.buildBaseOrderBuckets(clients, [draft(4, { status: 'dorzim' })]);
  assert.equal(b.activeOrderCount, 0);
  assert.equal(b.draftOrders.length, 0);
});
await check('JSON-string lifecycle payloads receive the same classification', () => {
  const row = draft(5); row.data = JSON.stringify(row.data);
  assert.equal(fletore.buildBaseOrderBuckets(clients, [row]).draftOrders.length, 1);
});
await check('fallback phone preserves the recorded order code and name', () => {
  const row = draft(6, { client_name: 'Original Visit Name', client_phone: '+38344654321', status: 'gati', data: {} });
  const b = fletore.buildBaseOrderBuckets(clients, [row]);
  const entry = b.repairActiveOrders[0];
  assert.equal(entry.client.full_name, 'Different Person');
  assert.equal(fletore.baseReportClient(entry).full_name, 'Original Visit Name');
  assert.equal(fletore.baseReportClient(entry).code, 901);
});
await check('fallback code preserves missing phone instead of assigning the candidate phone', () => {
  const row = draft(7, { code: 72, client_name: 'Original Visit Name', client_phone: '', status: 'gati', data: {} });
  const entry = fletore.buildBaseOrderBuckets(clients, [row]).repairActiveOrders[0];
  assert.equal(fletore.baseReportClient(entry).phone, '-');
  assert.equal(fletore.baseReportClient(entry).full_name, 'Original Visit Name');
});
await check('names alone never link clients; ambiguous phones remain unresolved', () => {
  const row = draft(8, { code: 999, status: 'gati', data: {} });
  const noPhone = { ...row, client_phone: '' };
  assert.equal(fletore.buildBaseOrderBuckets(clients, [noPhone]).unlinkedActiveOrders.length, 1);
  const duplicate = [...clients, { ...clients[0], id: 'other-client', code: 73 }];
  assert.equal(fletore.buildBaseOrderBuckets(duplicate, [row]).unlinkedActiveOrders.length, 1);
});
await check('nineteen-case lifecycle reproduction retains 2 operational, 15 draft, 2 archived rows', () => {
  const rows = Array.from({ length: 15 }, (_, i) => draft(100 + i));
  rows.push(draft(200, { status: 'gati', data: {} }), draft(201, { status: 'gati', data: {} }));
  rows.push(draft(300, { data: { source: 'DB_ARCHIVED' } }), draft(301, { data: { status: 'archived_duplicate' } }));
  const b = fletore.buildBaseOrderBuckets(clients, rows);
  assert.equal(b.activeOrderCount, 2);
  assert.equal(b.draftOrders.length, 15);
  assert.equal(b.archivedDraftOrders.length, 2);
});

await check('cron HTML and attachment retain drafts, archive IDs, and original identity without sending', async () => {
  const rows = [draft(901), draft(902, { data: { source: 'DB_ARCHIVED' } }),
    draft(903, { code: 902, status: 'gati', client_name: 'Visit Snapshot Name', client_phone: '+38344654321', data: { pay: { euro: 12 } } })];
  let captured = null;
  const context = { ...fletore, Buffer, console,
    createAdminClientOrThrow: () => ({}), pickEnv: key => key === 'BACKUP_EMAIL_TO' ? 'fixture@example.invalid' : 'fixture',
    fetchAllRows: async (_sb, { table }) => table === 'orders' ? rows : table === 'clients' ? clients : [],
    fetchAllRowsResult: async () => ({ data: [], error: null }), readUsers: async () => [],
    normPhone: value => String(value || '').replace(/\D/g, ''), normalizeName: value => String(value || ''),
    orderData: fletore.baseOrderData, extractClientKeys: () => [],
    pickClientCode: () => '', pickClientName: () => '', pickClientPhone: () => '',
    apiOk: (_res, value) => value, apiFail: (_res, error, _status, details) => { throw new Error(error + JSON.stringify(details)); },
    fetch: async (url, opts) => { assert.equal(url, 'https://api.resend.com/emails'); captured = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'captured-only' }) }; },
  };
  const code = fs.readFileSync('api/cron/backup.js', 'utf8').replace(/^import[\s\S]*?;\n/gm, '').replace('export default async function handler', 'async function handler');
  vm.createContext(context); vm.runInContext(code, context);
  const result = await context.handler({ method: 'GET' }, {});
  assert.equal(result.base_order_count, 1);
  assert.equal(result.base_draft_count, 1);
  assert.equal(result.base_archived_draft_count, 1);
  assert.match(captured.html, /DRAFTE TË PAPËRFUNDUARA/);
  assert.match(captured.html, /ID: 902/);
  assert.match(captured.html, /Visit Snapshot Name/);
  assert.ok(!captured.html.includes('Different Person'));
  const attachment = JSON.parse(Buffer.from(captured.attachments[0].content, 'base64').toString());
  assert.equal(attachment.base.active_orders[0].code, 902);
  assert.equal(attachment.base.active_orders[0].name, 'Visit Snapshot Name');
  assert.equal(attachment.base.active_orders[0].candidate_client.name, 'Different Person');
  assert.equal(attachment.base.draft_orders[0].source_order.data.pay.euro, 4.81);
  assert.equal(attachment.base.archived_draft_orders[0].order_id, 902);
});
console.log(`FLETORE_DRAFT_IDENTITY_V3: ${checks} behavioral scenarios passed`);
