import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getRetiredStaffPinAlias,
  isRetiredStaffPin,
} from '../lib/staffIdentityAliases.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(
  ROOT,
  'supabase/migrations/20260829204536_canonical_staff_identity_v1.sql',
);
const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
const compactSql = sql.replace(/\s+/g, ' ').trim();
const SOURCE_FILE = /\.(?:js|jsx|mjs|cjs|ts|tsx|sql)$/i;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionDefinition(qualifiedName) {
  const marker = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegex(qualifiedName)}\\s*\\(`,
    'i',
  );
  const start = sql.search(marker);
  assert.notEqual(start, -1, `${qualifiedName} must be defined by the migration`);
  const end = sql.indexOf('$$;', start);
  assert.notEqual(end, -1, `${qualifiedName} definition must have a dollar-quoted terminator`);
  return sql.slice(start, end + 3);
}

function statementsMatching(pattern) {
  return (sql.match(/(?:grant|revoke)\s+(?:all|execute)[\s\S]*?;/gi) || [])
    .filter((statement) => pattern.test(statement));
}

function assertServiceRoleOnlyRpc(name) {
  const definition = functionDefinition(`public.${name}`);
  assert.match(definition, /security\s+definer/i, `${name} must be SECURITY DEFINER`);
  assert.match(
    definition,
    /set\s+search_path\s*=\s*''/i,
    `${name} must use an empty, immutable search_path`,
  );

  const escapedName = escapeRegex(name);
  const aclStatements = statementsMatching(new RegExp(`public\\.${escapedName}\\s*\\(`, 'i'));
  const grants = aclStatements.filter((statement) => /^\s*grant\b/i.test(statement));
  const revokes = aclStatements.filter((statement) => /^\s*revoke\b/i.test(statement));

  assert.ok(
    grants.some((statement) => /\bto\s+service_role\b/i.test(statement)),
    `${name} must grant execution to service_role`,
  );
  assert.equal(
    grants.some((statement) => /\bto\s+(?:public|anon|authenticated)\b/i.test(statement)),
    false,
    `${name} must not grant execution to public, anon, or authenticated`,
  );
  assert.ok(
    revokes.some((statement) => (
      /\bfrom\s+public\s*,\s*anon\s*,\s*authenticated\b/i.test(statement)
      || [/'public'/i, /'anon'/i, /'authenticated'/i].every((role) => role.test(statement))
    )),
    `${name} must explicitly revoke public, anon, and authenticated execution`,
  );
}

function quotedArrayItems(definition, variableName) {
  const match = definition.match(new RegExp(
    `${escapeRegex(variableName)}\\s+constant\\s+text\\[\\]\\s*:=\\s*array\\s*\\[([\\s\\S]*?)\\]\\s*;`,
    'i',
  ));
  assert.ok(match, `${variableName} controlled-key array must exist`);
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]));
}

const RETIRED_PINS = new Set(['5555', '6666', '8888']);
for (const retiredPin of RETIRED_PINS) {
  assert.equal(isRetiredStaffPin(retiredPin), true, `${retiredPin} must be retired in app identity rules`);
  const alias = getRetiredStaffPinAlias(retiredPin);
  assert.equal(alias?.retiredPin, retiredPin);
  assert.equal(Object.hasOwn(alias || {}, 'canonicalPin'), false, 'browser denylist must not expose a current credential');
  assert.equal(Object.hasOwn(alias || {}, 'canonicalUserId'), false, 'browser denylist must not perform identity merging');
}

// A current credential must never be committed next to a real identity or a
// canonical/current-PIN mapping. This scans both tracked and intended-to-be-
// tracked batch files, while allowing the three explicit retired PINs as
// permanent denylist/history evidence.
const sourceFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { cwd: ROOT, encoding: 'utf8' },
).split(/\r?\n/).filter(Boolean).filter((relativePath) => (
  SOURCE_FILE.test(relativePath)
  && !relativePath.startsWith('dist/')
  && !relativePath.startsWith('node_modules/')
  && !/(?:^|\/)(?:backup|backups|snapshots?)(?:\/|$)/i.test(relativePath)
  && !/(?:backup|snapshot)/i.test(path.basename(relativePath))
));
const credentialLeakContexts = [];
for (const relativePath of sourceFiles) {
  // Test fixtures intentionally exercise PIN-shaped values; production source
  // and the migration repair block below are the credential-leak boundaries.
  if (relativePath.startsWith('tools/')) continue;
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const lines = source.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const context = lines.slice(Math.max(0, lineIndex - 1), lineIndex + 2).join('\n');
    if (!/(?:bujar|blerim|canonical[_a-z]*pin|current[_a-z]*pin|current\s+credential)/i.test(context)) continue;
    for (const match of lines[lineIndex].matchAll(/(['"])(\d{4,12})\1/g)) {
      if (!RETIRED_PINS.has(match[2])) {
        credentialLeakContexts.push(`${relativePath}:${lineIndex + 1}`);
      }
    }
  }
}
assert.deepEqual(
  [...new Set(credentialLeakContexts)],
  [],
  'current PIN literals must be absent from every non-backup source/migration identity context',
);

for (const name of [
  'resolve_staff_identity_v1',
  'merge_staff_identity_v1',
  'save_staff_identity_v1',
]) {
  assertServiceRoleOnlyRpc(name);
}

assert.doesNotMatch(
  sql,
  /['"][0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}['"]\s*::\s*uuid/i,
  'known staff UUIDs must be discovered from live identity evidence, not hardcoded',
);

const repairMarker = sql.search(/discover\s+the\s+known\s+repairs/i);
assert.notEqual(repairMarker, -1, 'the migration must mark its two live identity repairs');
const repairSql = sql.slice(repairMarker);
assert.match(repairSql, /\bdo\s+\$[a-z0-9_]*\$/i, 'live identity repair must run in a fail-closed DO block');
assert.match(repairSql, /private\.staff_normalize_name_v1\s*\(/i, 'live users must be matched by normalized identity evidence');
for (const pin of RETIRED_PINS) {
  assert.match(repairSql, new RegExp(`'${pin}'`), `repair block must account for PIN ${pin}`);
}
const repairPinLiterals = [...repairSql.matchAll(/(['"])(\d{4,12})\1/g)]
  .map((match) => match[2]);
assert.deepEqual(
  [...new Set(repairPinLiterals.filter((pin) => !RETIRED_PINS.has(pin)))],
  [],
  'repair SQL may contain retired history PINs, but manager/current PINs must be selected dynamically',
);
assert.doesNotMatch(
  repairSql,
  /(?:_TO_|CURRENT_PIN|CANONICAL_PIN)[0-9_:-]*\d{4}/i,
  'comments and idempotency keys must not leak a current PIN either',
);
assert.match(repairSql, /from\s+public\.users/i, 'repair identities must be read dynamically from public.users');
assert.match(
  repairSql,
  /(?:upper|lower)\s*\([^)]*role[\s\S]{0,500}(?:admin|owner|pronar|master)/i,
  'the migration actor must be selected dynamically from an active manager role',
);
assert.doesNotMatch(
  repairSql,
  /(?:select|perform)\s+public\.merge_staff_identity_v1\s*\(\s*'/i,
  'merge calls must use the dynamically selected manager instead of a literal PIN',
);
const dynamicMergeCalls = [...repairSql.matchAll(
  /(?:select|perform)\s+public\.merge_staff_identity_v1\s*\(\s*([a-z_][a-z0-9_.]*)\s*,\s*([a-z_][a-z0-9_.]*)/gi,
)];
assert.ok(dynamicMergeCalls.length >= 2, 'both repairs must call the merge RPC with dynamic actor and user variables');

const historyDefinition = functionDefinition('private.canonicalize_staff_history_v1');
const baseUpdates = [...historyDefinition.matchAll(/update\s+public\.base_code_pool[\s\S]*?;/gi)]
  .map((match) => match[0]);
const expiredRelease = baseUpdates.find((statement) => /status\s*=\s*'available'/i.test(statement));
assert.ok(expiredRelease, 'expired BASE reservations must have an explicit release update');
for (const clearedField of [
  'owner_id',
  'reserved_by',
  'reserved_at',
  'lease_expires_at',
  'draft_session_id',
  'draft_has_meaningful_work',
]) {
  const expectedValue = clearedField === 'owner_id'
    ? `${clearedField}\\s*=\\s*''`
    : clearedField === 'draft_has_meaningful_work'
      ? `${clearedField}\\s*=\\s*false`
      : `${clearedField}\\s*=\\s*null`;
  assert.match(
    expiredRelease,
    new RegExp(expectedValue, 'i'),
    `expired reservation release must clear ${clearedField}`,
  );
}
assert.match(expiredRelease, /status\s*=\s*'reserved'/i);
assert.match(expiredRelease, /lease_expires_at/i);
assert.match(expiredRelease, /pg_catalog\.now\s*\(\s*\)/i);
assert.match(expiredRelease, /p_old_pins/i);

const usedOwnerUpdate = baseUpdates.find((statement) => (
  /owner_id\s*=\s*p_new_pin/i.test(statement)
  && /status\s*(?:=\s*'used'|in\s*\(\s*'used'\s*\))/i.test(statement)
));
assert.ok(usedOwnerUpdate, 'used BASE code owner_id history must move to the canonical PIN');
assert.match(usedOwnerUpdate, /owner_id\s*=\s*any\s*\(\s*p_old_pins\s*\)/i);

const jsonDefinition = functionDefinition('private.staff_identity_json_canonicalize_v1');
const pinKeys = quotedArrayItems(jsonDefinition, 'v_pin_keys');
const idKeys = quotedArrayItems(jsonDefinition, 'v_id_keys');
for (const key of [
  'created_by_pin',
  'delivered_by',
  'responsible_worker_pin',
  'wrapped_by',
  'by_pin',
]) {
  assert.ok(pinKeys.has(key), `recursive PIN allowlist must include ${key}`);
}
for (const key of [
  'assigned_driver_id',
  'delivered_by_transport_id',
  'transport_id',
  'transport_user_id',
]) {
  assert.ok(idKeys.has(key), `recursive UUID allowlist must include ${key}`);
}
for (const forbidden of ['notes', 'note', 'phone', 'client_phone', 'idempotency_key']) {
  assert.equal(pinKeys.has(forbidden) || idKeys.has(forbidden), false, `${forbidden} must remain untouched free-form data`);
}
assert.match(jsonDefinition, /pg_catalog\.jsonb_each\s*\(/i);
assert.match(jsonDefinition, /pg_catalog\.jsonb_array_elements\s*\(/i);
assert.match(jsonDefinition, /with\s+ordinality/i);
assert.ok(
  (jsonDefinition.match(/private\.staff_identity_json_canonicalize_v1\s*\(/gi) || []).length >= 3,
  'controlled JSON canonicalization must recurse through both nested objects and arrays',
);

function canonicalize(value, oldPins, newPin, oldIds, newTransportId) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, oldPins, newPin, oldIds, newTransportId));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (item && typeof item === 'object') {
      return [key, canonicalize(item, oldPins, newPin, oldIds, newTransportId)];
    }
    const text = String(item ?? '');
    if (pinKeys.has(key) && oldPins.has(text)) return [key, newPin];
    if (
      idKeys.has(key)
      && (oldIds.has(text) || (['transport_id', 'tid'].includes(key) && oldPins.has(text)))
    ) return [key, newTransportId];
    return [key, item];
  }));
}

const oldBlerimId = '00000000-0000-4000-8000-000000000001';
const canonicalBlerimId = '00000000-0000-4000-8000-000000000002';
const jsonFixture = {
  created_by_pin: '6666',
  note: 'call 6666; idempotency 8888 stays literal',
  phone: '0446666888',
  lifecycle: {
    by_pin: '8888',
    transport_id: '6666',
    assigned_driver_id: oldBlerimId,
  },
  visits: [{ delivered_by: '6666' }, { client_phone: '6666' }],
};
const canonicalFixture = canonicalize(
  jsonFixture,
  new Set(['6666', '8888']),
  'dynamic-current-pin',
  new Set([oldBlerimId]),
  canonicalBlerimId,
);
assert.equal(canonicalFixture.created_by_pin, 'dynamic-current-pin');
assert.equal(canonicalFixture.lifecycle.by_pin, 'dynamic-current-pin');
assert.equal(canonicalFixture.lifecycle.transport_id, canonicalBlerimId);
assert.equal(canonicalFixture.lifecycle.assigned_driver_id, canonicalBlerimId);
assert.equal(canonicalFixture.visits[0].delivered_by, 'dynamic-current-pin');
assert.equal(canonicalFixture.note, jsonFixture.note);
assert.equal(canonicalFixture.phone, jsonFixture.phone);
assert.equal(canonicalFixture.visits[1].client_phone, '6666');

const saveDefinition = functionDefinition('public.save_staff_identity_v1');
assert.match(
  saveDefinition,
  /exists\s*\(\s*select\s+1\s+from\s+private\.staff_pin_aliases\s+\w+\s+where\s+\w+\.alias_pin\s*=\s*v_pin\s*\)[\s\S]{0,160}STAFF_PIN_IS_RETIRED/i,
  'staff save must reject every retired PIN, including an alias owned by the same UUID',
);
assert.doesNotMatch(
  saveDefinition,
  /delete\s+from\s+private\.staff_pin_aliases/i,
  'staff save must never delete a same-user alias to make a retired PIN reusable',
);
assert.doesNotMatch(
  saveDefinition,
  /alias_pin\s*=\s*v_pin\s+and\s+\w+\.canonical_user_id\s*(?:<>|!=)\s*v_target_id/i,
  'retired-PIN rejection must not exempt aliases owned by the target user',
);

assert.match(compactSql, /STAFF_PIN_IS_RETIRED/i);
assert.match(compactSql, /STAFF_POSTCHECK_RETIRED_PIN_STILL_CURRENT/i);

console.log('PASS canonical staff identity migration is fail-closed, dynamic, lifecycle-safe, and service-role-only');
