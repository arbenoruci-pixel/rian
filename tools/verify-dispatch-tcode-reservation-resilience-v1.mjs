import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const transportCodesPath = path.join(root, 'lib/transportCodes.js');
let source = fs.readFileSync(transportCodesPath, 'utf8');
const rpcNormalizerSource = fs
  .readFileSync(path.join(root, 'lib/transportCodeRpcResponse.js'), 'utf8')
  .replace(/export\s+function\s+normalizeTransportCodeRpcResponse/, 'function normalizeTransportCodeRpcResponse');

// Load the real browser allocator while replacing only its three environment
// imports. This keeps these tests behavioral without requiring a browser runner
// or changing production exports solely for tests.
source = source
  .replace(
    /import \{ supabase \} from ['"]@\/lib\/supabaseClient['"];?\s*/,
    'const supabase = globalThis.__DISPATCH_TCODE_TEST_SUPABASE__;\n',
  )
  .replace(
    /import \{ getActor \} from ['"]@\/lib\/actorSession['"];?\s*/,
    'const getActor = () => null;\n',
  )
  .replace(
    /import \{ getTransportSession \} from ['"]@\/lib\/transportAuth['"];?\s*/,
    'const getTransportSession = () => null;\n',
  )
  .replace(
    /import \{ normalizeTransportCodeRpcResponse \} from ['"]@\/lib\/transportCodeRpcResponse['"];?\s*/,
    `${rpcNormalizerSource}\n`,
  );

assert(!source.includes("from '@/lib/supabaseClient'"), 'Supabase import replacement failed');
assert(!source.includes("from '@/lib/actorSession'"), 'Actor import replacement failed');
assert(!source.includes("from '@/lib/transportAuth'"), 'Transport session import replacement failed');
assert(!source.includes("from '@/lib/transportCodeRpcResponse'"), 'RPC normalizer import replacement failed');

class MemoryStorage {
  constructor({ failSetPrefix = '' } = {}) {
    this.values = new Map();
    this.failSetPrefix = failSetPrefix;
  }
  get length() { return this.values.size; }
  key(index) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) {
    const normalizedKey = String(key);
    if (this.failSetPrefix && normalizedKey.startsWith(this.failSetPrefix)) {
      throw new Error(`LOCAL_STORAGE_WRITE_FAILED:${normalizedKey}`);
    }
    this.values.set(normalizedKey, String(value));
  }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

function digits(value) {
  return Number(String(value || '').replace(/\D+/g, '') || 0);
}

function normalizeCode(value) {
  const n = digits(value);
  return n > 0 ? `T${n}` : '';
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.patch = null;
    this.limitCount = null;
  }
  select() { return this; }
  or() { return this; }
  eq(column, value) {
    this.filters.push((row) => String(row?.[column] ?? '') === String(value ?? ''));
    return this;
  }
  in(column, values) {
    const allowed = new Set((values || []).map((item) => String(item)));
    this.filters.push((row) => allowed.has(String(row?.[column] ?? '')));
    return this;
  }
  limit(value) { this.limitCount = Number(value); return this; }
  update(patch) { this.patch = { ...(patch || {}) }; return this; }
  rows() {
    let rows = Array.isArray(this.db.tables[this.table]) ? this.db.tables[this.table] : [];
    for (const filter of this.filters) rows = rows.filter(filter);
    if (Number.isFinite(this.limitCount)) rows = rows.slice(0, this.limitCount);
    return rows;
  }
  execute() {
    const rows = this.rows();
    if (this.patch) rows.forEach((row) => Object.assign(row, this.patch));
    return { data: rows.map((row) => structuredClone(row)), error: null };
  }
  maybeSingle() {
    if (this.table === 'transport_code_pool' && this.db.failOwnershipVerification) {
      return Promise.resolve({ data: null, error: null });
    }
    const result = this.execute();
    return Promise.resolve({ data: result.data[0] || null, error: null });
  }
  then(resolve, reject) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

class FakeSupabase {
  constructor({
    firstCode = 'T801',
    rpcShape = (code) => [code],
    maxReservations = 1,
    failOwnershipVerification = false,
  } = {}) {
    this.firstCode = normalizeCode(firstCode);
    this.rpcShape = rpcShape;
    this.maxReservations = maxReservations;
    this.failOwnershipVerification = failOwnershipVerification;
    this.tables = {
      transport_orders: [],
      transport_clients: [],
      transport_code_pool: [],
      arka_pending_payments: [],
    };
    this.calls = { reserve: 0, release: 0, reserveArgs: [], releaseArgs: [] };
  }
  from(table) { return new FakeQuery(this, table); }
  async rpc(name, args = {}) {
    if (name === 'reserve_transport_codes_batch') {
      this.calls.reserve += 1;
      this.calls.reserveArgs.push(structuredClone(args));
      if (this.calls.reserve > this.maxReservations) {
        return { data: null, error: { message: 'TEST_RESERVATION_LIMIT' } };
      }
      const code = `T${digits(this.firstCode) + this.calls.reserve - 1}`;
      this.tables.transport_code_pool.push({
        code,
        code_str: code,
        status: 'used',
        owner_id: String(args.p_owner_id || args.p_reserved_by || ''),
      });
      return { data: this.rpcShape(code), error: null };
    }
    if (name === 'release_transport_code_if_unused') {
      this.calls.release += 1;
      this.calls.releaseArgs.push(structuredClone(args));
      const code = normalizeCode(args.p_code);
      const poolRow = this.tables.transport_code_pool.find((row) => normalizeCode(row.code) === code);
      if (!poolRow) return { data: false, error: null };
      const referenced = this.tables.transport_orders.some((row) =>
        normalizeCode(row.code_str) === code || normalizeCode(row.client_tcode) === code,
      ) || this.tables.transport_clients.some((row) => normalizeCode(row.tcode) === code);
      if (referenced) return { data: false, error: null };
      poolRow.status = 'available';
      poolRow.owner_id = 'POOL';
      return { data: true, error: null };
    }
    return { data: null, error: { message: `UNKNOWN_RPC:${name}` } };
  }
  usedCodes() {
    return this.tables.transport_code_pool.filter((row) => row.status === 'used').map((row) => row.code);
  }
}

let activeDb = null;
globalThis.__DISPATCH_TCODE_TEST_SUPABASE__ = {
  from(table) { return activeDb.from(table); },
  rpc(name, args) { return activeDb.rpc(name, args); },
};

Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  configurable: true,
  writable: true,
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const transportCodes = await import(moduleUrl);

function installCase(db, storage = new MemoryStorage()) {
  activeDb = db;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  window.localStorage = storage;
  return storage;
}

const responseShapes = [
  ['array', (code) => [code]],
  ['JSON array string', (code) => JSON.stringify([code])],
  ['double encoded JSON', (code) => JSON.stringify(JSON.stringify([code]))],
  ['PostgreSQL text array', (code) => `{${code}}`],
  ['codes wrapper', (code) => ({ codes: [code] })],
  ['RPC named wrapper', (code) => ({ reserve_transport_codes_batch: [code] })],
  ['single code object', (code) => ({ code })],
  ['scalar code', (code) => code],
  ['row object array', (code) => [{ code_str: code }]],
];

for (const [label, rpcShape] of responseShapes) {
  const db = new FakeSupabase({ firstCode: 'T801', rpcShape });
  installCase(db);
  const oid = `shape-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const code = await transportCodes.reserveTransportCode('2468', { oid });
  assert.equal(code, 'T801', `${label}: allocator returns the reserved T-code`);
  assert.equal(db.calls.reserve, 1, `${label}: one tap performs exactly one reservation`);
  assert.deepEqual(db.calls.reserveArgs[0], { p_owner_id: '2468', p_n: 1 }, `${label}: allocator asks for exactly one code`);
  assert.deepEqual(db.usedCodes(), ['T801'], `${label}: exactly one pool code is consumed`);
}

{
  const db = new FakeSupabase({ firstCode: 'T820' });
  installCase(db);
  const oid = '8b06c8aa-f691-49f0-b2b5-728246b8cc2f';
  const first = await transportCodes.reserveTransportCode('2468', { oid });
  const retry = await transportCodes.reserveTransportCode('2468', { oid });
  assert.equal(first, 'T820');
  assert.equal(retry, 'T820', 'same OID retry reuses the original reservation');
  assert.equal(db.calls.reserve, 1, 'same OID retry does not reserve another code');
  assert.deepEqual(db.usedCodes(), ['T820']);
}

{
  const db = new FakeSupabase({ firstCode: 'T825' });
  installCase(db);
  const oid = '25c2ceae-b9ce-4304-bcbf-4a48265e0de8';
  const [first, duplicateTap] = await Promise.all([
    transportCodes.reserveTransportCode('2468', { oid }),
    transportCodes.reserveTransportCode('2468', { oid }),
  ]);
  assert.equal(first, 'T825');
  assert.equal(duplicateTap, 'T825', 'concurrent duplicate tap shares the same reservation');
  assert.equal(db.calls.reserve, 1, 'concurrent duplicate tap performs one DB reservation');
  assert.deepEqual(db.usedCodes(), ['T825']);
}

{
  const db = new FakeSupabase({ firstCode: 'T830', failOwnershipVerification: true });
  installCase(db);
  await assert.rejects(
    transportCodes.reserveTransportCode('2468', { oid: 'ownership-verification-failure' }),
    /./,
    'failed ownership verification must stop the save',
  );
  assert.equal(db.calls.reserve, 1, 'verification failure cannot reserve repeatedly in one tap');
  assert.equal(db.calls.release, 1, 'verification failure releases the server-reserved code');
  assert.deepEqual(db.usedCodes(), [], 'verification failure leaves no used orphan code');
}

{
  const db = new FakeSupabase({ firstCode: 'T840' });
  installCase(db, new MemoryStorage({ failSetPrefix: 'transport_order_code_' }));
  await assert.rejects(
    transportCodes.reserveTransportCode('2468', { oid: 'local-storage-bind-failure' }),
    /./,
    'failed OID binding must stop the save',
  );
  assert.equal(db.calls.reserve, 1, 'OID binding failure cannot reserve repeatedly in one tap');
  assert.equal(db.calls.release, 1, 'OID binding failure releases the server-reserved code');
  assert.deepEqual(db.usedCodes(), [], 'OID binding failure leaves no used orphan code');
}

delete globalThis.__DISPATCH_TCODE_TEST_SUPABASE__;
delete globalThis.localStorage;
delete globalThis.navigator;
delete globalThis.window;

console.log(`PASS: ${responseShapes.length + 4} Dispatch T-code reservation resilience cases.`);
