// Permanent, retired staff PIN denylist.
//
// Current PINs are credentials and must never be mapped in browser code. Any
// cached actor carrying one of these old PINs is removed and must authenticate
// again with the current PIN. Historical identity merging lives only in DB.

const SESSION_PIN_FIELDS = Object.freeze([
  'pin',
  'pinCode',
  'pin_code',
  'transport_pin',
  'user_pin',
  'driver_pin',
]);

export const RETIRED_STAFF_PIN_ALIASES = Object.freeze({
  '5555': Object.freeze({
    retiredPin: '5555',
  }),
  '6666': Object.freeze({
    retiredPin: '6666',
  }),
  '8888': Object.freeze({
    retiredPin: '8888',
  }),
});

function clean(value) {
  try { return String(value ?? '').trim(); } catch { return ''; }
}

function cleanPin(value) {
  const valueText = clean(value);
  return /^\d{3,12}$/.test(valueText) ? valueText : '';
}

function safeParse(raw, fallback = null) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function getRetiredStaffPinAlias(pin) {
  return RETIRED_STAFF_PIN_ALIASES[cleanPin(pin)] || null;
}

export function isRetiredStaffPin(pin) {
  return !!getRetiredStaffPinAlias(pin);
}

function sessionPinCandidates(input = {}) {
  const direct = SESSION_PIN_FIELDS
    .map((field) => ({ field, pin: cleanPin(input?.[field]) }))
    .filter((entry) => entry.pin);

  // Very old sessions sometimes put the PIN in id/user_id. This may identify
  // a retired session even when another PIN-shaped field is also present.
  const legacy = ['user_id', 'id']
    .map((field) => ({ field, pin: cleanPin(input?.[field]) }))
    .filter((entry) => entry.pin);

  return [...direct, ...legacy];
}

/**
 * Detect a retired PIN in a stored actor. Browser code never translates it to
 * the current credential: the stale actor is rejected and must log in again.
 *
 * status:
 * - unchanged: no retired PIN is present
 * - rejected: a retired PIN was present; cached authentication must be removed
 */
export function reconcileRetiredStaffActor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 'unchanged', actor: input || null, alias: null };
  }

  const pinCandidates = sessionPinCandidates(input);
  const aliases = pinCandidates
    .map((entry) => getRetiredStaffPinAlias(entry.pin))
    .filter(Boolean);

  if (!aliases.length) return { status: 'unchanged', actor: input, alias: null };
  return {
    status: 'rejected',
    actor: null,
    alias: aliases[0],
    reason: 'RETIRED_PIN_RELOGIN_REQUIRED',
  };
}

function storageKeys(storage) {
  const keys = [];
  try {
    for (let index = 0; index < Number(storage?.length || 0); index += 1) {
      const key = storage.key(index);
      if (key != null) keys.push(String(key));
    }
  } catch {}
  return keys;
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove retired-PIN auth and bonus snapshots after a session reject.
 * Approval entries are never copied to the new PIN: the current PIN must earn
 * its own server-verified device approval. The physical device ID is preserved.
 */
export function purgeRetiredStaffPinCaches(storage, retiredPinInput) {
  const alias = getRetiredStaffPinAlias(retiredPinInput);
  const stats = { approvalEntries: 0, bonusKeys: 0, workerRows: 0 };
  if (!alias || !storage) return stats;
  const retiredPins = new Set(Object.keys(RETIRED_STAFF_PIN_ALIASES));

  const approvalsKey = 'tepiha_device_approvals_v1';
  try {
    const approvals = safeParse(storage.getItem(approvalsKey), null);
    if (approvals?.byPin) {
      for (const retiredPin of retiredPins) {
        if (!Object.prototype.hasOwnProperty.call(approvals.byPin, retiredPin)) continue;
        delete approvals.byPin[retiredPin];
        stats.approvalEntries += 1;
      }
      if (stats.approvalEntries > 0) writeJson(storage, approvalsKey, approvals);
    }
  } catch {}

  // Derived worker rows are safe to discard and must never be translated to a
  // current credential in browser storage.
  const workersKey = 'tepiha_base_ready_bonus_workers_v1';
  try {
    const cache = safeParse(storage.getItem(workersKey), null);
    if (cache && Array.isArray(cache.workers)) {
      const untouched = cache.workers.filter((row) => {
        const retired = retiredPins.has(cleanPin(row?.pin || row?.pinCode));
        if (retired) stats.workerRows += 1;
        return !retired;
      });
      if (stats.workerRows > 0) writeJson(storage, workersKey, { ...cache, workers: untouched });
    }
  } catch {}

  for (const key of storageKeys(storage)) {
    const isGlobalBonusSnapshot = key.startsWith('tepiha_base_bonus_opportunities_')
      || key.startsWith('tepiha_ready_bonus_attention_');
    const isRetiredSummary = key.startsWith('tepiha_base_ready_bonus_summary_')
      && key.split(':').slice(1).some((part) => retiredPins.has(part));
    if (!isGlobalBonusSnapshot && !isRetiredSummary) continue;
    try {
      storage.removeItem(key);
      stats.bonusKeys += 1;
    } catch {}
  }

  return stats;
}
