import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createStaffMessagesHandler } from '../api/staff-messages.js';

// Entirely synthetic fixtures. Never connects to a hosted database or sends a message.
const pg = new PGlite();
const ids = {
  dispatch: '10000000-0000-4000-8000-000000000001',
  admin: '10000000-0000-4000-8000-000000000002',
  first: '20000000-0000-4000-8000-000000000001',
  second: '20000000-0000-4000-8000-000000000002',
  stranger: '20000000-0000-4000-8000-000000000003',
  inactive: '20000000-0000-4000-8000-000000000004',
};
let passed = 0;
const pass = name => { passed++; console.log('PASS ' + name); };
await pg.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create table public.users(id uuid primary key,name text,role text,is_active boolean);
  create table public.tepiha_user_devices(device_id text primary key,user_id uuid,is_approved boolean);
  grant usage on schema public to service_role,anon,authenticated;
  grant select,update on public.users to service_role;
  grant select on public.tepiha_user_devices to service_role;
`);
for (const [key, id] of Object.entries(ids)) {
  const role = key === 'dispatch' ? 'DISPATCH' : key === 'admin' ? 'ADMIN_MASTER' : key === 'second' ? 'TRANSPORT' : 'PUNTOR';
  await pg.query('insert into public.users values($1,$2,$3,$4)', [id, 'Test ' + key, role, key !== 'inactive']);
  await pg.query('insert into public.tepiha_user_devices values($1,$2,true)', ['device-' + key, id]);
}
await pg.query('insert into public.tepiha_user_devices values($1,$2,true),($3,$2,false)', ['device-first-other', ids.first, 'device-first-unapproved']);
await pg.exec(await readFile(new URL('../supabase/migrations/20261122015749_staff_messages_v1.sql', import.meta.url), 'utf8'));

const functionArgs = {
  staff_message_send_v1: ['p_actor_id', 'p_recipient_ids', 'p_title', 'p_body', 'p_request_key', 'p_all_workers'],
  staff_messages_read_v1: ['p_actor_id', 'p_mode', 'p_before_at', 'p_before_id', 'p_limit'],
  staff_message_read_receipt_v1: ['p_actor_id', 'p_message_id', 'p_acknowledge'],
};
let lastRpcError = '';
function queryBuilder(table) {
  assert.ok(['users', 'tepiha_user_devices'].includes(table), 'Only identity reads reach the table API');
  const filters = [];
  let fields = '*', single = false, ordering = '', limit = 251;
  const query = {
    select(value) { fields = value; assert.match(fields, /^[a-z_,*]+$/); return query; },
    eq(field, value) { assert.match(field, /^[a-z_]+$/); filters.push([field, value]); return query; },
    order(field) { assert.equal(field, 'name'); ordering = ' order by name'; return query; },
    limit(value) { limit = value; return query; },
    maybeSingle() { single = true; return query; },
    async then(resolve, reject) {
      try {
        const where = filters.map(([field], index) => field + '=$' + (index + 1)).join(' and ');
        const result = await pg.query('select ' + fields + ' from public.' + table + (where ? ' where ' + where : '') + ordering + ' limit ' + Number(limit), filters.map(([, value]) => value));
        return resolve({ data: single ? result.rows[0] || null : result.rows, error: null });
      } catch (error) { if (reject) return reject(error); throw error; }
    },
  };
  return query;
}
const db = {
  from: queryBuilder,
  async rpc(name, args) {
    const names = functionArgs[name];
    assert.ok(names, 'Only message RPCs can run');
    assert.deepEqual(Object.keys(args).sort(), [...names].sort());
    const values = names.map(key => Array.isArray(args[key]) ? '{' + args[key].join(',') + '}' : args[key]);
    try {
      const { rows } = await pg.query('select public.' + name + '(' + names.map((_, index) => '$' + (index + 1)).join(',') + ') as result', values);
      return { data: rows[0].result, error: null };
    } catch (error) { lastRpcError = error.message; return { data: null, error: { message: error.message } }; }
  },
};
const handler = createStaffMessagesHandler({ createClient: () => db });
async function api(key, body, overrides = {}) {
  const headers = { host: 'fixture.test', origin: 'https://fixture.test', 'content-type': 'application/json', cookie: 'tepiha_device_id=device-' + key, ...overrides.headers };
  const req = { method: overrides.method || 'POST', headers, body: { expectedActorId: ids[key] || ids.first, ...body } };
  let text;
  const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { text = value; } };
  await handler(req, res);
  return { status: res.statusCode, json: JSON.parse(text), headers: res.headers };
}
const requestKey = '30000000-0000-4000-8000-000000000001';
const payload = { action: 'send', recipientIds: [ids.first, ids.second], title: 'Njoftim test', body: 'Rreshti i parë.\nRreshti i dytë.', requestKey };
await pg.exec('set role service_role');

assert.equal((await api('dispatch', { action: 'badge' }, { headers: { cookie: '' } })).status, 401);
assert.equal((await api('first-unapproved', { action: 'badge' })).status, 403);
assert.equal((await api('inactive', { action: 'badge' })).status, 403);
assert.equal((await api('dispatch', payload, { headers: { origin: 'https://other.test' } })).status, 403);
assert.equal((await api('dispatch', payload, { headers: { 'content-type': 'text/plain' } })).status, 415);
assert.equal((await api('dispatch', payload, { method: 'GET' })).status, 405);
assert.equal((await api('dispatch', { action: 'badge', expectedActorId: ids.first })).status, 403);
assert.equal((await api('dispatch', { ...payload, senderId: ids.admin })).status, 400);
assert.equal((await api('dispatch', payload, { headers: { 'content-length': '25000' } })).status, 413);
pass('API requires approved active identity, same origin, JSON, size bound and matching account; sender spoof rejected');

assert.equal((await api('first', payload)).status, 403);
assert.equal((await api('first', { action: 'recipients' })).status, 403);
assert.equal((await api('first', { action: 'list', mode: 'sent' })).status, 403);
const roster = await api('dispatch', { action: 'recipients' });
assert.deepEqual(roster.json.recipients.map(user => user.id).sort(), [ids.first, ids.second, ids.stranger].sort());
assert.ok(roster.json.recipients.every(user => !('pin' in user)));
pass('Only managers compose; roster excludes inactive users, owner accounts and sender without exposing credentials');

const sent = await api('dispatch', payload);
assert.equal(sent.status, 200, JSON.stringify(sent.json) + ' ' + lastRpcError);
assert.equal(sent.json.recipientCount, 2);
assert.equal(sent.json.alreadySent, false);
const messageId = sent.json.messageId;
const stored = (await pg.query('select sender_id,sender_name,title,body from public.staff_messages where id=$1', [messageId])).rows[0];
assert.equal(stored.sender_id, ids.dispatch);
assert.equal(stored.sender_name, 'Test dispatch');
assert.equal(stored.body, payload.body);
const retry = await api('dispatch', { ...payload, recipientIds: [ids.second, ids.first, ids.first] });
assert.equal(retry.json.messageId, messageId);
assert.equal(retry.json.alreadySent, true);
assert.equal((await api('dispatch', { ...payload, body: 'Changed payload' })).status, 409);
assert.equal((await api('dispatch', { ...payload, recipientIds: [ids.first] })).status, 409);
assert.equal(Number((await pg.query('select count(*) from public.staff_messages')).rows[0].count), 1);
pass('Send is atomic, canonical sender derived, recipient duplicates normalized, retry preserved and conflicting retry rejected');

const invalidKey = '30000000-0000-4000-8000-000000000002';
assert.equal((await api('dispatch', { ...payload, requestKey: invalidKey, recipientIds: [ids.first, ids.inactive] })).status, 400);
assert.equal((await api('dispatch', { ...payload, requestKey: invalidKey, recipientIds: [ids.first, ids.admin] })).status, 400);
assert.equal(Number((await pg.query('select count(*) from public.staff_messages')).rows[0].count), 1);
pass('A stale/ineligible recipient rejects the whole send without a partial message');

const inbox = await api('first', { action: 'list', mode: 'inbox' });
assert.deepEqual(inbox.json.items.map(item => item.id), [messageId]);
assert.equal(inbox.json.unreadCount, 1);
assert.equal((await api('stranger', { action: 'list' })).json.items.length, 0);
assert.equal((await api('admin', { action: 'list', mode: 'sent' })).json.items.length, 0);
assert.equal((await api('stranger', { action: 'acknowledge', messageId })).status, 404);
assert.equal((await api('dispatch', { action: 'acknowledge', messageId })).status, 404);
pass('Inbox and sent history are identity-scoped; even sender/admin cannot acknowledge for a recipient');

const read = await api('first', { action: 'read', messageId });
assert.equal(read.status, 200);
assert.ok(read.json.readAt);
assert.equal(read.json.acknowledgedAt, null);
assert.equal(read.json.unreadCount, 0);
const ack = await api('first', { action: 'acknowledge', messageId });
assert.equal(ack.json.readAt, read.json.readAt);
assert.ok(ack.json.acknowledgedAt);
const ackAgain = await api('first', { action: 'acknowledge', messageId });
assert.equal(ackAgain.json.acknowledgedAt, ack.json.acknowledgedAt);
const otherDevice = await api('first', { action: 'list' }, { headers: { cookie: 'tepiha_device_id=device-first-other' } });
assert.equal(otherDevice.json.items[0].acknowledgedAt, ack.json.acknowledgedAt);
const sentHistory = await api('dispatch', { action: 'list', mode: 'sent' });
assert.equal(sentHistory.json.items[0].recipients.find(user => user.id === ids.first).acknowledgedAt, ack.json.acknowledgedAt);
assert.equal(sentHistory.json.items[0].recipients.find(user => user.id === ids.second).readAt, null);
pass('Read and explicit acknowledgments persist once across devices and appear only in sender delivery history');

const concurrentPayload = { ...payload, requestKey: '30000000-0000-4000-8000-000000000003', title: 'Concurrent retry test' };
const concurrent = await Promise.all(Array.from({ length: 5 }, () => api('dispatch', concurrentPayload)));
assert.ok(concurrent.every(result => result.status === 200));
assert.equal(new Set(concurrent.map(result => result.json.messageId)).size, 1);
assert.equal(Number((await pg.query('select count(*) from public.staff_messages')).rows[0].count), 2);
pass('Concurrent retries produce one message and one recipient set');

const broadcast = await api('dispatch', { action: 'send', allWorkers: true, title: 'All test workers', body: 'Broadcast fixture', requestKey: '30000000-0000-4000-8000-000000000004' });
assert.equal(broadcast.json.recipientCount, 3);
assert.equal((await api('dispatch', { ...payload, allWorkers: true })).status, 400);
await pg.exec('reset role');
await pg.query('update public.users set is_active=false where id=$1', [ids.stranger]);
await pg.exec('set role service_role');
const broadcastRetry = await api('dispatch', { action: 'send', allWorkers: true, title: 'All test workers', body: 'Broadcast fixture', requestKey: '30000000-0000-4000-8000-000000000004' });
assert.equal(broadcastRetry.json.messageId, broadcast.json.messageId);
assert.equal(broadcastRetry.json.recipientCount, 3);
assert.equal(broadcastRetry.json.alreadySent, true);
await pg.exec('reset role');
await pg.query('update public.users set is_active=true where id=$1', [ids.stranger]);
await pg.exec('set role service_role');
pass('All-workers recipient snapshot is resolved atomically and survives roster changes on retry');

await pg.exec('reset role');
await pg.query("update public.users set is_active=false where id=$1", [ids.dispatch]);
await pg.exec('set role service_role');
assert.equal((await api('dispatch', { action: 'list', mode: 'sent' })).status, 403);
const directDisabled = await db.rpc('staff_message_send_v1', { p_actor_id: ids.dispatch, p_recipient_ids: [ids.first], p_title: 'Blocked', p_body: 'Blocked', p_request_key: '30000000-0000-4000-8000-000000000005', p_all_workers: false });
assert.match(directDisabled.error.message, /STAFF_MESSAGE_FORBIDDEN/);
await pg.exec('reset role');
await pg.query("update public.users set is_active=true where id=$1", [ids.dispatch]);
await pg.exec('set role service_role');
pass('Disabling a sender revokes access at both device API and database boundary');

await pg.exec('reset role');
for (const role of ['anon', 'authenticated']) {
  await pg.exec('set role ' + role);
  await assert.rejects(pg.query('select * from public.staff_messages'), /permission denied/);
  await assert.rejects(pg.query('select public.staff_messages_read_v1($1)', [ids.first]), /permission denied/);
  await assert.rejects(pg.query('select public.staff_message_read_receipt_v1($1,$2,true)', [ids.first, messageId]), /permission denied/);
  await pg.exec('reset role');
}
const rls = await pg.query("select relname,relrowsecurity from pg_class where relname in ('staff_messages','staff_message_recipients') order by relname");
assert.ok(rls.rows.every(row => row.relrowsecurity));
pass('Client database roles have no table/RPC access and both tables enforce RLS');

await pg.query("update public.staff_messages set created_at=clock_timestamp()-interval '2 hours'");
for (let index = 0; index < 31; index++) {
  const id = '40000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
  await pg.query('insert into public.staff_messages(id,sender_id,sender_name,sender_role,title,body,request_key,created_at) values($1,$2,$3,$4,$5,$6,$1,$7)', [id, ids.admin, 'Test admin', 'ADMIN_MASTER', 'Page ' + index, 'Pagination fixture', '2026-01-01T00:00:00Z']);
  await pg.query('insert into public.staff_message_recipients(message_id,recipient_id,recipient_name) values($1,$2,$3)', [id, ids.first, 'Test first']);
}
await pg.exec('set role service_role');
const pageOne = await api('first', { action: 'list' });
assert.equal(pageOne.json.items.length, 30);
assert.ok(pageOne.json.nextCursor);
const pageTwo = await api('first', { action: 'list', cursor: pageOne.json.nextCursor });
assert.equal(new Set([...pageOne.json.items, ...pageTwo.json.items].map(item => item.id)).size, pageOne.json.items.length + pageTwo.json.items.length);
assert.equal(pageTwo.json.nextCursor, null);
pass('History pagination uses a timestamp and UUID cursor without duplicates at equal timestamps');

for (let index = 0; index < 30; index++) {
  const result = await api('admin', { ...payload, recipientIds: [ids.first], requestKey: '50000000-0000-4000-8000-' + String(index + 1).padStart(12, '0') });
  assert.equal(result.status, 200, lastRpcError);
}
assert.equal((await api('admin', { ...payload, recipientIds: [ids.first], requestKey: '50000000-0000-4000-8000-000000000031' })).status, 429);
const quotaRetry = await api('admin', { ...payload, recipientIds: [ids.first], requestKey: '50000000-0000-4000-8000-000000000001' });
assert.equal(quotaRetry.status, 200);
assert.equal(quotaRetry.json.alreadySent, true);
pass('Per-sender send bound rejects excess new sends while successful-request retries remain available');

await pg.close();
console.log('Staff messages: ' + passed + ' integration groups passed.');
