import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPranimiCodeAllocatorCore,
  normalizePinForAllocator,
  normalizeCodeForAllocator,
} from '../lib/pranimiCodeAllocator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const futureIso = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function makeHarness(options = {}) {
  const assigned = new Map();
  const proofs = new Map();
  const calls = { reserve: [], verify: [], renew: [], consume: [], release: [], releaseExisting: [], verifyExisting: [] };
  let seq = Number(options.startCode || 4300);
  const storage = {
    getAssigned: (oid) => assigned.get(oid) ?? null,
    setAssigned: (oid, code) => assigned.set(oid, normalizeCodeForAllocator(code)),
    clearAssigned: (oid) => assigned.delete(oid),
    getProof: (oid) => proofs.get(oid) ?? null,
    setProof: (oid, proof) => proofs.set(oid, structuredClone(proof)),
    clearProof: (oid) => proofs.delete(oid),
  };
  const db = {
    online: options.online !== false,
    async isOnline() { return this.online; },
    async reserveOne(args) {
      calls.reserve.push(args);
      if (options.reserveOne) return options.reserveOne(args, calls);
      seq += 1;
      return { code: seq, status: 'reserved', reserved_by: args.pin, draft_session_id: args.oid, lease_expires_at: futureIso(), verified: true };
    },
    async verifyDisplayable(args) {
      calls.verify.push(args);
      if (options.verifyDisplayable) return options.verifyDisplayable(args, calls);
      return { ok: true, displayable: true, verified: true, code: args.code, status: 'reserved', reserved_by: args.pin, draft_session_id: args.oid, lease_expires_at: futureIso() };
    },
    async renew(args) {
      calls.renew.push(args);
      if (options.renew) return options.renew(args, calls);
      return { ok: true, code: args.code, status: 'reserved', reserved_by: args.pin, draft_session_id: args.oid, lease_expires_at: futureIso() };
    },
    async markUsed(args) {
      calls.consume.push(args);
      if (options.markUsed) return options.markUsed(args, calls);
      return { ok: true, burned: true, code: args.code, order_id: args.orderId };
    },
    async release(args) {
      calls.release.push(args);
      if (options.release) return options.release(args, calls);
      return { ok: true, released: true, code: args.code };
    },
    async releaseAfterExistingClient(args) {
      calls.releaseExisting.push(args);
      if (options.releaseAfterExistingClient) return options.releaseAfterExistingClient(args, calls);
      return { ok: true, released: true, temp_code: args.tempCode, final_code: args.finalCode, order_id: args.orderId };
    },
    async verifyExistingClient(args) {
      calls.verifyExisting.push(args);
      if (options.verifyExistingClient) return options.verifyExistingClient(args, calls);
      return { ok: true, verified: true, code: args.code, client: { id: args.clientId, code: args.code } };
    },
  };
  return { core: createPranimiCodeAllocatorCore({ storage, db }), storage, db, assigned, proofs, calls };
}

// Fitim gets exactly one DB-bound/displayable code.
{
  const h = makeHarness({ startCode: 1001 });
  const result = await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'fitim-draft-1' });
  assert.equal(result.code, 1002);
  assert.equal(h.calls.reserve.length, 1);
  assert.equal(h.assigned.get('fitim-draft-1'), 1002);
  assert.equal(h.proofs.get('fitim-draft-1').pin, '1126');
}

// 25 reopens and concurrent opens reserve only once for the same PIN+draft.
{
  const h = makeHarness();
  const simultaneous = await Promise.all(Array.from({ length: 20 }, () => h.core.getOrAllocateForDraft({ pin: '1126', oid: 'same-draft' })));
  assert.equal(new Set(simultaneous.map((x) => x.code)).size, 1);
  for (let i = 0; i < 25; i += 1) await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'same-draft' });
  assert.equal(h.calls.reserve.length, 1, 'same draft must issue one mutating assignment request');
}

// Completed DB rejection clears a stale local code and allocates once through the official RPC.
{
  let first = true;
  const h = makeHarness({
    startCode: 5000,
    verifyDisplayable(args) {
      if (first) { first = false; return { ok: true, displayable: false, verified: true, reason: 'STATUS_NOT_RESERVED', code: args.code }; }
      return { ok: true, displayable: true, verified: true, code: args.code, status: 'reserved', reserved_by: args.pin, draft_session_id: args.oid, lease_expires_at: futureIso() };
    },
  });
  h.assigned.set('draft-stale', 287);
  const result = await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'draft-stale' });
  assert.equal(result.code, 5001);
  assert.equal(h.calls.reserve.length, 1);
  assert.notEqual(h.assigned.get('draft-stale'), 287);
}

// Timeout/ambiguous verification retains the same binding and never opens a second path.
{
  const h = makeHarness({ verifyDisplayable() { const e = new Error('timeout'); e.code = 'PRANIMI_ASSIGNMENT_VERIFY_RESULT_AMBIGUOUS'; throw e; } });
  h.assigned.set('draft-ambiguous', 1007);
  await assert.rejects(h.core.getOrAllocateForDraft({ pin: '1126', oid: 'draft-ambiguous' }), /timeout/);
  assert.equal(h.assigned.get('draft-ambiguous'), 1007);
  assert.equal(h.calls.reserve.length, 0);
}

// Finalized draft is terminal and cannot reserve another code.
{
  const h = makeHarness({ verifyDisplayable(args) { return { ok: true, terminal: true, displayable: false, verified: true, reason: 'DRAFT_ALREADY_FINALIZED', code: args.code, order_id: '2164' }; } });
  h.assigned.set('draft-final', 287);
  await assert.rejects(h.core.getOrAllocateForDraft({ pin: '1126', oid: 'draft-final' }), (e) => e?.code === 'DRAFT_ALREADY_FINALIZED' && e?.assignedCode === 287 && e?.orderId === '2164');
  assert.equal(h.calls.reserve.length, 0);
}

// Offline cannot invent. A fresh exact DB proof may reuse the same assignment; expired proof blocks.
{
  const h = makeHarness();
  const first = await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'draft-offline-proof' });
  h.db.online = false;
  const offline = await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'draft-offline-proof' });
  assert.equal(offline.code, first.code);
  assert.equal(offline.source, 'OFFLINE_VERIFIED_ASSIGNMENT');
  h.proofs.set('draft-offline-proof', { ...h.proofs.get('draft-offline-proof'), lease_expires_at: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(h.core.getOrAllocateForDraft({ pin: '1126', oid: 'draft-offline-proof' }), (e) => e?.code === 'BASE_CODE_OFFLINE_EMPTY');
  const empty = makeHarness({ online: false });
  await assert.rejects(empty.core.getOrAllocateForDraft({ pin: '1126', oid: 'no-proof' }), (e) => e?.code === 'BASE_CODE_OFFLINE_EMPTY');
}

// PIN only: UUID/user id is rejected.
{
  assert.equal(normalizePinForAllocator(' 1126 '), '1126');
  assert.equal(normalizePinForAllocator('f02ac388-f7bd-4636-8ae8-09d8f2a07ad9'), '');
  const h = makeHarness();
  await assert.rejects(h.core.getOrAllocateForDraft({ pin: 'f02ac388-f7bd-4636-8ae8-09d8f2a07ad9', oid: 'x' }), (e) => e?.code === 'MISSING_REAL_ACTOR_PIN');
}

// Failed consume keeps same code. Success still keeps binding until explicit post-commit acknowledgement.
{
  let attempt = 0;
  const h = makeHarness({ markUsed(args) { attempt += 1; return attempt === 1 ? { ok: false, reason: 'CONSUME_RESULT_AMBIGUOUS' } : { ok: true, burned: true, code: args.code, order_id: args.orderId }; } });
  const a = await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'save-retry' });
  await assert.rejects(h.core.consumeForDraft({ pin: '1126', oid: 'save-retry', code: a.code }), (e) => e?.code === 'CONSUME_ORDER_ID_REQUIRED');
  const failed = await h.core.consumeForDraft({ pin: '1126', oid: 'save-retry', code: a.code, orderId: '9001' });
  assert.equal(failed.ok, false);
  assert.equal(failed.retainBinding, true);
  assert.equal(h.assigned.get('save-retry'), a.code);
  const succeeded = await h.core.consumeForDraft({ pin: '1126', oid: 'save-retry', code: a.code, orderId: '9001' });
  assert.equal(succeeded.ok, true);
  assert.equal(h.assigned.get('save-retry'), a.code, 'binding clears only after UI acknowledges exact committed lifecycle');
  const ack = h.core.acknowledgeFinalizedDraft({ pin: '1126', oid: 'save-retry', code: a.code, orderId: '9001' });
  assert.equal(ack.ok, true);
  assert.equal(h.assigned.has('save-retry'), false);
  assert.deepEqual(h.calls.consume.map((x) => x.code), [a.code, a.code]);
  assert.deepEqual(h.calls.consume.map((x) => x.orderId), ['9001', '9001']);
}

// Release failure retains binding; confirmed release clears it.
{
  let n = 0;
  const h = makeHarness({ release() { n += 1; return n === 1 ? { ok: false, reason: 'RELEASE_AMBIGUOUS' } : { ok: true, released: true }; } });
  const a = await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'release-draft' });
  const first = await h.core.releaseForDraft({ pin: '1126', oid: 'release-draft', code: a.code });
  assert.equal(first.retainBinding, true);
  assert.equal(h.assigned.get('release-draft'), a.code);
  const second = await h.core.releaseForDraft({ pin: '1126', oid: 'release-draft', code: a.code });
  assert.equal(second.ok, true);
  assert.equal(h.assigned.has('release-draft'), false);
}

// Existing real client code is verified exactly; temporary assignment is released only after exact final order.
{
  const h = makeHarness();
  const a = await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'existing-client-draft' });
  const verified = await h.core.verifyExistingClientCode({ clientId: 'client-77', code: 287, phone: '044123123', name: 'Real Client' });
  assert.equal(verified.ok, true);
  const final = await h.core.finalizeExistingClientDraft({ pin: '1126', oid: 'existing-client-draft', finalCode: 287, orderId: '9100' });
  assert.equal(final.ok, true);
  assert.equal(final.tempCode, a.code);
  assert.equal(h.assigned.get('existing-client-draft'), a.code);
  assert.equal(h.core.acknowledgeFinalizedDraft({ pin: '1126', oid: 'existing-client-draft', code: a.code, orderId: '9100' }).ok, true);
}

// Fitim and another worker traverse the same reserveOne dependency.
{
  const h = makeHarness();
  await h.core.getOrAllocateForDraft({ pin: '1126', oid: 'fitim' });
  await h.core.getOrAllocateForDraft({ pin: '2380', oid: 'other' });
  assert.deepEqual(h.calls.reserve.map((x) => x.pin), ['1126', '2380']);
}

// ---------------- Source invariants ----------------
const baseCodes = read('lib/baseCodes.js');
const allocator = read('lib/pranimiCodeAllocator.js');
const serverAllocator = read('lib/baseCodeAllocatorServer.js');
const serverFacade = read('lib/pranimiCodeReserveServer.js');
const codeLease = read('lib/codeLease.js');
const page = read('app/pranimi/page.jsx');
const sql = read('supabase/sql/pranimi_code_oneway_allocator_20260621.sql');
const backupSql = read('supabase/sql/pranimi_code_oneway_allocator_20260621_BACKUP_AND_VERIFY.sql');
const pkg = JSON.parse(read('package.json'));

assert.match(pkg.version, /v39-1-pro-audit$/);
assert.equal((baseCodes.match(/\.rpc\(\s*['"]get_or_assign_pranimi_code['"]/g) || []).length, 1);
assert.doesNotMatch(baseCodes, /\.rpc\(\s*['"](?:reserve_base_codes_batch|reserve_base_codes_batch_simple|reserve_or_reuse_base_code_for_pin)['"]/);
assert.doesNotMatch(baseCodes, /highest\s*\+\s*1|Math\.max\([^\n]*highest|fillPoolToTarget|generate_series/i);
assert.doesNotMatch(baseCodes, /reserveVerifiedSharedCode|ensureUniqueBaseCodeForSave|reserveSharedCode|takeBaseCode|markCodeUsed|holdBaseCodeForDraft|releaseLocksForCode/);
assert.match(baseCodes, /export async function getOrAssignPranimiCodeInDb/);
assert.match(baseCodes, /export async function consumePranimiCodeAssignmentInDb/);
assert.match(baseCodes, /export async function releasePranimiCodeAssignmentInDb/);
assert.match(baseCodes, /if \(rawOverride\) return strictPin\(rawOverride\)/);
assert.doesNotMatch(serverAllocator, /owner_id|highestCodeFrom|generate_series|base_code_pool.*(?:insert|update|upsert)/i);
assert.doesNotMatch(serverFacade, /owner_id/);
assert.match(serverAllocator, /count !== 1/);
assert.equal((serverAllocator.match(/\.rpc\(\s*['"]get_or_assign_pranimi_code['"]/g) || []).length, 1);

assert.match(page, /from '@\/lib\/pranimiCodeAllocator'/);
assert.doesNotMatch(page, /\b(?:reserveSharedCode|ensureUniqueBaseCodeForSave|markCodeUsed|holdBaseCodeForDraft|releaseLocksForCode)\s*\(/);
assert.doesNotMatch(page, /\.rpc\(\s*['"](?:reserve_base_codes|get_or_assign_pranimi_code|mark_base_code_used_after_verify)/);
assert.doesNotMatch(page, /\.from\(\s*['"]base_code_pool['"]\s*\)\s*\.(?:insert|update|upsert|delete)/s);
assert.doesNotMatch(page, /\.from\(\s*['"](?:clients|orders)['"]\s*\)\s*\.delete\s*\(/s);
assert.match(page, /async function applyClientMatchChoice/);
assert.match(page, /existing_phone_client_confirmed_db_verified/);
assert.match(page, /verifyExistingPranimiClientCode\(candId, codeNum/);
assert.match(page, /consumePranimiCode\(finalActorPin, codeDraftId, persistedClientCode, exactOrderId/);
assert.match(page, /DRAFTI\/KODI ËSHTË I BLOKUAR/);
assert.match(page, /function shouldDraftSummaryRender[\s\S]*snapshotHasMeaningfulWork\(d\)[\s\S]*return true/);
assert.doesNotMatch(page.match(/function shouldDraftSummaryRender[\s\S]*?\n  }\n/)?.[0] || '', /normalizeCode|codeRaw|KOD_MUNGON/);
assert.match(page, /meaningful_draft_retained_for_official_code_reassignment/);
assert.doesNotMatch(page.match(/if \(!codePoolVerdict\?\.allow\) \{[\s\S]*?\n    }/)?.[0] || '', /removeDraftLocal|removeDraftReservationLocal/);
assert.doesNotMatch(codeLease, /assignOneCodeForDraft|reserveSharedCode|ensureUniqueBaseCodeForSave|markCodeUsed|releaseLocksForCode|supabase\.rpc/);
assert.match(allocator, /awaitingAcknowledgement/);
assert.match(allocator, /CONSUME_ORDER_ID_REQUIRED/);
assert.match(allocator, /getOrAssignPranimiCodeInDb/);
assert.match(allocator, /consumePranimiCodeAssignmentInDb/);
assert.match(allocator, /releasePranimiCodeAssignmentInDb/);
assert.doesNotMatch(allocator, /assignOneCodeForDraft|markCodeUsed|releaseLocksForCode/);

assert.match(sql, /Remove every historical overload/);
assert.match(sql, /oidvectortypes\(p\.proargtypes\)/);
assert.match(sql, /PRANIMI_LEGACY_ALLOCATOR_DISABLED_USE_GET_OR_ASSIGN/);
const executableSql = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert.doesNotMatch(executableSql, /generate_series|highest_code|max\s*\(\s*(?:b\.)?code\s*\)\s*\+/i);
assert.match(sql, /base_code_pool_one_bound_draft_per_pin_uidx/);
assert.match(sql, /DUPLICATE_ORDER_CODE_REVIEW_REQUIRED/);
assert.match(sql, /used_by_pin=clean_pin,used_draft_session_id=sid,used_order_id=exact_order_id/);
assert.doesNotMatch(sql, /o\.(?:local_oid|client_phone|data)->/);
assert.match(sql, /to_jsonb\(o\)->'data'->'pranimi_code_lifecycle'/);
assert.match(sql, /revoke all on function public\.reserve_base_codes_batch/);
assert.doesNotMatch(sql, /grant execute on function public\.reserve_base_codes_batch/);

const executableBackupSql = backupSql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert.doesNotMatch(executableBackupSql, /\b(?:insert|update|delete|truncate|call|perform|create|alter|drop)\b/i);
assert.doesNotMatch(executableBackupSql, /get_or_assign_pranimi_code\s*\(/i);
assert.match(backupSql, /LIVE-SCHEMA SAFETY GATE/);
assert.match(backupSql, /pg_get_triggerdef/);
assert.match(backupSql, /pg_get_functiondef\(p\.oid\)[\s\S]*base_code_pool/);

console.log('PRANIMI one-way allocator V39.1 PRO regression checks: PASS');
