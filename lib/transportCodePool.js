// Legacy compatibility facade.
// All Transport T-code allocation now goes through the permanent-client allocator
// in transportCodes.js: one smallest safe T-code, DB-owned reservation, guarded release.

import {
  getTransportCodePoolCount,
  markCodeUsedOrQueue as markCodeUsedCanonical,
  refillPoolIfNeeded as refillCanonicalPool,
  reserveTransportCode,
} from '@/lib/transportCodes';

export async function refillPoolIfNeeded(reservedBy, opts = {}) {
  return refillCanonicalPool(reservedBy, {
    ...opts,
    poolSize: 1,
    threshold: 1,
  });
}

export async function takeCodeFromPoolOrOnline(reservedBy, opts = {}) {
  return reserveTransportCode(reservedBy, opts);
}

export async function markCodeUsedOrQueue(reservedBy, code) {
  return markCodeUsedCanonical(reservedBy, code);
}

export function peekPoolCount(reservedBy) {
  return getTransportCodePoolCount(reservedBy);
}
