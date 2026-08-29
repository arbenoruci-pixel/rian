import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  getRetiredStaffPinAlias,
  isRetiredStaffPin,
  purgeRetiredStaffPinCaches,
  reconcileRetiredStaffActor,
} from '../lib/staffIdentityAliases.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const NON_RETIRED_PIN = '7777';
const TEST_ONLY_OTHER_PIN = 'TEST_ONLY_OTHER_PIN';

const sessionBundle = await build({
  entryPoints: [path.join(ROOT, 'lib/sessionStore.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  logLevel: 'silent',
});
const sessionModuleUrl = `data:text/javascript;base64,${Buffer.from(sessionBundle.outputFiles[0].text).toString('base64')}`;
const {
  LS_SESSION,
  LS_TRANSPORT,
  LS_USER,
  readMainActor,
  readTransportSession,
} = await import(sessionModuleUrl);

class MemoryStorage {
  constructor(seed = {}) {
    this.values = new Map(Object.entries(seed).map(([key, value]) => [key, String(value)]));
  }

  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

assert.equal(isRetiredStaffPin('5555'), true);
assert.equal(isRetiredStaffPin('6666'), true);
assert.equal(isRetiredStaffPin('8888'), true);
assert.equal(isRetiredStaffPin(NON_RETIRED_PIN), false);
assert.equal(getRetiredStaffPinAlias('5555')?.retiredPin, '5555');
assert.equal(Object.hasOwn(getRetiredStaffPinAlias('5555'), 'canonicalPin'), false);
assert.equal(Object.hasOwn(getRetiredStaffPinAlias('5555'), 'canonicalUserId'), false);

for (const unsafe of [
  { pin: '5555', name: 'stale worker' },
  { pin: '5555', user_id: CURRENT_USER_ID, name: 'stale worker' },
  { pin: '5555', id: '5555', name: 'bujar oruqi' },
  { pin: NON_RETIRED_PIN, user_id: CURRENT_USER_ID, id: '6666' },
  { pin: '6666', transport_pin: '8888', user_id: CURRENT_USER_ID },
  { pin: '6666', user_id: OTHER_USER_ID },
  { pin: '6666', transport_pin: '5555', user_id: CURRENT_USER_ID },
]) {
  const result = reconcileRetiredStaffActor(unsafe);
  assert.equal(result.status, 'rejected');
  assert.equal(result.actor, null);
  assert.equal(result.reason, 'RETIRED_PIN_RELOGIN_REQUIRED');
}

const currentActor = { pin: NON_RETIRED_PIN, user_id: CURRENT_USER_ID, name: 'current worker' };
const unchanged = reconcileRetiredStaffActor(currentActor);
assert.equal(unchanged.status, 'unchanged');
assert.equal(unchanged.actor, currentActor);

const storage = new MemoryStorage({
  tepiha_device_id_v1: 'device_keep_me',
  tepiha_device_approvals_v1: JSON.stringify({
    byPin: {
      '6666': { TRANSPORT: { deviceId: 'old_unapproved_shape' } },
      '8888': { TRANSPORT: { deviceId: 'old_requested_pin' } },
      [NON_RETIRED_PIN]: { TRANSPORT: { deviceId: 'current_device' } },
    },
  }),
  tepiha_base_ready_bonus_workers_v1: JSON.stringify({
    workers: [
      { id: OTHER_USER_ID, pin: '6666', name: 'old duplicate' },
      { id: CURRENT_USER_ID, pin: '8888', name: 'canonical stale pin' },
      { id: CURRENT_USER_ID, pin: NON_RETIRED_PIN, name: 'current worker' },
      { id: '33333333-3333-4333-8333-333333333333', pin: TEST_ONLY_OTHER_PIN, name: 'other worker' },
    ],
  }),
  tepiha_ready_bonus_attention_v3_72h_live: JSON.stringify({ rows: ['stale'] }),
  tepiha_base_bonus_opportunities_v2_72h_live: JSON.stringify({ rows: ['stale'] }),
  'tepiha_base_ready_bonus_summary_v2_72h_live:6666:6666:2026-08-29': '{}',
  [`tepiha_base_ready_bonus_summary_v2_72h_live:${NON_RETIRED_PIN}:8888:2026-08-29`]: '{}',
  [`tepiha_base_ready_bonus_summary_v2_72h_live:${NON_RETIRED_PIN}:${NON_RETIRED_PIN}:2026-08-29`]: '{"keep":true}',
  'unrelated:phone:0445555666': 'keep',
});

const purge = purgeRetiredStaffPinCaches(storage, '6666');
assert.equal(purge.approvalEntries, 2);
assert.equal(purge.workerRows, 2);
assert.equal(storage.getItem('tepiha_device_id_v1'), 'device_keep_me');
assert.equal(storage.getItem('tepiha_ready_bonus_attention_v3_72h_live'), null);
assert.equal(storage.getItem('tepiha_base_bonus_opportunities_v2_72h_live'), null);
assert.equal(storage.getItem('tepiha_base_ready_bonus_summary_v2_72h_live:6666:6666:2026-08-29'), null);
assert.equal(storage.getItem(`tepiha_base_ready_bonus_summary_v2_72h_live:${NON_RETIRED_PIN}:8888:2026-08-29`), null);
assert.equal(storage.getItem(`tepiha_base_ready_bonus_summary_v2_72h_live:${NON_RETIRED_PIN}:${NON_RETIRED_PIN}:2026-08-29`), '{"keep":true}');
assert.equal(storage.getItem('unrelated:phone:0445555666'), 'keep');

const approvals = JSON.parse(storage.getItem('tepiha_device_approvals_v1'));
assert.deepEqual(Object.keys(approvals.byPin), [NON_RETIRED_PIN]);
const workers = JSON.parse(storage.getItem('tepiha_base_ready_bonus_workers_v1')).workers;
assert.equal(workers.some((row) => row.pin === '6666' || row.pin === '8888'), false);
assert.equal(workers.filter((row) => row.pin === NON_RETIRED_PIN && row.id === CURRENT_USER_ID).length, 1);
assert.equal(workers.some((row) => row.pin === TEST_ONLY_OTHER_PIN), true);

const noOpStorage = new MemoryStorage({ untouched: 'yes' });
assert.deepEqual(purgeRetiredStaffPinCaches(noOpStorage, '1234'), {
  approvalEntries: 0,
  bonusKeys: 0,
  workerRows: 0,
});
assert.equal(noOpStorage.getItem('untouched'), 'yes');

const staleSessionStorage = new MemoryStorage({
  tepiha_device_id_v1: 'physical_device_is_preserved',
  [LS_USER]: JSON.stringify({ pin: '5555', user_id: CURRENT_USER_ID, role: 'PUNTOR' }),
  [LS_SESSION]: JSON.stringify({ actor: { pin: '6666', user_id: CURRENT_USER_ID, role: 'TRANSPORT' } }),
  [LS_TRANSPORT]: JSON.stringify({ transport_pin: '8888', transport_id: CURRENT_USER_ID, role: 'TRANSPORT' }),
  tepiha_user: JSON.stringify({ pin: '5555', user_id: CURRENT_USER_ID, role: 'PUNTOR' }),
});
const previousWindow = globalThis.window;
const previousStorage = globalThis.localStorage;
const previousCustomEvent = globalThis.CustomEvent;
globalThis.window = { dispatchEvent() {} };
globalThis.localStorage = staleSessionStorage;
globalThis.CustomEvent = class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
try {
  assert.equal(readMainActor(), null);
  assert.equal(readTransportSession(), null);
  assert.equal(staleSessionStorage.getItem(LS_USER), null);
  assert.equal(staleSessionStorage.getItem(LS_SESSION), null);
  assert.equal(staleSessionStorage.getItem(LS_TRANSPORT), null);
  assert.equal(staleSessionStorage.getItem('tepiha_user'), null);
  assert.equal(staleSessionStorage.getItem('tepiha_device_id_v1'), 'physical_device_is_preserved');

  const mixedSessionStorage = new MemoryStorage({
    tepiha_device_id_v1: 'mixed_physical_device_is_preserved',
    [LS_USER]: JSON.stringify({ pin: NON_RETIRED_PIN, user_id: CURRENT_USER_ID, role: 'PUNTOR' }),
    [LS_SESSION]: JSON.stringify({
      actor: { pin: NON_RETIRED_PIN, user_id: CURRENT_USER_ID, role: 'PUNTOR' },
      user: { pin: '5555', user_id: CURRENT_USER_ID, role: 'PUNTOR' },
    }),
    tepiha_current_user_v1: JSON.stringify({ pin: NON_RETIRED_PIN, user_id: CURRENT_USER_ID, role: 'PUNTOR' }),
  });
  globalThis.localStorage = mixedSessionStorage;
  assert.equal(readMainActor(), null, 'a valid local copy must not heal a second copy that still carries a retired PIN');
  assert.equal(mixedSessionStorage.getItem(LS_USER), null);
  assert.equal(mixedSessionStorage.getItem(LS_SESSION), null);
  assert.equal(mixedSessionStorage.getItem('tepiha_current_user_v1'), null);
  assert.equal(mixedSessionStorage.getItem('tepiha_device_id_v1'), 'mixed_physical_device_is_preserved');
} finally {
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
  if (previousCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousCustomEvent;
}

const sessionSource = read('lib/sessionStore.js');
assert.match(sessionSource, /reconcileRetiredStaffActor/);
assert.match(sessionSource, /identity\.status === 'rejected'/);
assert.match(sessionSource, /purgeRetiredStaffPinCaches/);
assert.match(sessionSource, /tepiha_current_user_v1/);

const aliasSource = read('lib/staffIdentityAliases.js');
assert.doesNotMatch(aliasSource, /canonicalPin|canonicalUserId/);
assert.doesNotMatch(aliasSource, /status: 'canonicalized'/);

const approvalSource = read('lib/deviceApprovalsCache.js');
assert.match(approvalSource, /return \{ ok: false, reason: 'PIN_RETIRED' \}/);
assert.match(approvalSource, /purgeRetiredStaffPinCaches\(localStorage, pin\)/);

for (const relativePath of [
  'app/api/auth/login/route.js',
  'app/api/auth/device-status/route.js',
  'app/api/auth/validate-pin/route.js',
  'app/api/auth/pin/route.js',
  'api/auth/login.js',
  'api/auth/validate-pin.js',
  'server/index.mjs',
]) {
  const source = read(relativePath);
  assert.match(source, /isRetiredStaffPin\(pin\)/, `${relativePath} must reject retired PIN auth`);
  assert.match(source, /PIN_RETIRED_USE_CURRENT_PIN/, `${relativePath} must return a retired-PIN error`);
}

console.log('PASS retired staff PIN denylist purges stale sessions without exposing or translating current credentials');
