import assert from 'node:assert/strict';
import { buildWorkerBonusAccount, workerBonusMonthKey } from '../lib/workerBonusAccount.js';
import { authenticateWorkerBonusActor, readWorkerBonusAccount } from '../lib/workerBonusAccountServer.js';
import { createWorkerBonusAccountHandler } from '../api/worker-bonuses.js';
import { BUJAR_USER_ID } from '../lib/baseBonusEvidence.js';
import { ADMIN_ROLES } from '../lib/roles.js';
import { build } from 'esbuild';
import vm from 'node:vm';

// Synthetic amounts, identities and orders only. These fixtures never connect
// to Supabase, and the query double rejects every mutation and RPC.
const workerId = BUJAR_USER_ID;
const otherId = '11111111-1111-4111-8111-111111111111';
const managerId = '22222222-2222-4222-8222-222222222222';
const deviceId = 'fixture-worker-bonus-approved-device';
const worker = { id: workerId, name: 'Punëtori test', role: 'PUNTOR', is_active: true, pin: '7001', pay_ready_bonus_enabled: true };
const otherWorker = { id: otherId, name: 'Punëtori tjetër test', role: 'PUNTOR', is_active: true, pin: '7002', pay_ready_bonus_enabled: false };
const manager = { id: managerId, name: 'Dispeçeri test', role: 'DISPATCH', is_active: true, pin: '7003' };
const month = '2026-11';
const now = '2026-12-03T12:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
let checked = 0;
const pass = name => { checked++; console.log(`PASS ${name}`); };

function baseBonus(id, overrides = {}) {
  return {
    id, worker_pin: worker.pin, worker_name: worker.name, worker_role: worker.role,
    order_id: id + 1000, order_code: id + 2000, transport_control_id: null,
    amount: 1, m2: 10, rate_m2: 0.1, eligible: true, status: 'RETAINED',
    remaining_amount: 0, reserved_amount: 0, retained_amount: 1,
    entered_at: '2026-11-01T08:00:00Z', ready_at: '2026-11-02T08:00:00Z',
    qualification_at: '2026-11-02T08:00:00Z', qualification_source: 'PAYMENT',
    activated_at: '2026-11-02T08:00:00Z', reason: 'ELIGIBLE_DIRECT_FULL_PAYMENT_WITHIN_48H',
    metadata: { source: 'BASE_PAYMENT', payment_actor_pin: 'fixture-private-payment-actor' },
    ...overrides,
  };
}
function controlBonus(id, overrides = {}) {
  return baseBonus(id, {
    order_id: null, order_code: null, transport_control_id: `control-${id}`,
    amount: 0.5, m2: 0, rate_m2: 0, retained_amount: 0.5,
    qualification_source: 'TRANSPORT_CONTROL',
    metadata: { source_module: 'TRANSPORT_CONTROL', transport_order_id: `transport-${id}`, transport_code: `T${id}` },
    ...overrides,
  });
}
const bonuses = [
  // Earned in October; handoff accepted just inside November in Belgrade.
  baseBonus(101, { qualification_at: '2026-10-12T08:00:00Z', activated_at: '2026-10-12T08:00:00Z', ready_at: '2026-10-12T08:00:00Z' }),
  baseBonus(102, { amount: 2, m2: 20, remaining_amount: 0.5, reserved_amount: 0.5, retained_amount: 1, status: 'PARTIAL_RESERVED', qualification_at: '2026-11-05T08:00:00Z' }),
  // Earned at the last instant of November locally, accepted in December.
  baseBonus(103, { amount: 0.75, m2: 7.5, retained_amount: 0.75, qualification_at: '2026-11-30T22:59:59Z' }),
  controlBonus(201, { qualification_at: '2026-11-12T08:00:00Z' }),
  controlBonus(202, { status: 'EARNED', remaining_amount: 0.5, retained_amount: 0, qualification_at: '2026-10-15T08:00:00Z', activated_at: '2026-10-15T08:00:00Z', ready_at: '2026-10-15T08:00:00Z' }),
  // December locally: not November earnings, but still an open obligation.
  baseBonus(104, { amount: 0.2, m2: 2, remaining_amount: 0.2, retained_amount: 0, status: 'EARNED', qualification_at: '2026-11-30T23:00:00Z' }),
  baseBonus(105, { amount: 0.3, m2: 3, retained_amount: 0.3, qualification_at: '2026-10-31T22:59:59Z', activated_at: '2026-10-31T22:59:59Z', ready_at: '2026-10-31T22:59:59Z' }),
  baseBonus(106, { amount: 0, retained_amount: 0, status: 'INELIGIBLE', eligible: false, qualification_at: '2026-11-15T08:00:00Z' }),
];
const handoffs = [
  { id: 301, status: 'ACCEPTED', submitted_at: '2026-10-31T22:00:00Z', decided_at: '2026-10-31T23:30:00Z' },
  { id: 302, status: 'ACCEPTED', submitted_at: '2026-11-10T08:00:00Z', decided_at: '2026-11-10T09:00:00Z' },
  { id: 303, status: 'PENDING', submitted_at: '2026-11-21T08:00:00Z', decided_at: null },
  { id: 304, status: 'ACCEPTED', submitted_at: '2026-11-30T22:50:00Z', decided_at: '2026-11-30T23:00:00Z' },
  { id: 305, status: 'ACCEPTED', submitted_at: '2026-11-13T08:00:00Z', decided_at: '2026-11-13T09:00:00Z' },
  { id: 306, status: 'ACCEPTED', submitted_at: '2026-10-31T22:40:00Z', decided_at: '2026-10-31T22:50:00Z' },
];
const allocations = [
  { id: 401, bonus_id: 101, handoff_id: 301, amount: 1, status: 'RETAINED' },
  { id: 402, bonus_id: 102, handoff_id: 302, amount: 1, status: 'RETAINED' },
  { id: 403, bonus_id: 102, handoff_id: 303, amount: 0.5, status: 'RESERVED' },
  { id: 404, bonus_id: 103, handoff_id: 304, amount: 0.75, status: 'RETAINED' },
  { id: 405, bonus_id: 201, handoff_id: 305, amount: 0.5, status: 'RETAINED' },
  { id: 406, bonus_id: 105, handoff_id: 306, amount: 0.3, status: 'RETAINED' },
];
const pendingControls = [
  { id: 'pending-1', order_id: 'transport-pending-1', status: 'PENDING', submitted_at: '2026-11-18T08:00:00Z', worker_id: workerId, order: { code_str: 'T901', status: 'pastrim' } },
  { id: 'returned-1', order_id: 'transport-returned-1', status: 'RETURNED', submitted_at: '2026-11-19T08:00:00Z', worker_id: workerId, order: { code_str: 'T902', status: 'gati' } },
];
const modelInput = extra => ({ worker, bonuses, allocations, handoffs, pendingControls, month, now, ...extra });

function fixture(overrides = {}, failures = {}) {
  const seed = {
    tepiha_user_devices: [{ user_id: workerId, device_id: deviceId, is_approved: true }],
    users: [worker, otherWorker, manager],
    base_ready_bonuses: clone(bonuses), base_ready_bonus_allocations: clone(allocations),
    cash_handoffs: handoffs.map(h => ({ ...h, worker_pin: worker.pin })), transport_controls: clone(pendingControls),
    orders: bonuses.filter(b => b.order_id).map(b => ({ id: b.order_id, code: b.order_code, client_name: 'Klienti sintetik' })),
    transport_orders: [
      ...bonuses.filter(b => b.transport_control_id).map(b => ({ id: b.metadata.transport_order_id, code_str: b.metadata.transport_code, client_name: 'Klienti sintetik transporti', status: 'gati' })),
      ...pendingControls.map(c => ({ id: c.order_id, ...c.order })),
    ],
    ...clone(overrides),
  };
  const calls = [];
  const mutation = () => { throw Error('The bonus report attempted a mutation or side-effect RPC.'); };
  const db = {
    rpc: mutation,
    from(table) {
      const call = { table, filters: [], columns: null, range: null, limit: null, sorts: [] };
      calls.push(call);
      const result = () => {
        if (failures[table]) return { data: null, error: { message: 'private-database-fixture-error' } };
        let rows = clone(seed[table] || []).filter(row => call.filters.every(filter => filter(row)));
        for (const [key, ascending] of [...call.sorts].reverse()) rows.sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * (ascending ? 1 : -1));
        if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
        if (call.limit != null) rows = rows.slice(0, call.limit);
        return { data: rows, error: null };
      };
      const q = {
        select(columns) { call.columns = columns; return q; },
        eq(key, value) { call.filters.push(row => String(row[key]) === String(value)); return q; },
        in(key, values) { call.filters.push(row => values.map(String).includes(String(row[key]))); return q; },
        neq(key, value) { call.filters.push(row => String(row[key]) !== String(value)); return q; },
        is(key, value) { call.filters.push(row => row[key] === value); return q; },
        gte(key, value) { call.filters.push(row => row[key] >= value); return q; },
        lte(key, value) { call.filters.push(row => row[key] <= value); return q; },
        lt(key, value) { call.filters.push(row => row[key] < value); return q; },
        order(key, { ascending = true } = {}) { call.sorts.push([key, ascending]); return q; },
        range(from, to) { call.range = [from, to]; return q; },
        limit(limit) { call.limit = limit; return q; },
        insert: mutation, update: mutation, upsert: mutation, delete: mutation,
        async maybeSingle() { const r = result(); return { ...r, data: r.data?.[0] || null }; },
        async single() { const r = result(); return { ...r, data: r.data?.[0] || null }; },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return q;
    },
  };
  return { db, calls, seed };
}

async function request({ db, method = 'POST', headers = {}, body = { month, expectedActorId: workerId } } = {}) {
  let createdClients = 0;
  const handler = createWorkerBonusAccountHandler({ createClient: () => { createdClients++; return db || fixture().db; } });
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = JSON.parse(value); } };
  await handler({ method, headers: {
    host: 'tepiha.test', origin: 'https://tepiha.test', 'content-type': 'application/json',
    cookie: `tepiha_device_id=${deviceId}`, ...headers,
  }, body }, res);
  return { ...res, createdClients };
}

const original = clone(modelInput());
const report = buildWorkerBonusAccount(modelInput());
const source = name => report.sources.find(s => s.source === name);
assert.deepEqual(report.worker, { id: workerId, name: worker.name });
assert.equal(report.timezone, 'Europe/Belgrade');
assert.deepEqual(report.totals, {
  earned: 3.25, earnedCount: 3, retained: 2.5, retainedCount: 3,
  available: 1.2, reserved: 0.5, retainedAllTime: 3.55, ledgerRetainedAllTime: 3.55,
});
assert.equal(source('BASE').earned, 2.75);
assert.equal(source('BASE').retained, 2);
assert.equal(source('BASE').available, 0.7);
assert.equal(source('TRANSPORT_CONTROL').earned, 0.5);
assert.equal(source('TRANSPORT_CONTROL').retained, 0.5);
assert.equal(source('TRANSPORT_CONTROL').available, 0.5);
assert.deepEqual(report.warnings, []);
assert.deepEqual(modelInput(), original, 'Building a report must not mutate source records.');
assert(!JSON.stringify(report).includes('fixture-private-payment-actor'));
assert(!JSON.stringify(report).includes('worker_pin'));
assert.deepEqual(buildWorkerBonusAccount(modelInput({ worker: { ...worker, pay_ready_bonus_enabled: false } })).totals, report.totals);
pass('Base and Transport amounts stay separate, add in cents, and remain visible independent of the handoff profile flag.');

assert.equal(workerBonusMonthKey('2026-10-31T22:59:59Z'), '2026-10');
assert.equal(workerBonusMonthKey('2026-10-31T23:00:00Z'), '2026-11');
assert.equal(workerBonusMonthKey('2026-11-30T22:59:59Z'), '2026-11');
assert.equal(workerBonusMonthKey('2026-11-30T23:00:00Z'), '2026-12');
assert.equal(workerBonusMonthKey('2026-07-31T22:00:00Z'), '2026-08', 'Summer boundary follows Belgrade daylight saving.');
assert(report.rows.some(r => r.id === '101'), 'Previous-month earnings retained this month stay visible.');
assert(report.rows.some(r => r.id === '202'), 'An older available Transport bonus stays visible.');
assert(!report.rows.some(r => r.id === '105'), 'Closed older bonuses need not clutter current-month detail.');
assert(report.handoffs.some(h => h.id === '301'), 'A handoff submitted last month and accepted this month stays visible.');
const december = buildWorkerBonusAccount(modelInput({ month: '2026-12' }));
assert.equal(december.totals.earned, 0.2);
assert.equal(december.totals.retained, 0.75);
assert(december.rows.some(r => r.id === '103'));
assert.equal(buildWorkerBonusAccount(modelInput({ month: undefined, now: '2026-10-31T23:00:00Z' })).month, '2026-11');
pass('Earnings use qualification dates; cash taken uses acceptance dates, including carried balances and local month boundaries.');

assert.equal(report.pendingControls.length, 1);
assert.deepEqual(report.pendingControls[0], {
  id: 'pending-1', code: 'T901', status: 'PENDING', orderStatus: 'pastrim',
  submittedAt: '2026-11-18T08:00:00Z', potentialAmount: 0.5, blocked: false,
});
assert.deepEqual(buildWorkerBonusAccount(modelInput({ pendingControls: [] })).totals, report.totals);
const blocked = buildWorkerBonusAccount(modelInput({ pendingControls: [{ ...pendingControls[0], order: { code_str: 'T901', status: 'dorzim' } }] }));
assert.equal(blocked.pendingControls[0].blocked, true);
assert.deepEqual(blocked.totals, report.totals);
assert.equal(report.rows.find(r => r.id === '201').code, 'T201');
assert.equal(report.rows.find(r => r.id === '201').source, 'TRANSPORT_CONTROL');
assert.equal(report.handoffs.find(h => h.id === '305').transport, 0.5);
assert.equal(report.handoffs.find(h => h.id === '303').base, 0.5);
const mixed = buildWorkerBonusAccount(modelInput({ allocations: allocations.map(a => a.id === 405 ? { ...a, handoff_id: 302 } : a) }));
const mixedHandoff = mixed.handoffs.find(h => h.id === '302');
assert.equal(mixedHandoff.base, 1);
assert.equal(mixedHandoff.transport, 0.5);
assert.equal(mixedHandoff.total, 1.5);
assert.deepEqual(mixed.totals, report.totals, 'Combining sources in one cash handoff must not change earnings or retained totals.');
pass('Transport approval creates the fixed bonus; pending/returned controls never inflate earnings or paid totals.');

const historicBonus = baseBonus(199, { amount: 4.91, m2: 49.1, retained_amount: 4.91, order_code: 777, qualification_at: '2026-08-10T08:00:00Z' });
const duplicateInput = modelInput({
  bonuses: [historicBonus], pendingControls: [],
  allocations: [
    { id: 501, bonus_id: 199, handoff_id: 601, amount: 4.91, status: 'RETAINED' },
    { id: 502, bonus_id: 199, handoff_id: 602, amount: 4.91, status: 'RETAINED' },
  ],
  handoffs: [
    { id: 601, status: 'ACCEPTED', submitted_at: '2026-11-14T08:00:00Z', decided_at: '2026-11-14T09:00:00Z' },
    { id: 602, status: 'ACCEPTED', submitted_at: '2026-11-15T08:00:00Z', decided_at: '2026-11-15T09:00:00Z' },
  ],
});
const duplicateBefore = clone(duplicateInput);
const duplicateReport = buildWorkerBonusAccount(duplicateInput);
assert.equal(duplicateReport.totals.earned, 0);
assert.equal(duplicateReport.totals.retained, 9.82);
assert.equal(duplicateReport.totals.retainedAllTime, 9.82);
assert.equal(duplicateReport.totals.ledgerRetainedAllTime, 4.91);
assert.equal(duplicateReport.totals.retainedCount, 1, 'Retention count means distinct bonuses, not allocation events.');
assert.equal(duplicateReport.rows[0].retained, 9.82);
assert.equal(duplicateReport.rows[0].ledgerRetained, 4.91);
assert.equal(duplicateReport.rows[0].reconciliationDifference, 4.91);
assert.deepEqual(duplicateReport.warnings, [{ code: 'RETAINED_MISMATCH', bonusId: '199', orderCode: '777', difference: 4.91 }]);
assert.deepEqual(duplicateInput, duplicateBefore, 'A discrepancy is reported; no synthetic ledger or allocation is repaired.');
pass('Duplicate historical accepted allocations remain visible as a reconciliation warning and never change the ledger.');

const undated = buildWorkerBonusAccount({
  ...duplicateInput,
  allocations: duplicateInput.allocations.slice(0, 1),
  handoffs: [{ ...duplicateInput.handoffs[0], decided_at: null }],
});
assert.equal(undated.totals.retained, 0, 'Missing acceptance time cannot be assigned to the earning or submission month.');
assert.equal(undated.totals.retainedAllTime, 4.91);
assert(undated.warnings.some(w => w.code === 'RETENTION_DATE_MISSING'));
const missingHandoff = buildWorkerBonusAccount({ ...duplicateInput, allocations: duplicateInput.allocations.slice(0, 1), handoffs: [] });
assert.equal(missingHandoff.totals.retained, 0);
assert(missingHandoff.warnings.some(w => w.code === 'HANDOFF_MISSING'));
const returnedAllocation = buildWorkerBonusAccount(modelInput({
  bonuses: [controlBonus(209, { status: 'EARNED', remaining_amount: 0.5, retained_amount: 0 })],
  allocations: [{ id: 509, bonus_id: 209, handoff_id: 609, amount: 0.5, status: 'REVERSED' }],
  handoffs: [{ id: 609, status: 'REJECTED', submitted_at: '2026-11-14T08:00:00Z', decided_at: '2026-11-14T09:00:00Z' }],
}));
assert.equal(returnedAllocation.totals.retained, 0);
assert.equal(returnedAllocation.totals.available, 0.5);
assert.deepEqual(returnedAllocation.warnings, []);
pass('Missing acceptance dates, missing handoffs and reversed allocations never become false monthly cash payments.');

const dbFixture = fixture();
const beforeRead = clone(dbFixture.seed);
const response = await request({ db: dbFixture.db, body: { month, expectedActorId: workerId, role: 'ADMIN', pin: manager.pin, user_id: managerId } });
assert.equal(response.statusCode, 200);
assert.deepEqual(response.body.totals, report.totals);
assert.deepEqual(response.body.pendingControls, report.pendingControls);
assert.deepEqual(response.body.worker, report.worker);
assert.deepEqual(dbFixture.seed, beforeRead);
assert.match(response.headers['cache-control'], /private, no-store/);
assert.equal(response.headers['x-content-type-options'], 'nosniff');
assert.equal(response.headers.vary, 'Cookie, Origin');
assert(dbFixture.calls.every(c => c.columns && c.columns !== '*'), 'No report query may request whole financial rows.');
for (const secret of [worker.pin, manager.pin, 'fixture-private-payment-actor', deviceId, 'worker_pin', 'created_by_pin', 'device_id']) assert(!JSON.stringify(response.body).includes(secret));
assert(!dbFixture.calls.some(c => c.table === 'orders'), 'Missing Base order relations must not remove bonus records.');
pass('The actual endpoint reads ledger and allocations without joining away Transport, emits no PIN/device metadata, and performs no writes.');

const foreignBonus = baseBonus(909, { worker_pin: otherWorker.pin, amount: 999, m2: 9990, status: 'EARNED', remaining_amount: 999, retained_amount: 0, metadata: { secret: 'foreign-worker-row' } });
const scoped = fixture({ base_ready_bonuses: [...bonuses, foreignBonus] });
assert.deepEqual((await request({ db: scoped.db })).body.totals, report.totals);
const cross = await request({ body: { month, targetPin: otherWorker.pin, role: 'OWNER', expectedActorId: workerId } });
assert.equal(cross.statusCode, 403);
assert.equal(cross.body.error, 'WORKER_BONUS_FORBIDDEN');
const otherOwn = await request({ db: fixture({ tepiha_user_devices: [{ user_id: otherId, device_id: deviceId, is_approved: true }] }).db, body: { month, expectedActorId: otherId } });
assert.equal(otherOwn.statusCode, 200);
assert.equal(otherOwn.body.worker.id, otherId);
assert.equal(otherOwn.body.totals.earned, 0);
assert.equal(otherOwn.body.rows.length, 0);
const managerRoles = [...ADMIN_ROLES, 'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER'];
for (const role of managerRoles) {
  const f = fixture({
    users: [worker, otherWorker, { ...manager, role: ` ${role.toLowerCase()} ` }],
    tepiha_user_devices: [{ user_id: managerId, device_id: deviceId, is_approved: true }],
  });
  const result = await request({ db: f.db, body: { month, targetPin: worker.pin, expectedActorId: managerId } });
  assert.equal(result.statusCode, 200, role);
  assert.deepEqual(result.body.totals, report.totals, role);
}
for (const role of ['PUNTOR', 'PUNETOR', 'WORKER', 'BAZIST', 'BASE', 'TRANSPORT']) {
  const f = fixture({ users: [{ ...worker, role }, otherWorker, manager] });
  assert.equal((await request({ db: f.db })).statusCode, 200, role);
  assert.equal((await request({ db: f.db, body: { month, targetPin: otherWorker.pin } })).statusCode, 403, role);
}
pass('Cookie identity fixes the worker scope; staff can read only their own account, while every manager alias can inspect a target account.');

for (const overrides of [
  { tepiha_user_devices: [] },
  { tepiha_user_devices: [{ user_id: workerId, device_id: deviceId, is_approved: false }] },
  { users: [] },
  { users: [{ ...worker, is_active: false }] },
  { users: [{ ...worker, is_active: undefined }] },
  { users: [{ ...worker, role: 'CLIENT' }] },
]) {
  const f = fixture(overrides);
  const result = await request({ db: f.db, body: { month, role: 'OWNER', targetPin: worker.pin, expectedActorId: workerId } });
  assert.equal(result.statusCode, 403);
  assert(!f.calls.some(c => c.table === 'base_ready_bonuses'));
}
for (const suppliedId of [otherId, '', 42]) {
  const f = fixture();
  const result = await request({ db: f.db, body: { month, expectedActorId: suppliedId } });
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.error, 'WORKER_BONUS_SESSION_CHANGED');
  assert(!f.calls.some(c => c.table === 'base_ready_bonuses'));
}
await assert.rejects(authenticateWorkerBonusActor(fixture().db, ''), /AUTH_REQUIRED/);
await assert.rejects(readWorkerBonusAccount({ month }, { supabase: fixture().db, actor: { ...worker, is_active: false } }), /WORKER_BONUS_FORBIDDEN/);
await assert.rejects(readWorkerBonusAccount({ month }, { supabase: fixture().db }), /WORKER_BONUS_FORBIDDEN/);
pass('Unapproved devices, disabled/missing users, unsupported roles and switched sessions fail before financial reads.');

for (const [input, status, error] of [
  [{ method: 'GET' }, 405, 'METHOD_NOT_ALLOWED'],
  [{ headers: { origin: '' } }, 403, 'ORIGIN_NOT_ALLOWED'],
  [{ headers: { origin: 'https://other.test' } }, 403, 'ORIGIN_NOT_ALLOWED'],
  [{ headers: { 'sec-fetch-site': 'cross-site' } }, 403, 'ORIGIN_NOT_ALLOWED'],
  [{ headers: { 'content-type': 'text/plain' } }, 415, 'CONTENT_TYPE_NOT_ALLOWED'],
  [{ headers: { 'content-length': '2049' } }, 413, 'WORKER_BONUS_BODY_TOO_LARGE'],
  [{ body: { month, extra: 'x'.repeat(2049) } }, 413, 'WORKER_BONUS_BODY_TOO_LARGE'],
  [{ body: [] }, 400, 'WORKER_BONUS_BODY_INVALID'],
  [{ headers: { cookie: '' }, body: { month, deviceId } }, 401, 'AUTH_REQUIRED'],
  [{ headers: { cookie: 'tepiha_device_id=%GG' } }, 401, 'AUTH_REQUIRED'],
]) {
  const result = await request(input);
  assert.equal(result.statusCode, status);
  assert.equal(result.body.error, error);
  assert.equal(result.createdClients, 0);
}
for (const invalid of ['2026-00', '2026-13', '26-11', '2026-1', '', null, [], 202611]) {
  const f = fixture();
  const result = await request({ db: f.db, body: { month: invalid } });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, 'WORKER_BONUS_MONTH_INVALID');
  assert(!f.calls.some(c => c.table === 'base_ready_bonuses'));
}
for (const invalid of ['', '1', 'x', '7001 OR true', '700170017001', {}]) {
  const result = await request({ body: { month, targetPin: invalid } });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, 'WORKER_BONUS_WORKER_INVALID');
}
for (const table of ['tepiha_user_devices', 'users', 'base_ready_bonuses', 'transport_controls', 'base_ready_bonus_allocations', 'transport_orders', 'cash_handoffs']) {
  const result = await request({ db: fixture({}, { [table]: true }).db });
  assert.equal(result.statusCode, 503, table);
  assert(!JSON.stringify(result.body).includes('private-database-fixture-error'));
  assert.equal(result.body.ok, false);
}
pass('Same-origin JSON, bounded inputs, authenticated sessions and explicit database failure responses protect the report boundary.');

const many = Array.from({ length: 1001 }, (_, i) => baseBonus(4000 + i, {
  amount: 0.01, m2: 0.1, remaining_amount: 0.01, reserved_amount: 0, retained_amount: 0,
  status: 'EARNED', qualification_at: '2026-11-02T08:00:00Z',
}));
const paginated = fixture({ base_ready_bonuses: many, base_ready_bonus_allocations: [], transport_controls: [], cash_handoffs: [] });
const large = await request({ db: paginated.db });
assert.equal(large.statusCode, 200);
assert.equal(large.body.totals.earnedCount, 1001);
assert.equal(large.body.totals.earned, 10.01);
assert.equal(large.body.totals.available, 10.01);
assert.equal(large.body.rows.length, 1001);
assert.deepEqual(paginated.calls.filter(c => c.table === 'base_ready_bonuses').map(c => c.range), [[0, 499], [500, 999], [1000, 1499]]);
pass('Historical ledger pagination includes every row and sums small monetary amounts without floating-point drift.');

// The UI fixture deliberately substitutes its network client. Exercise the
// actual client separately so denied access can never revive a prior cache.
const clientBundle = await build({
  entryPoints: ['lib/workerBonusAccountClient.js'], bundle: true, write: false,
  format: 'iife', globalName: 'BonusClient', platform: 'browser',
  plugins: [{ name: 'isolated-bonus-session', setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/actorSession$/ }, () => ({ path: 'fixture-actor', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const getActor = () => globalThis.fixtureActor;', loader: 'js' }));
  } }],
});
const clientCalls = [];
const okReply = marker => ({ ok: true, status: 200, json: async () => ({ ok: true, marker, worker: { id: workerId, name: worker.name } }) });
let reply = async () => okReply('allowed-snapshot');
const context = vm.createContext({
  fixtureActor: clone(manager), navigator: { onLine: true }, AbortController, setTimeout, clearTimeout,
  fetch: async (url, options) => {
    assert.equal(url, '/api/worker-bonuses');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    const body = JSON.parse(options.body);
    assert.equal(body.expectedActorId, context.fixtureActor.id);
    clientCalls.push(body);
    return reply(body);
  },
});
vm.runInContext(clientBundle.outputFiles[0].text, context);
const fetchAccount = context.BonusClient.fetchWorkerBonusAccount;
const queryMonth = (selected, force = false) => fetchAccount({ targetPin: worker.pin, month: selected, force });
assert.equal((await queryMonth('2026-11')).marker, 'allowed-snapshot');
assert.equal((await queryMonth('2026-10')).marker, 'allowed-snapshot');
await queryMonth('2026-11');
assert.equal(clientCalls.length, 2, 'A successful same-actor cache is reused.');
let resolvePending;
reply = () => new Promise(resolve => { resolvePending = resolve; });
const pendingReport = queryMonth('2026-09');
assert(resolvePending);
reply = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'WORKER_BONUS_FORBIDDEN' }) });
const denied = error => error.code === 'WORKER_BONUS_FORBIDDEN' && error.httpStatus === 403;
await assert.rejects(queryMonth('2026-11', true), denied);
await assert.rejects(queryMonth('2026-10'), denied, 'A denial must clear other cached months for the same actor.');
const staleGeneration = assert.rejects(pendingReport, error => error.code === 'WORKER_BONUS_SESSION_CHANGED' && error.httpStatus === 403);
resolvePending(okReply('must-never-revive-after-denial'));
await staleGeneration;
reply = async () => okReply('fresh-authorized-snapshot');
assert.equal((await queryMonth('2026-09')).marker, 'fresh-authorized-snapshot');
let resolveOldActor;
reply = () => new Promise(resolve => { resolveOldActor = resolve; });
const actorRequest = queryMonth('2026-08');
context.fixtureActor = clone(otherWorker);
const switched = assert.rejects(actorRequest, error => error.code === 'WORKER_BONUS_SESSION_CHANGED' && error.httpStatus === 403);
resolveOldActor(okReply('must-never-cross-actor-boundary'));
await switched;
context.fixtureActor = clone(manager);
reply = async () => okReply('fresh-after-session-change');
assert.equal((await queryMonth('2026-09')).marker, 'fresh-after-session-change', 'A switched session clears the previous actor cache.');
pass('The actual HTTP client revokes every cached month on denial and rejects prior in-flight responses after denial or actor changes.');

console.log(`Verified ${checked} worker bonus account groups.`);
