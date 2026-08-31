import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DispatchOrderServerError,
  createDispatchTransportOrderServer,
} from '../lib/transport/dispatchOrderServer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const ACTOR = {
  id: '22222222-2222-4222-8222-222222222222',
  pin: '4563',
  name: 'Dispatch Test',
  role: 'DISPATCH',
};

const clone = (value) => (value == null ? value : structuredClone(value));
const digits = (value) => Number(String(value || '').replace(/\D+/g, '')) || 0;
const phoneKey = (value) => String(value || '').replace(/\D+/g, '').replace(/^0/, '383');

function request(id, phone, name = 'Klienti Test') {
  return {
    id,
    client_name: name,
    client_phone: phone,
    status: 'inbox',
    data: {
      note: 'Test race/retry',
      pickup_date: '2026-08-31',
      pickup_slot: 'morning',
      pickup_window: '09:00 – 13:00',
      planning_bucket: 'tomorrow',
      planned_pieces: 2,
    },
  };
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
  }

  select() { return this; }
  eq(column, value) {
    this.filters.push((row) => String(row?.[column] ?? '') === String(value ?? ''));
    return this;
  }

  rows() {
    let rows = Array.isArray(this.db.state[this.table]) ? this.db.state[this.table] : [];
    for (const filter of this.filters) rows = rows.filter(filter);
    return rows;
  }

  async maybeSingle() {
    const rows = this.rows();
    return { data: clone(rows[0] || null), error: null };
  }
}

/**
 * Transactional fake for the server boundary. It deliberately starts with an
 * unsorted pool. UUID and phone locks model the two DB advisory locks, while a
 * working copy models rollback if the response fails before commit.
 */
class AtomicTransportDb {
  constructor({
    pool = [],
    nextFreshCode = 1300,
    commitThenErrorOnce = false,
    rollbackAfterClaimOnce = false,
  } = {}) {
    this.state = {
      transport_orders: [],
      transport_clients: [],
      transport_code_pool: pool.map((code) => ({ code, code_n: digits(code), status: 'available' })),
      transport_code_allocator_state_v2: { next_fresh: nextFreshCode },
    };
    this.commitThenErrorOnce = commitThenErrorOnce;
    this.rollbackAfterClaimOnce = rollbackAfterClaimOnce;
    this.didLoseResponse = false;
    this.didRollback = false;
    this.locks = new Map();
    this.calls = { rpc: 0, claimAttempts: 0, allocations: 0 };
  }

  from(table) { return new Query(this, table); }

  async withLock(key, run) {
    const prior = this.locks.get(key) || Promise.resolve();
    let release;
    const blocker = new Promise((resolve) => { release = resolve; });
    this.locks.set(key, prior.then(() => blocker));
    await prior;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(key) === blocker) this.locks.delete(key);
    }
  }

  rpcResult(order, idempotent) {
    return {
      success: true,
      order_id: order.id,
      client_id: order.client_id,
      code_str: order.code_str,
      client_tcode: order.client_tcode,
      visit_nr: order.visit_nr,
      idempotent,
      allocated_in_transaction: !idempotent,
    };
  }

  async rpc(name, args = {}) {
    assert.equal(name, 'create_transport_order', 'Dispatch must allocate through the create RPC');
    assert.equal(args.p_code_str, null, 'Dispatch must not pre-reserve a code');
    assert.equal(args.p_code_n, null, 'Dispatch must not send a numeric code');
    this.calls.rpc += 1;

    // Let concurrent requests both finish their browser/server preflight before
    // entering the simulated DB transaction.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const normalizedPhone = phoneKey(args.p_client_phone);
    return this.withLock(`order:${args.p_id}`, () => this.withLock(`phone:${normalizedPhone}`, async () => {
      const existingOrder = this.state.transport_orders.find((row) => row.id === args.p_id);
      if (existingOrder) return { data: this.rpcResult(existingOrder, true), error: null };

      const transactionStart = clone(this.state);
      let client = this.state.transport_clients.find((row) => row.phone_key === normalizedPhone);
      if (!client) {
        const availableCandidate = this.state.transport_code_pool
          .filter((row) => row.status === 'available')
          .sort((a, b) => a.code_n - b.code_n)[0];
        let freshCodeN = this.state.transport_code_allocator_state_v2.next_fresh;
        while (this.state.transport_code_pool.some((row) => row.code_n === freshCodeN)) freshCodeN += 1;
        let candidate = availableCandidate;
        if (!availableCandidate || freshCodeN < availableCandidate.code_n) {
          // Unlike nextval(), this cursor lives in the same transaction state.
          // A later client/order failure restores both cursor and inserted row.
          this.state.transport_code_allocator_state_v2.next_fresh = freshCodeN + 1;
          candidate = { code: `T${freshCodeN}`, code_n: freshCodeN, status: 'available' };
          this.state.transport_code_pool.push(candidate);
        }
        candidate.status = 'used';
        this.calls.claimAttempts += 1;
        this.calls.allocations += 1;
        client = {
          id: `44444444-4444-4444-8444-${String(this.state.transport_clients.length + 1).padStart(12, '0')}`,
          phone_key: normalizedPhone,
          tcode: candidate.code,
        };
        this.state.transport_clients.push(client);

        if (this.rollbackAfterClaimOnce && !this.didRollback) {
          this.didRollback = true;
          this.state = transactionStart;
          this.calls.allocations -= 1;
          return { data: null, error: { message: 'SIMULATED_INSERT_FAILURE_AFTER_CLAIM' } };
        }
      }

      const visitNr = this.state.transport_orders.filter((row) => row.client_id === client.id).length + 1;
      const data = {
        ...clone(args.p_data),
        code_str: client.tcode,
        order_code: client.tcode,
        transport_client_tcode: client.tcode,
        client_id: client.id,
        client: {
          ...clone(args.p_data?.client),
          id: client.id,
          tcode: client.tcode,
          transport_client_tcode: client.tcode,
        },
      };
      const order = {
        id: args.p_id,
        client_id: client.id,
        client_phone: args.p_client_phone,
        client_tcode: client.tcode,
        code_str: client.tcode,
        code_n: digits(client.tcode),
        visit_nr: visitNr,
        status: args.p_status,
        transport_create_fingerprint_v1: args.p_data.transport_create_fingerprint_v1,
        data,
      };
      this.state.transport_orders.push(order);

      if (this.commitThenErrorOnce && !this.didLoseResponse) {
        this.didLoseResponse = true;
        return { data: null, error: { message: 'SIMULATED_RESPONSE_LOST_AFTER_COMMIT' } };
      }
      return { data: this.rpcResult(order, false), error: null };
    }));
  }

  assertNoStrandedCodes() {
    const referenced = new Set(this.state.transport_clients.map((row) => row.tcode));
    const used = this.state.transport_code_pool.filter((row) => row.status === 'used');
    assert.deepEqual(
      used.map((row) => row.code).sort((a, b) => digits(a) - digits(b)),
      Array.from(referenced).sort((a, b) => digits(a) - digits(b)),
      'every used pool code must belong to exactly one canonical client',
    );
  }
}

// Unsorted pool: a new client must receive the numerically smallest code.
{
  const db = new AtomicTransportDb({ pool: ['T90', 'T4', 'T18', 'T3'] });
  const result = await createDispatchTransportOrderServer(
    request('11111111-1111-4111-8111-111111111111', '044 111 222'),
    { supabase: db, authUser: ACTOR },
  );
  assert.equal(result.data.code_str, 'T3');
  assert.equal(db.calls.allocations, 1);
  db.assertNoStrandedCodes();
}

// "Smallest" is global across the explicitly AVAILABLE pool and the
// transactional fresh cursor. A high released row must not hide a lower fresh
// number; a lower released row still wins. Missing historical gaps are never
// inferred as reusable candidates.
{
  const highPool = new AtomicTransportDb({ pool: ['T1500'], nextFreshCode: 1300 });
  const freshWins = await createDispatchTransportOrderServer(
    request('12121212-1212-4121-8121-121212121212', '044 130 000'),
    { supabase: highPool, authUser: ACTOR },
  );
  assert.equal(freshWins.data.code_str, 'T1300');
  assert.equal(highPool.state.transport_code_pool.find((row) => row.code === 'T1500').status, 'available');
  assert.equal(highPool.state.transport_code_allocator_state_v2.next_fresh, 1301);
  assert.notEqual(freshWins.data.code_str, 'T989', 'an absent historical numeric gap was incorrectly recycled');
  highPool.assertNoStrandedCodes();

  const lowPool = new AtomicTransportDb({ pool: ['T1500', 'T1233'], nextFreshCode: 1300 });
  const poolWins = await createDispatchTransportOrderServer(
    request('13131313-1313-4131-8131-131313131313', '044 123 300'),
    { supabase: lowPool, authUser: ACTOR },
  );
  assert.equal(poolWins.data.code_str, 'T1233');
  assert.equal(lowPool.state.transport_code_allocator_state_v2.next_fresh, 1300, 'pool claim advanced the unused fresh cursor');
  lowPool.assertNoStrandedCodes();
}

// Concurrent duplicate taps with one UUID may execute two RPC calls, while the
// DB transaction allocates one code and both callers observe the same order.
{
  const db = new AtomicTransportDb({ pool: ['T90', 'T4', 'T18', 'T3'] });
  const payload = request('55555555-5555-4555-8555-555555555555', '044 222 333');
  const [first, duplicate] = await Promise.all([
    createDispatchTransportOrderServer(payload, { supabase: db, authUser: ACTOR }),
    createDispatchTransportOrderServer(payload, { supabase: db, authUser: ACTOR }),
  ]);
  assert.equal(first.data.id, payload.id);
  assert.equal(duplicate.data.id, payload.id);
  assert.equal(first.data.code_str, 'T3');
  assert.equal(duplicate.data.code_str, 'T3');
  assert.equal(db.state.transport_orders.length, 1, 'duplicate UUID must create one order');
  assert.equal(db.calls.allocations, 1, 'duplicate UUID must consume one pool code');
  db.assertNoStrandedCodes();
}

// A reused UUID with changed business identity must fail before another DB
// claim. Both phone and fingerprint conflicts leave the pool untouched.
{
  const db = new AtomicTransportDb({ pool: ['T40', 'T6', 'T2'] });
  const id = '56565656-5656-4565-8565-565656565656';
  const original = request(id, '044 606 707');
  await createDispatchTransportOrderServer(original, { supabase: db, authUser: ACTOR });
  assert.equal(db.calls.allocations, 1);

  await assert.rejects(
    createDispatchTransportOrderServer(request(id, '049 999 777'), { supabase: db, authUser: ACTOR }),
    (error) => error instanceof DispatchOrderServerError
      && error.code === 'TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT',
  );
  await assert.rejects(
    createDispatchTransportOrderServer({
      ...original,
      data: { ...original.data, note: 'Identitet tjetër biznesi' },
    }, { supabase: db, authUser: ACTOR }),
    (error) => error instanceof DispatchOrderServerError
      && error.code === 'DISPATCH_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT',
  );
  assert.equal(db.calls.allocations, 1, 'UUID conflicts cannot mutate the pool');
  assert.equal(db.state.transport_code_pool.find((row) => row.code === 'T6').status, 'available');
  db.assertNoStrandedCodes();
}

// A committed write with a lost response must be recovered by the same UUID;
// the retry cannot consume the next available code.
{
  const db = new AtomicTransportDb({
    pool: ['T21', 'T2', 'T8'],
    commitThenErrorOnce: true,
  });
  const payload = request('66666666-6666-4666-8666-666666666666', '049 333 444');
  await assert.rejects(
    createDispatchTransportOrderServer(payload, { supabase: db, authUser: ACTOR }),
    (error) => error instanceof DispatchOrderServerError && error.code === 'DISPATCH_ORDER_RPC_FAILED',
  );
  const retry = await createDispatchTransportOrderServer(payload, { supabase: db, authUser: ACTOR });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.data.code_str, 'T2');
  assert.equal(db.state.transport_orders.length, 1);
  assert.equal(db.calls.allocations, 1, 'lost-response retry must not allocate again');
  assert.equal(db.state.transport_code_pool.find((row) => row.code === 'T8').status, 'available');
  db.assertNoStrandedCodes();
}

// Same phone with different UUIDs is a legitimate second visit. It reuses the
// permanent client code and cannot reserve another pool row.
{
  const db = new AtomicTransportDb({ pool: ['T50', 'T9', 'T4'] });
  const [first, second] = await Promise.all([
    createDispatchTransportOrderServer(
      request('99999999-9999-4999-8999-999999999999', '045 777 888', 'Vizita 1'),
      { supabase: db, authUser: ACTOR },
    ),
    createDispatchTransportOrderServer(
      request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '045 777 888', 'Vizita 2'),
      { supabase: db, authUser: ACTOR },
    ),
  ]);
  assert.equal(first.data.code_str, 'T4');
  assert.equal(second.data.code_str, 'T4');
  assert.equal(db.state.transport_clients.length, 1, 'same normalized phone must keep one client');
  assert.equal(db.state.transport_orders.length, 2, 'different UUIDs remain two visits');
  assert.equal(db.calls.allocations, 1, 'second visit cannot claim another code');
  db.assertNoStrandedCodes();
}

// A failure after the pool claim but before the order insert must roll back the
// whole transaction. Retrying may then claim the same smallest code safely.
{
  const db = new AtomicTransportDb({
    pool: ['T30', 'T6', 'T1'],
    rollbackAfterClaimOnce: true,
  });
  const payload = request('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '048 999 111');
  await assert.rejects(
    createDispatchTransportOrderServer(payload, { supabase: db, authUser: ACTOR }),
    (error) => error instanceof DispatchOrderServerError && error.code === 'DISPATCH_ORDER_RPC_FAILED',
  );
  assert.equal(db.state.transport_orders.length, 0);
  assert.equal(db.state.transport_clients.length, 0);
  assert.deepEqual(
    db.state.transport_code_pool.filter((row) => row.status === 'used'),
    [],
    'failed transaction cannot strand the claimed code',
  );

  const retry = await createDispatchTransportOrderServer(payload, { supabase: db, authUser: ACTOR });
  assert.equal(retry.data.code_str, 'T1');
  assert.equal(db.calls.claimAttempts, 2, 'retry performs a fresh claim after rollback');
  assert.equal(db.calls.allocations, 1, 'only the committed claim remains used');
  db.assertNoStrandedCodes();
}

// The empty-pool fallback must use a transactional cursor, not nextval(). A
// failed client/order insert rolls the fresh number back too, so retry receives
// the same smallest fresh T-code instead of silently burning it.
{
  const db = new AtomicTransportDb({
    pool: [],
    nextFreshCode: 1300,
    rollbackAfterClaimOnce: true,
  });
  const payload = request('bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc', '048 222 111');
  await assert.rejects(
    createDispatchTransportOrderServer(payload, { supabase: db, authUser: ACTOR }),
    (error) => error instanceof DispatchOrderServerError && error.code === 'DISPATCH_ORDER_RPC_FAILED',
  );
  assert.equal(db.state.transport_code_allocator_state_v2.next_fresh, 1300, 'failed transaction burned the fresh allocator cursor');
  assert.equal(db.state.transport_code_pool.length, 0, 'failed fresh claim left a pool row behind');

  const retry = await createDispatchTransportOrderServer(payload, { supabase: db, authUser: ACTOR });
  assert.equal(retry.data.code_str, 'T1300');
  assert.equal(db.state.transport_code_allocator_state_v2.next_fresh, 1301);
  assert.equal(db.calls.claimAttempts, 2);
  assert.equal(db.calls.allocations, 1);
  db.assertNoStrandedCodes();
}

// Two new phones can race. Claims must be distinct and strictly consume the
// two lowest numeric codes from the original pool.
{
  const db = new AtomicTransportDb({ pool: ['T100', 'T12', 'T7', 'T2'] });
  const [first, second] = await Promise.all([
    createDispatchTransportOrderServer(
      request('77777777-7777-4777-8777-777777777777', '044 555 111', 'Klienti A'),
      { supabase: db, authUser: ACTOR },
    ),
    createDispatchTransportOrderServer(
      request('88888888-8888-4888-8888-888888888888', '044 555 222', 'Klienti B'),
      { supabase: db, authUser: ACTOR },
    ),
  ]);
  assert.deepEqual(
    [first.data.code_str, second.data.code_str].sort((a, b) => digits(a) - digits(b)),
    ['T2', 'T7'],
  );
  assert.equal(db.calls.allocations, 2);
  db.assertNoStrandedCodes();
}

function extractFunction(sql, name) {
  const matcher = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'ig');
  let match;
  let block = '';
  while ((match = matcher.exec(sql))) {
    const start = match.index;
    const open = sql.indexOf('$$', start);
    const close = open >= 0 ? sql.indexOf('$$;', open + 2) : -1;
    if (open >= 0 && close > open) block = sql.slice(start, close + 3);
  }
  return block;
}

function stripSqlComments(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*(?:\n|$)/g, '\n');
}

function locate(sql, pattern, message) {
  const match = pattern.exec(sql);
  assert.ok(match, message);
  return {
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  };
}

function statementAt(sql, pattern, message) {
  const start = locate(sql, pattern, message).start;
  const end = sql.indexOf(';', start);
  assert.ok(end >= 0, `${message}: unterminated SQL statement`);
  return { start, end: end + 1, text: sql.slice(start, end + 1) };
}

const migrationFiles = fs.readdirSync(migrationsDir)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();
const migrationSources = migrationFiles.map((name) => ({
  name,
  sql: fs.readFileSync(path.join(migrationsDir, name), 'utf8'),
}));

const allocatorDefinitions = migrationSources
  .map(({ name, sql }) => ({ name, block: extractFunction(sql, 'reserve_transport_codes_batch') }))
  .filter(({ block }) => block);
assert.ok(
  allocatorDefinitions.length > 0,
  'a migration must version the live reserve_transport_codes_batch allocator',
);
const allocator = allocatorDefinitions.at(-1);
const allocatorSql = allocator.block.toLowerCase();
const allocatorExecutableSql = stripSqlComments(allocatorSql);
const allocatorMigrationSql = migrationSources.find(({ name }) => name === allocator.name)?.sql || '';
const allocatorMigrationLower = allocatorMigrationSql.toLowerCase();
const lifecycleHelperSql = extractFunction(
  allocatorMigrationSql,
  'transport_tcode_has_lifecycle_reference_v2',
).toLowerCase();
const tcodeNumberSql = extractFunction(
  allocatorMigrationSql,
  'transport_tcode_number_v2',
).toLowerCase();
const quotaKeySql = extractFunction(
  allocatorMigrationSql,
  'transport_offline_owner_quota_key_v2',
).toLowerCase();
const safetySql = `${allocatorSql}\n${lifecycleHelperSql}\n${tcodeNumberSql}`;

const migrationIndex = (name) => migrationFiles.indexOf(name);
const atomicMigrationName = '20260830211827_transport_order_atomic_tcode_allocator_v1.sql';
const cleanupV1Name = '20260830212301_dispatch_tcode_stranded_cleanup_v1.sql';
const cleanupV2Name = '20260830221249_dispatch_tcode_stranded_cleanup_v2.sql';
const cleanupV3Name = '20260831071200_dispatch_tcode_stranded_cleanup_v3.sql';
assert.ok(migrationIndex(atomicMigrationName) >= 0, 'atomic create migration missing');
assert.ok(migrationIndex(cleanupV1Name) >= 0, 'first exact cleanup migration missing');
assert.ok(migrationIndex(cleanupV2Name) >= 0, 'second exact cleanup migration missing');
assert.ok(migrationIndex(cleanupV3Name) >= 0, 'third exact cleanup migration missing');
assert.ok(
  migrationIndex(atomicMigrationName) < migrationIndex(allocator.name)
    && migrationIndex(allocator.name) < migrationIndex(cleanupV1Name)
    && migrationIndex(cleanupV1Name) < migrationIndex(cleanupV2Name)
    && migrationIndex(cleanupV2Name) < migrationIndex(cleanupV3Name),
  `unsafe migration order: expected atomic < strict allocator < cleanup v1 < cleanup v2 < cleanup v3, got ${atomicMigrationName}, ${allocator.name}, ${cleanupV1Name}, ${cleanupV2Name}, ${cleanupV3Name}`,
);

assert.match(allocatorSql, /transport-code-allocator-v3/, `${allocator.name}: allocator-wide transaction lock missing`);
assert.match(allocatorSql, /pg_advisory_xact_lock\s*\(/, `${allocator.name}: allocator is not serialized`);
assert.doesNotMatch(allocatorExecutableSql, /skip\s+locked/, `${allocator.name}: SKIP LOCKED breaks strict smallest ordering`);
assert.match(allocatorSql, /status\s*=\s*'available'/, `${allocator.name}: available-pool filter missing`);
assert.match(allocatorSql, /order\s+by[\s\S]{0,320}(?:code_n|regexp_replace)/, `${allocator.name}: numeric ordering missing`);

const availableIndex = allocatorSql.indexOf("status='available'") >= 0
  ? allocatorSql.indexOf("status='available'")
  : allocatorSql.indexOf("status = 'available'");
const orderIndex = allocatorSql.indexOf('order by', availableIndex);
const orderEndCandidates = [
  allocatorSql.indexOf('limit', orderIndex),
  allocatorSql.indexOf('for update', orderIndex),
  allocatorSql.indexOf(';', orderIndex),
].filter((index) => index > orderIndex);
const orderEnd = orderEndCandidates.length ? Math.min(...orderEndCandidates) : orderIndex + 500;
const orderClause = allocatorSql.slice(orderIndex, orderEnd);
assert.ok(orderIndex > availableIndex, `${allocator.name}: ordering must follow the available filter`);
assert.doesNotMatch(orderClause, /\bdesc\b/, `${allocator.name}: allocator sorts largest-first`);
assert.match(orderClause, /(?:code_n|::\s*(?:bigint|integer|numeric))/, `${allocator.name}: lexical T-code ordering is forbidden`);
assert.match(allocatorSql, /update\s+public\.transport_code_pool/, `${allocator.name}: selected pool row is not claimed atomically`);
assert.match(allocatorSql, /status\s*=\s*'used'/, `${allocator.name}: selected code is not marked used`);
assert.match(allocatorSql, /v_wanted\s+constant\s+integer\s*:=\s*1/, `${allocator.name}: legacy public allocator is not hard-capped to one code`);
assert.equal(
  (allocatorSql.match(/\bp_n\b/g) || []).length,
  1,
  `${allocator.name}: caller-controlled p_n must not increase the public allocation count`,
);

// Pool provenance is server-maintained. Installed PWAs retain read-only
// verification, while all direct mutation privileges (including TRUNCATE) are
// removed from PUBLIC/anon/authenticated.
assert.match(
  allocatorMigrationLower,
  /alter\s+table\s+public\.transport_code_pool[\s\S]{0,180}add\s+column\s+if\s+not\s+exists\s+reserved_at\s+timestamptz/,
  `${allocator.name}: pool reservation provenance column missing`,
);
assert.match(allocatorSql, /reserved_at\s*=\s*(?:now\s*\(\)|current_timestamp)/, `${allocator.name}: reused pool claims do not stamp reserved_at`);
assert.match(allocatorMigrationLower, /trg_transport_code_pool_reserved_at_guard_v2/, `${allocator.name}: reserved_at transition guard missing`);
assert.match(
  allocatorMigrationLower,
  /alter\s+table\s+public\.transport_code_pool\s+enable\s+row\s+level\s+security/,
  `${allocator.name}: transport_code_pool RLS is not enabled`,
);
assert.match(
  allocatorMigrationLower,
  /create\s+policy\s+transport_code_pool_read_v2[\s\S]{0,220}for\s+select[\s\S]{0,100}to\s+anon\s*,\s*authenticated[\s\S]{0,100}using\s*\(\s*true\s*\)/,
  `${allocator.name}: cached PWA read-only policy missing`,
);
assert.match(
  allocatorMigrationLower,
  /revoke\s+all\s+on\s+table\s+public\.transport_code_pool\s+from\s+public\s*,\s*anon\s*,\s*authenticated/,
  `${allocator.name}: direct pool privileges (including TRUNCATE) were not fully revoked`,
);
assert.match(
  allocatorMigrationLower,
  /grant\s+select\s+on\s+table\s+public\.transport_code_pool\s+to\s+anon\s*,\s*authenticated/,
  `${allocator.name}: cached reservation SELECT compatibility missing`,
);
assert.doesNotMatch(
  allocatorMigrationLower,
  /grant\s+(?:all|insert|update|delete|truncate)\b[\s\S]{0,160}on\s+table\s+public\.transport_code_pool[\s\S]{0,80}to\s+(?:public|anon|authenticated)/,
  `${allocator.name}: direct pool mutation was re-granted`,
);

// Canonical parsing must be total: corrupt/hostile text returns NULL instead
// of overflowing bigint. New pool and Transport lease writes are constrained
// to the one canonical spelling T<n>, closing T005/T5 semantic duplicates.
assert.ok(tcodeNumberSql, `${allocator.name}: overflow-safe T-code parser missing`);
assert.match(tcodeNumberSql, /9223372036854775807/, `${allocator.name}: bigint boundary is not checked before casting`);
assert.match(tcodeNumberSql, /length\s*\(\s*v_digits\s*\)\s*>\s*19/, `${allocator.name}: unbounded T-code text can reach bigint cast`);
assert.match(allocatorSql, /transport_tcode_number_v2\s*\(/, `${allocator.name}: allocator bypasses the safe canonical parser`);
assert.match(
  allocatorMigrationLower,
  /alter\s+table\s+public\.transport_code_pool[\s\S]{0,500}add\s+constraint\s+\w*canonical\w*[\s\S]{0,300}check/,
  `${allocator.name}: canonical transport_code_pool CHECK missing`,
);
assert.match(
  allocatorMigrationLower,
  /alter\s+table\s+public\.offline_code_leases[\s\S]{0,500}add\s+constraint\s+\w*canonical\w*[\s\S]{0,300}check/,
  `${allocator.name}: canonical Transport offline lease CHECK missing`,
);

// A pool candidate is safe only when it has no active lease or lifecycle
// reference. If none is available, only a fresh sequence value may be used;
// arbitrary historical numeric gaps have ambiguous provenance and stay closed.
assert.ok(lifecycleHelperSql, `${allocator.name}: lifecycle-reference helper missing`);
assert.match(allocatorSql, /transport_tcode_has_lifecycle_reference_v2/, `${allocator.name}: allocator does not call the lifecycle guard`);
const lifecycleCall = allocatorSql.indexOf('transport_tcode_has_lifecycle_reference_v2', availableIndex);
assert.ok(
  lifecycleCall > availableIndex && lifecycleCall < orderIndex,
  `${allocator.name}: lifecycle guard must filter candidates before numeric ordering`,
);
assert.match(safetySql, /offline_code_leases/, `${allocator.name}: active offline lease guard missing`);
assert.match(safetySql, /status\s+in\s*\(\s*'available'\s*,\s*'assigned'\s*\)/, `${allocator.name}: active lease statuses are incomplete`);
assert.match(safetySql, /expires_at[\s\S]{0,100}(?:now\s*\(\)|current_timestamp)/, `${allocator.name}: active lease expiry guard missing`);
for (const relation of [
  'transport_clients',
  'transport_orders',
  'arka_pending_payments',
  'cash_handoff_items',
  'arka_payment_exclusions',
  'transport_client_debts',
  'transport_receivables',
  'dispatch_tasks',
  'transport_order_measurement_audit',
  'transport_keep_one',
]) {
  assert.match(safetySql, new RegExp(`public\\.${relation}\\b`), `${allocator.name}: lifecycle guard misses ${relation}`);
}
assert.doesNotMatch(allocatorSql, /nextval\s*\(/, `${allocator.name}: nontransactional nextval burns a fresh code when order creation rolls back`);
assert.match(allocatorMigrationLower, /create\s+table\s+if\s+not\s+exists\s+public\.transport_code_allocator_state_v2/, `${allocator.name}: transactional fresh-code cursor table missing`);
assert.match(allocatorMigrationLower, /transport_codes_seq/, `${allocator.name}: transactional cursor is not seeded from the existing sequence`);
assert.match(allocatorMigrationLower, /select\s+s\.last_value\s*,\s*s\.is_called[\s\S]{0,160}from\s+public\.transport_codes_seq\s+s/, `${allocator.name}: cursor seed ignores the legacy sequence call state`);
assert.match(allocatorSql, /public\.transport_code_allocator_state_v2/, `${allocator.name}: fresh fallback bypasses the transactional cursor`);
assert.match(allocatorSql, /select\s+s\.next_fresh\s*,\s*s\.exhausted[\s\S]{0,160}for\s+update/, `${allocator.name}: fresh cursor is not transactionally locked`);
assert.match(allocatorSql, /set\s+next_fresh\s*=\s*v_fresh_n\s*\+\s*1/, `${allocator.name}: fresh fallback does not advance its transactional cursor`);
assert.match(
  allocatorSql,
  /v_pool_code_n\s*<=\s*v_fresh_n/,
  `${allocator.name}: allocator does not choose the global numeric minimum of safe pool and fresh candidates`,
);
assert.doesNotMatch(allocatorSql, /setval\s*\(/, `${allocator.name}: allocator must not jump the sequence to a historical outlier`);
assert.doesNotMatch(
  allocatorSql,
  /max\s*\([\s\S]{0,100}(?:transport_code_pool|regexp_replace\s*\(\s*(?:p\.)?code)/,
  `${allocator.name}: historical pool maximum must not control fresh sequence allocation`,
);

const offlineSql = extractFunction(
  allocatorMigrationSql,
  'reserve_transport_offline_codes',
).toLowerCase();
assert.ok(offlineSql, `${allocator.name}: offline transport allocator compatibility definition missing`);
assert.match(offlineSql, /transport-code-allocator-v3/, `${allocator.name}: offline path does not share the canonical allocator lock`);
assert.match(offlineSql, /reserve_transport_codes_batch\s*\(\s*clean_owner\s*,\s*1\s*\)/, `${allocator.name}: offline bank bypasses the one-code canonical allocator`);
assert.match(offlineSql, /for\s+reserve_index\s+in\s+1\.\.need_count\s+loop/, `${allocator.name}: offline bank cannot safely refill multiple leases one-at-a-time`);
assert.ok(quotaKeySql, `${allocator.name}: canonical offline owner quota key missing`);
for (const aliasColumn of ['id', 'transport_id', 'tid', 'pin']) {
  assert.match(quotaKeySql, new RegExp(`u\\.${aliasColumn}\\b`), `${allocator.name}: offline quota key misses user alias ${aliasColumn}`);
}
assert.match(offlineSql, /transport_offline_owner_quota_key_v2\s*\(\s*clean_owner\s*\)/, `${allocator.name}: offline bank does not resolve the caller to a canonical quota key`);
assert.match(offlineSql, /offline-bank:transport-owner-v2:'\s*\|\|\s*owner_quota_key/, `${allocator.name}: alias calls do not share one canonical owner lock`);
assert.match(offlineSql, /transport_offline_owner_quota_key_v2\s*\(\s*l\.owner_id\s*\)[\s\S]{0,80}=\s*owner_quota_key/, `${allocator.name}: active lease cap is still bypassable through PIN/TID/UUID aliases`);
assert.match(offlineSql, /device_id\s*=\s*clean_device[\s\S]{0,180}status\s+in\s*\(\s*'available'\s*,\s*'assigned'\s*\)/, `${allocator.name}: offline return path is not restricted to the current device`);
assert.doesNotMatch(offlineSql, /set[\s\S]{0,120}device_id\s*=\s*clean_device/, `${allocator.name}: active leases must never transfer across unauthenticated devices`);
assert.doesNotMatch(offlineSql, /device_reclaimed_from/, `${allocator.name}: unsafe cross-device lease reclaim metadata remains`);
assert.match(offlineSql, /get\s+diagnostics\s+pool_release_count\s*=\s*row_count/, `${allocator.name}: expired lease release does not verify the pool update count`);
assert.match(offlineSql, /offline_transport_pool_release_state_mismatch/, `${allocator.name}: zero-row/mismatched expired lease release is not fail-closed`);
assert.match(offlineSql, /transport_tcode_number_v2\s*\(/, `${allocator.name}: offline lease path bypasses overflow-safe T-code parsing`);
const expiredLoopIndex = offlineSql.indexOf('for r in');
const perCodeReleaseLockIndex = offlineSql.indexOf('transport-code-release:', expiredLoopIndex);
const expiredLeaseRowLockIndex = offlineSql.indexOf('for update', expiredLoopIndex);
assert.ok(expiredLoopIndex >= 0, `${allocator.name}: expired lease reconciliation loop missing`);
assert.ok(perCodeReleaseLockIndex > expiredLoopIndex, `${allocator.name}: expired lease path does not take the per-code release advisory lock`);
assert.ok(
  expiredLeaseRowLockIndex > perCodeReleaseLockIndex,
  `${allocator.name}: expired lease row is locked before the per-code advisory lock (release deadlock risk)`,
);
for (const returnColumn of [
  'code text',
  'lease_token uuid',
  'lease_expires_at timestamptz',
  'lease_status text',
  'draft_session_id text',
  'owner_id text',
  'device_id text',
]) {
  assert.match(offlineSql, new RegExp(returnColumn.replace(/\s+/g, '\\s+')), `${allocator.name}: offline RPC return shape lost ${returnColumn}`);
}

// Cleanup is deliberately incident-exact. T3972 is a valid historical outlier:
// it must neither move the sequence nor enter either release set.
const cleanupV1 = migrationSources.find(({ name }) => name === '20260830212301_dispatch_tcode_stranded_cleanup_v1.sql')?.sql.toLowerCase() || '';
const cleanupV2 = migrationSources.find(({ name }) => name === '20260830221249_dispatch_tcode_stranded_cleanup_v2.sql')?.sql.toLowerCase() || '';
const cleanupV3 = migrationSources.find(({ name }) => name === '20260831071200_dispatch_tcode_stranded_cleanup_v3.sql')?.sql.toLowerCase() || '';
assert.match(cleanupV1, /generate_series\s*\(\s*1233::bigint\s*,\s*1288::bigint\s*\)/, 'first cleanup range is not incident-exact');
assert.match(cleanupV1, /where\s+n\s+not\s+in\s*\(\s*1237\s*,\s*1267\s*,\s*1279\s*\)/, 'first cleanup does not protect its three completed orders');
assert.match(cleanupV1, /v_expected_count\s*<>\s*53/, 'first cleanup expected cardinality guard missing');
assert.match(cleanupV2, /generate_series\s*\(\s*1290::bigint\s*,\s*1298::bigint\s*\)/, 'second cleanup range is not incident-exact');
assert.match(cleanupV2, /v_expected_count\s*<>\s*9/, 'second cleanup expected cardinality guard missing');
assert.match(cleanupV2, /'t1289'::text[\s\S]{0,80}'t1299'::text/, 'second cleanup does not protect its two completed boundary orders');
assert.match(cleanupV3, /generate_series\s*\(\s*1301::bigint\s*,\s*1310::bigint\s*\)/, 'third cleanup first interval is not incident-exact');
assert.match(cleanupV3, /generate_series\s*\(\s*1312::bigint\s*,\s*1326::bigint\s*\)/, 'third cleanup second interval is not incident-exact');
assert.match(cleanupV3, /generate_series\s*\(\s*1329::bigint\s*,\s*1330::bigint\s*\)/, 'third cleanup final pre-cutover interval is not incident-exact');
assert.match(cleanupV3, /v_expected_count\s*<>\s*27/, 'third cleanup expected cardinality guard missing');
assert.match(cleanupV3, /v_pool_count\s*<>\s*v_expected_count/, 'third cleanup pool guard must stay coupled to the incident-set cardinality');
assert.match(cleanupV3, /'t1300'::text[\s\S]{0,220}'t1328'::text/, 'third cleanup does not protect its four completed boundary orders');
assert.match(cleanupV3, /transport_tcode_has_lifecycle_reference_v2/, 'third cleanup does not use the strict lifecycle guard');
assert.match(cleanupV3, /dispatch_tcode_cleanup_v3_update_count_changed/, 'third cleanup does not verify its exact update count');
assert.match(cleanupV3, /dispatch_tcode_cleanup_v3_postcheck_failed/, 'third cleanup does not verify all released codes after update');
assert.match(cleanupV3, /dispatch_tcode_cleanup_v3_protected_postcheck_failed/, 'third cleanup does not re-verify protected completed codes');
assert.doesNotMatch(`${cleanupV1}\n${cleanupV2}\n${cleanupV3}`, /t3972|\b3972\b/, 'historical valid outlier T3972 entered an incident cleanup');
for (const [label, cleanupSql] of [['v1', cleanupV1], ['v2', cleanupV2]]) {
  assert.match(cleanupSql, /data->'client'->>'code_str'/, `${label} cleanup misses nested client.code_str references`);
  assert.match(cleanupSql, /data->'client'->>'official_order_code'/, `${label} cleanup misses nested client.official_order_code references`);
  assert.match(cleanupSql, /data->'client'->>'transport_client_tcode'/, `${label} cleanup misses nested client.transport_client_tcode references`);
  assert.match(cleanupSql, /jsonb_each_text/, `${label} cleanup misses transport_keep_one JSON references`);
}

const createDefinitions = migrationSources
  .map(({ name, sql }) => ({ name, block: extractFunction(sql, 'create_transport_order') }))
  .filter(({ block }) => block);
assert.ok(createDefinitions.length > 0, 'create_transport_order migration definition missing');
const create = createDefinitions.at(-1);
const createSql = create.block.toLowerCase();
const orderLock = createSql.indexOf("transport-order:");
const phoneLock = createSql.indexOf("transport-phone:");
const allocatorCall = createSql.indexOf('reserve_transport_codes_batch');
const idempotentReturn = createSql.indexOf("'idempotent',true");
assert.ok(orderLock >= 0, `${create.name}: UUID transaction lock missing`);
assert.ok(phoneLock > orderLock, `${create.name}: phone lock must follow UUID lock`);
assert.ok(idempotentReturn > orderLock && idempotentReturn < allocatorCall, `${create.name}: retry must return before allocation`);
assert.ok(allocatorCall > phoneLock, `${create.name}: allocation must happen after serialized phone lookup`);
assert.equal(
  (createSql.match(/reserve_transport_codes_batch/g) || []).length,
  1,
  `${create.name}: one order path may call the allocator only once`,
);
assert.match(createSql, /insert\s+into\s+public\.transport_orders/, `${create.name}: allocation and order insert must share one RPC transaction`);

const dispatchSource = fs.readFileSync(path.join(root, 'app', 'dispatch', 'page.jsx'), 'utf8');
const dispatchPrepareStart = dispatchSource.indexOf('async function prepareDispatchTransportClientLink');
const dispatchPrepareEnd = dispatchSource.indexOf('\n\nfunction dispatchSafePhoneMatch', dispatchPrepareStart);
const dispatchPrepare = dispatchPrepareStart >= 0 && dispatchPrepareEnd > dispatchPrepareStart
  ? dispatchSource.slice(dispatchPrepareStart, dispatchPrepareEnd)
  : '';
const transportDbSource = fs.readFileSync(path.join(root, 'lib', 'transport', 'transportDb.js'), 'utf8');
assert.ok(dispatchPrepare, 'Dispatch client-link preparation block missing');
assert.doesNotMatch(dispatchPrepare, /reserveTransportCode\s*\(/, 'modern Dispatch still pre-reserves in the browser');
assert.match(transportDbSource, /fetch\(\s*['"]\/api\/transport\/order['"]/, 'modern Dispatch does not use the atomic server endpoint');
assert.match(transportDbSource, /body:\s*requestJson/, 'network retry does not reuse the exact serialized request');

// Force installed PWAs off the stale browser-side reservation bundle. Both
// service-worker entry points must advertise the same epoch/cache generation.
const expectedEpoch = 'RESET-2026-08-30-DISPATCH-ATOMIC-TCODE-V2';
const appEpochSource = fs.readFileSync(path.join(root, 'lib', 'appEpoch.js'), 'utf8');
const serviceWorkerSource = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const viteSource = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');
const packageSource = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
assert.match(appEpochSource, new RegExp(expectedEpoch), 'application data epoch was not bumped for the atomic allocator');
assert.match(serviceWorkerSource, new RegExp(expectedEpoch), 'service worker epoch does not match the application');
assert.match(viteSource, /v52-query-authority-transport-guard-payment-button-v3-[^'\n]*dispatch-atomic-tcode-v2/, 'Workbox cache generation was not bumped without preserving prior feature guards');
assert.match(viteSource, /clientsClaim:\s*true/, 'new service worker must claim stale clients immediately');
assert.match(viteSource, /skipWaiting:\s*true/, 'new service worker must skip the stale waiting worker');
assert.match(serviceWorkerSource, /self\.skipWaiting\s*\(/, 'custom service worker update path cannot activate immediately');
assert.match(packageSource, /dispatch-atomic-tcode-v2/, 'application version was not bumped for stale PWA clients');

console.log(`PASS: Dispatch smallest-code and race/retry regression checks (${allocator.name}).`);
