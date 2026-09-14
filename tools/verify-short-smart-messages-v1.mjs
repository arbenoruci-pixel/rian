import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createFamilyTestDb, seedFamilyDb, ids } from './verify-client-family-db-v1.mjs';
import { familyDbAdapter } from './fixtures/family-db-adapter.mjs';
import { familyAction, signFamilyToken } from '../lib/clientFamilyServer.js';
import { createFamilyHandler } from '../api/client-family.js';
import { buildSmartSmsText } from '../lib/smartSms.js';
import { prepareFamilySmartMessage, FAMILY_INVITATION } from '../lib/clientFamilyClient.js';

const db = await createFamilyTestDb(); await seedFamilyDb(db);
const supabase = familyDbAdapter(db), secret = 'isolated-short-link-test-secret-value', now = Date.UTC(2026, 8, 14, 12), authUser = { id: ids.staff };
const env = { supabase, secret, now, authUser }, publicEnv = { supabase, secret, now };
const transportId = '66666666-6666-4666-8666-666666666666';
await db.query("insert into transport_orders(id,client_id,client_name,client_phone,status,client_tcode,code_str) values($1,$2,'Synthetic transport','045111222','gati','T123','T123')", [transportId, ids.t]);
let count = 0;
const test = async (name, run) => { await run(); count++; console.log('PASS', name); };
const sign = (source = 'BASE', orderId = 10) => familyAction({ action: 'SIGN_LINK', source, orderId }, env);
const signed = await sign(), shortToken = signed.shortUrl.split('/').at(-1);
await test('personal link is at most 55 characters and stores a hash without customer fields', async () => {
  assert.match(signed.shortUrl, /^https:\/\/tepiha\.vercel\.app\/k\/s_[A-Za-z0-9_-]{22}$/);
  assert(signed.shortUrl.length <= 55);
  const row = (await db.query('select * from client_family_short_links')).rows[0];
  assert.equal(row.token_hash, createHash('sha256').update(shortToken).digest('hex'));
  assert(!JSON.stringify(row).includes(shortToken)); assert(!signed.shortUrl.includes(ids.a));
});
await test('reopening the same order reuses one link and the same database row', async () => {
  assert.equal((await sign()).shortUrl, signed.shortUrl);
  assert.equal((await db.query('select count(*)::int as n from client_family_short_links')).rows[0].n, 1);
});
await test('short Base link resolves the exact order and exposes no phone list', async () => {
  const result = await familyAction({ action: 'RESOLVE_LINK', token: shortToken }, publicEnv);
  assert.equal(result.orderId, '10'); assert.equal(result.source, 'BASE'); assert.equal(result.token, shortToken);
  const info = await familyAction({ action: 'PUBLIC_INFO', source: 'BASE', orderId: '10', token: shortToken }, publicEnv);
  assert.equal(info.codes[0].code, '123'); assert(!JSON.stringify(info).includes('044'));
});
await test('short Transport link retains its exact UUID and source boundary', async () => {
  const token = (await sign('TRANSPORT', transportId)).shortUrl.split('/').at(-1);
  const result = await familyAction({ action: 'RESOLVE_LINK', token }, publicEnv);
  assert.equal(result.orderId, transportId); assert.equal(result.source, 'TRANSPORT');
  await assert.rejects(familyAction({ action: 'PUBLIC_INFO', source: 'BASE', orderId: transportId, token }, publicEnv), /INVALID/);
});
await test('unknown and modified short links fail without falling back to client codes', async () => {
  for (const token of ['s_' + 'A'.repeat(22), shortToken.slice(0, -2) + 'zz', 's_54']) {
    await assert.rejects(familyAction({ action: 'RESOLVE_LINK', token }, publicEnv), /INVALID/);
  }
  await assert.rejects(familyAction({ action: 'PUBLIC_INFO', source: 'BASE', orderId: 11, token: shortToken }, publicEnv), /INVALID/);
});
await test('contact append through the short link remains idempotent', async () => {
  const body = { action: 'PUBLIC_ADD', source: 'BASE', orderId: 10, token: shortToken, requestId: randomUUID(), contacts: [{ name: 'Synthetic family', phone: '049888777' }] };
  await familyAction(body, publicEnv); await familyAction(body, publicEnv);
  assert.equal((await db.query('select count(*)::int as n from client_family_contacts')).rows[0].n, 1);
});
await test('expired family access keeps tracking available while rejecting contact changes', async () => {
  const expiredEnv = { ...publicEnv, now: now + 31 * 86400000 };
  assert.equal((await familyAction({ action: 'RESOLVE_LINK', token: shortToken }, expiredEnv)).token, '');
  await assert.rejects(familyAction({ action: 'PUBLIC_INFO', source: 'BASE', orderId: 10, token: shortToken }, expiredEnv), /EXPIRED/);
  await assert.rejects(familyAction({ action: 'PUBLIC_ADD', source: 'BASE', orderId: 10, token: shortToken, requestId: randomUUID(), contacts: [] }, expiredEnv), /EXPIRED/);
});
await test('order reassignment invalidates both short resolution and family access', async () => {
  await db.exec('alter table orders disable trigger all');
  await db.query('update orders set client_id=$1 where id=10', [ids.b]);
  try {
    await assert.rejects(familyAction({ action: 'RESOLVE_LINK', token: shortToken }, publicEnv), /INVALID/);
    await assert.rejects(familyAction({ action: 'PUBLIC_INFO', source: 'BASE', orderId: 10, token: shortToken }, publicEnv), /INVALID/);
  } finally { await db.query('update orders set client_id=$1 where id=10', [ids.a]); await db.exec('alter table orders enable trigger all'); }
});
await test('previously delivered signed links remain valid', async () => {
  const token = signFamilyToken({ source: 'BASE', clientId: ids.a, orderId: 10 }, secret, now);
  assert.equal((await familyAction({ action: 'PUBLIC_INFO', source: 'BASE', orderId: 10, token }, publicEnv)).codes[0].code, '123');
});
await test('link table refuses public reads and allows only the server insert path', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query('select * from client_family_short_links'), /permission denied/);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  const value = await sign(); assert.equal(value.shortUrl, signed.shortUrl);
  await db.exec('reset role');
});
const handler = createFamilyHandler({ createClient: () => supabase, getSecret: () => secret, authenticate: async () => { throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED', httpStatus: 401 }); } });
async function http(body, origin = 'http://test.local') {
  let status, value; await handler({ method: 'POST', headers: { host: 'test.local', origin }, body }, { setHeader() {}, set statusCode(s) { status = s; }, end(s) { value = JSON.parse(s); } });
  return { status, value };
}
await test('public resolution works without login and signing/cross-origin requests stay protected', async () => {
  assert.equal((await http({ action: 'RESOLVE_LINK', token: shortToken })).status, 200);
  assert.equal((await http({ action: 'SIGN_LINK', source: 'BASE', orderId: 10 })).status, 401);
  assert.equal((await http({ action: 'RESOLVE_LINK', token: shortToken }, 'https://foreign.invalid')).status, 403);
});
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  const result = await familyAction(JSON.parse(options.body), env);
  return { ok: true, status: 200, json: async () => ({ ok: true, ...result }) };
};
try {
  for (const [action, order] of [
    ['pranimi_baze', { id: 10, code: 123 }], ['gati_baze', { id: 10, code: 123 }],
    ['transport_pranimi', { id: transportId, client_tcode: 'T123' }], ['transport_konfirmim', { id: transportId, client_tcode: 'T123' }],
  ]) await test(`${action} stays concise with name, code, quantity, amount and one link`, async () => {
    const text = await prepareFamilySmartMessage(buildSmartSmsText({ ...order, client_name: 'Lis', pieces: 2, total: 1.95 }, action));
    assert(text.length < 300, text); assert(text.includes('Lis')); assert(text.includes('2 copë')); assert(text.includes('1.95€'));
    assert(text.includes(order.client_tcode || '123')); assert.equal((text.match(/https:\/\//g) || []).length, 1);
    assert(text.includes(FAMILY_INVITATION)); assert(!text.includes('family=')); assert(!text.includes('duar të sigurta'));
    if (action === 'gati_baze') assert(text.includes('24 orëve'));
    if (action === 'transport_konfirmim') assert(text.includes('konfirmoni'));
    assert.equal(await prepareFamilySmartMessage(text), text);
  });
} finally { globalThis.fetch = originalFetch; }
await test('missing short-link table falls back to the existing signed capability', async () => {
  const missing = { ...supabase, from: table => table === 'client_family_short_links' ? { upsert: async () => ({ error: { code: 'PGRST205' } }) } : supabase.from(table) };
  const result = await familyAction({ action: 'SIGN_LINK', source: 'BASE', orderId: 10 }, { ...env, supabase: missing });
  assert.equal(result.shortUrl, null); assert(result.token.includes('.'));
});
console.log(`PASS ${count} short-link and concise-message scenarios`); await db.close();
