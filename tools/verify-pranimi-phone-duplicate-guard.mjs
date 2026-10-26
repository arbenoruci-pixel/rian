import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { findRecentPranimiDuplicate, PRANIMI_DUPLICATE_WINDOW_MS } from '../lib/pranimiDuplicateGuard.js';
const page = fs.readFileSync('app/pranimi/page.jsx', 'utf8');
const between = (a, b) => {
  const start = page.indexOf(a), end = page.indexOf(b, start + a.length);
  assert.ok(start >= 0 && end > start, `source boundaries: ${a}`);
  return page.slice(start, end);
};
const phones = vm.createContext({});
vm.runInContext(between('function normalizeMatchPhone(', 'function isNoPhonePlaceholder(')
  + between('function isValidClientPhoneDigits(', 'function pranimiIsOnline('), phones);
for (const value of ['44123456', '044123456', '+38344123456', '00383 44 123 456']) {
  assert.equal(phones.isValidClientPhoneDigits(value), true, `valid formatted phone ${value}`);
}
for (const value of ['444123456', '+383444123456', '4412345', '', '383', '4412345678']) {
  assert.equal(phones.isValidClientPhoneDigits(value), false, `reject invalid phone ${value}`);
}
let alerts = [];
const validation = vm.createContext({ ...phones, name: 'Test Client', noPhone: false, phone: '444123456',
  tepihaRows: [{ m2: 13.3, qty: 5 }], stazaRows: [], totalM2: 13.3, alert: text => alerts.push(text) });
vm.runInContext(between('  function validateBeforeContinue()', '  function loadOfflineModeInit()'), validation);
assert.equal(validation.validateBeforeContinue(), false);
assert.equal(alerts.length, 1);
validation.phone = '44123456';
assert.equal(validation.validateBeforeContinue(), true);
validation.noPhone = true;
validation.phone = '';
assert.equal(validation.validateBeforeContinue(), true, 'explicit no-phone flow survives');

const now = Date.parse('2026-10-26T09:00:28Z');
const previous = { id: 100, code: 706, client_id: 'client-a', client_phone: '+38344123456', status: 'pastrim',
  local_oid: 'first-visit', created_at: '2026-10-26T08:56:47Z', pieces: 5, m2_total: 13.3, price_total: 17.29 };
const incoming = { ...previous, id: undefined, local_oid: 'second-visit' };
assert.equal(findRecentPranimiDuplicate([previous], incoming, now)?.id, 100, 'new draft repeating recent saved order warns');
assert.equal(findRecentPranimiDuplicate([previous], previous, now), null, 'same draft retry is idempotent, not a new visit');
for (const changes of [{ client_id: 'client-b' }, { pieces: 6 }, { m2_total: 14 }, { price_total: 18 }]) {
  assert.equal(findRecentPranimiDuplicate([previous], { ...incoming, ...changes }, now), null);
}
for (const changes of [{ status: 'incomplete' }, { status: 'dorzim' }, { table: 'transport_orders' }, { created_at: new Date(now - PRANIMI_DUPLICATE_WINDOW_MS - 1).toISOString() }, { created_at: 'bad-date' }]) {
  assert.equal(findRecentPranimiDuplicate([{ ...previous, ...changes }], incoming, now), null);
}
assert.equal(findRecentPranimiDuplicate([previous], { ...incoming, client_id: null, client_phone: '044123456' }, now)?.id, 100);
assert.equal(findRecentPranimiDuplicate([previous], { ...incoming, client_id: null, client_phone: '+383444123456' }, now), null, 'extra digits never silently match a suffix');

// Run the actual submit handler through its asynchronous preflight: a double
// tap cannot start another check/save, and returning from a prompt releases it.
let resolveLookup, lookupCalls = 0, savingCalls = [];
const flight = vm.createContext({
  validateBeforeContinue: () => true, savingContinue: false, finalSaveInFlightRef: { current: false }, photoUploading: false,
  resolvePranimiActorPin: () => 'test-pin', actor: {}, setSavingContinue: value => savingCalls.push(value),
  oidRef: { current: 'first-visit' }, oid: 'first-visit', suppressDraftId() {}, draftTimer: {}, remoteDraftTimerRef: {},
  isBridgeEditMode: false, noPhone: false, name: 'Test Client', phone: '44123456', clientsIndex: [],
  pranimiIsOnline: () => true, PRANIMI_CONTINUE_CLIENT_LOOKUP_MS: 5000, getCurrentPranimiCodeNumber: () => 1395,
  detectExistingClientSmart: () => { lookupCalls++; return new Promise(resolve => { resolveLookup = resolve; }); },
  isCandidateCurrentPranimiCode: () => false, sameSelectedClientCode: () => false, clientMatchDecision: {},
  setClientMatchPrompt() {}, alert: message => { throw new Error(message); },
});
vm.runInContext(between('  async function handleContinue()', '  function openDrafts()'), flight);
const first = flight.handleContinue();
await flight.handleContinue();
assert.equal(lookupCalls, 1);
resolveLookup({ candidate: { id: 'client-a', code: 706 }, matchKey: 'client-a' });
await first;
assert.equal(flight.finalSaveInFlightRef.current, false);
assert.deepEqual(savingCalls, [true, false]);

// Failed authoritative lookup must remain an error, never an empty result.
const lookup = vm.createContext({ ...phones, phonePrefix: '+383', pranimiIsOnline: () => true,
  searchClientsLive: async () => { throw Error('NETWORK_TIMEOUT'); }, withSupabaseTimeout: promise => promise });
vm.runInContext(between('  async function findBaseClientByNameAndPhone(', '  async function syncClientMasterForCode('), lookup);
await assert.rejects(lookup.findBaseClientByNameAndPhone({ phone: '44123456' }), /NETWORK_TIMEOUT/);

// A known persisted row with another code cannot consume the wrong reservation
// or be re-enqueued by RETRY.
let retried = 0, lastWarning;
const retry = vm.createContext({ localSyncWarning: { payload: { code: 1395 } },
  extractPranimiSyncSafety: () => ({ local_oid: 'first-visit' }),
  setLocalSyncWarning: value => { lastWarning = typeof value === 'function' ? value(lastWarning) : value; },
  verifyBaseOrderInDbBySafetyIds: async () => ({ found: true, row: { id: 100, code: 706 } }),
  assertBaseOrderReservationMatch: () => ({ ok: false, reason: 'CODE_MISMATCH' }),
  finalizeRetryCodeLifecycle: () => { retried++; throw Error('wrong code consumed'); },
  enqueueBaseOrder: () => { retried++; throw Error('duplicate enqueued'); }, appendPranimiCodeDebug() {},
});
vm.runInContext(between('  async function retryLocalSyncWarning()', '  function continueAfterLocalSyncWarning()'), retry);
await retry.retryLocalSyncWarning();
assert.equal(retried, 0);
assert.equal(lastWarning.last_error, 'CODE_MISMATCH');
assert.equal(lastWarning.server_id, '100');
console.log('PASS Pranimi phone validation, duplicate admission, concurrent clicks, lookup failure and retry mismatch scenarios');
