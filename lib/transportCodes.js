import {
  refillPoolIfNeeded,
  takeCodeFromPoolOrOnline,
  markCodeUsedOrQueue,
  peekPoolCount,
} from "@/lib/transportCodePool";

// Public API used by pages.
// reserveTransportCode requires reservedBy (transport_id / PIN) so leases don't mix.

export async function reserveTransportCode(reservedBy) {
  try {
    await refillPoolIfNeeded(reservedBy);
  } catch {}
  return takeCodeFromPoolOrOnline(reservedBy);
}

export async function markTransportCodeUsed(tCode, usedBy) {
  return markCodeUsedOrQueue(usedBy, tCode);
}

export function getTransportCodePoolCount(reservedBy) {
  return peekPoolCount(reservedBy);
}
