// V477.1 verification — existing-client direct lock + phoneless-client final-save guard.
//
// Runs three groups of checks with zero external dependencies:
//   A. Static source assertions (handoff, allocator isolation, V473/V475/V476 invariants).
//   B. Static assertion that the V477.1 explicit-lock save guard is present.
//   C. A self-contained replication of the final-save codeLifecycleMode decision,
//      exercising every item in the V477 test plan.
//
// Usage: node tools/verify-pranimi-existing-client-direct-lock-v477-1.mjs

import fs from 'node:fs';
import assert from 'node:assert/strict';

const page = fs.readFileSync('app/pranimi/page.jsx', 'utf8');
const globalSearch = fs.readFileSync('components/GlobalHomeSearch.jsx', 'utf8');
const homePage = fs.readFileSync('app/page.jsx', 'utf8');

/* ----------------------------- A. handoff + base V477 ----------------------------- */
assert.match(page, /async function resolveExplicitExistingClientHandoff/);
assert.match(page, /explicit_existing_client_session_started_locked_code/);
assert.match(page, /EXPLICIT_EXISTING_CLIENT_FROM_SEARCH_LOCKED_BEFORE_FORM/);
assert.match(page, /EXISTING_CLIENT_HANDOFF_NOT_VERIFIED/);
assert.match(page, /mode: 'use_existing'/);

// handoff must NOT pass order id as clientId (root cause of the stale new code)
assert.match(globalSearch, /clientId: result\?\.clientId \|\| null/);
assert.doesNotMatch(globalSearch, /clientId: result\?\.clientId \|\| result\?\.id/);
assert.match(globalSearch, /lastOrderId: result\?\.orderId \|\| result\?\.id \|\| null/);
assert.match(homePage, /clientId: result\?\.clientId \|\| null/);
assert.doesNotMatch(homePage, /clientId: result\?\.clientId \|\| result\?\.id/);
assert.match(homePage, /lastOrderId: result\?\.orderId \|\| result\?\.id \|\| null/);

/* ----------------------------- A2. allocator isolation ---------------------------- */
// Prove the allocator (tryReserveCodeInBackground) only fires in the normal-new branch
// of resetForNewOrder, never inside the `if (explicitExisting) { ... }` block.
{
  const lines = page.split('\n');
  const start = lines.findIndex((l) => l.includes('async function resetForNewOrder'));
  assert.ok(start >= 0, 'resetForNewOrder not found');
  let depth = 0, started = false, end = start;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) { end = i; break; }
  }
  const body = lines.slice(start, end + 1);
  const guardIdx = body.findIndex((l) => l.trim() === 'if (explicitExisting) {');
  assert.ok(guardIdx >= 0, 'explicitExisting guard block not found');
  let d = 0, inTrue = false, inElse = false, trueHits = 0, elseHits = 0;
  for (let i = guardIdx; i < body.length; i++) {
    const line = body[i];
    for (const ch of line) { if (ch === '{') d++; else if (ch === '}') d--; }
    if (i === guardIdx) { inTrue = true; continue; }
    if (inTrue && d === 1 && /^\s*\} else \{/.test(line)) { inTrue = false; inElse = true; continue; }
    if (inElse && d === 0) break;
    if (line.includes('tryReserveCodeInBackground')) { if (inTrue) trueHits++; if (inElse) elseHits++; }
  }
  assert.equal(trueHits, 0, 'allocator must NOT run in explicit-existing branch');
  assert.ok(elseHits > 0, 'allocator must run in normal-new branch');
}

/* ----------------------------- A3. V473/V475/V476 ---------------------------------- */
assert.match(page, /if \(!explicitExisting\) clearPranimiEntryHandoff\(\);/);     // V473
assert.match(page, /resolveDraftCodeLifecyclePin/);                               // V475
assert.match(page, /code_lifecycle_pin:/);                                        // V475 audit
assert.match(page, /finalSaveInFlightRef/);                                       // V476 in-flight barrier

/* ----------------------------- B. V477.1 save guard -------------------------------- */
assert.match(page, /isExplicitLockedSelectedClient/);
assert.match(page, /EXPLICIT_EXISTING_CLIENT_LOCK_KEPT_HISTORICAL_CODE/);
assert.match(page, /isBaseEdit \|\| isExplicitLockedSelectedClient \|\|/);

console.log('static checks: PASS');

/* ----------------------------- C. lifecycle decision test plan --------------------- */
function normalizeMatchPhone(raw) {
  let d = String(raw || '').replace(/\D+/g, '');
  if (d.startsWith('00383')) d = d.slice(5); else if (d.startsWith('383')) d = d.slice(3);
  if (d.startsWith('0') && d.length >= 8) d = d.replace(/^0+/, '');
  return d;
}
const isValidClientPhoneDigits = (r) => normalizeMatchPhone(r).length >= 8;
const normalizeCode = (v) => { if (v == null) return null; const n = parseInt(String(v).replace(/\D+/g, ''), 10); return Number.isFinite(n) ? n : null; };
const isStrongBaseClientNamePhoneMatch = (cand = {}, { phone } = {}) => {
  const ip = normalizeMatchPhone(phone); const cp = normalizeMatchPhone(cand?.phone || '');
  return !!(isValidClientPhoneDigits(ip) && cp && cp === ip);
};

// Mirrors app/pranimi/page.jsx final-save decision (with V477.1 guard).
function decide({ selectedClient, isBaseEdit, name, phone, explicitLock }) {
  const rawId = String(selectedClient?.id || '').trim();
  const rawCode = normalizeCode(selectedClient?.code || null);
  const lock = explicitLock || null;
  const lockId = String(lock?.id || '').trim();
  const lockCode = normalizeCode(lock?.code || null);
  const isExplicitLocked = !!(
    lock?.explicit === true && lockId && lockCode != null &&
    selectedClient && rawId && rawId === lockId &&
    rawCode != null && String(rawCode) === String(lockCode)
  );
  const resolved = (selectedClient && (isBaseEdit || isExplicitLocked || (rawId && isStrongBaseClientNamePhoneMatch(selectedClient, { name, phone })))) ? selectedClient : null;
  const resolvedId = String(resolved?.id || '').trim() || null;
  const resolvedCodeNum = resolvedId ? normalizeCode(resolved?.code ?? null) : null;
  const resolvedCode = resolvedCodeNum != null ? String(resolvedCodeNum) : '';
  return isBaseEdit ? 'EDIT_EXISTING_ORDER' : (resolvedCode ? 'EXISTING_CLIENT_HISTORICAL_CODE' : 'NEW_ASSIGNED_CODE');
}

const phoned = { id: 'c-471', code: '471', name: 'Arben Brajshori', phone: '044123123' };
const phoneless = { id: 'c-471', code: '471', name: 'Arben Brajshori', phone: '' };
const lockPhoned = { ...phoned, explicit: true };
const lockPhoneless = { ...phoneless, explicit: true };
const noLock = { id: '', code: '', name: '', phone: '', explicit: false };

const cases = [
  ['search existing (phoned)  -> historical', 'EXISTING_CLIENT_HISTORICAL_CODE',
    decide({ selectedClient: phoned, isBaseEdit: false, name: phoned.name, phone: '044123123', explicitLock: lockPhoned })],
  ['search existing (phoneless)-> historical', 'EXISTING_CLIENT_HISTORICAL_CODE',
    decide({ selectedClient: phoneless, isBaseEdit: false, name: phoneless.name, phone: '', explicitLock: lockPhoneless })],
  ['normal new client          -> new code',  'NEW_ASSIGNED_CODE',
    decide({ selectedClient: null, isBaseEdit: false, name: 'New Person', phone: '044999888', explicitLock: noLock })],
  ['manual phone confirm       -> historical', 'EXISTING_CLIENT_HISTORICAL_CODE',
    decide({ selectedClient: phoned, isBaseEdit: false, name: phoned.name, phone: '044123123', explicitLock: noLock })],
  ['stale lock + cleared client -> new code',  'NEW_ASSIGNED_CODE',
    decide({ selectedClient: null, isBaseEdit: false, name: 'X', phone: '044777666', explicitLock: lockPhoneless })],
  ['edit existing order         -> edit',      'EDIT_EXISTING_ORDER',
    decide({ selectedClient: phoned, isBaseEdit: true, name: phoned.name, phone: '044123123', explicitLock: noLock })],
];

let failed = 0;
for (const [label, expected, got] of cases) {
  const ok = expected === got;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} => ${got}`);
}
assert.equal(failed, 0, `${failed} lifecycle case(s) failed`);

console.log('lifecycle test plan: PASS');
console.log('verify-pranimi-existing-client-direct-lock-v477-1: PASS');
