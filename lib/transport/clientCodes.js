'use client';

// Transport client permanent codes (NR RENDOR) – local mapping by phone_digits.
// Keeps a stable client code per transport user even if DB schema doesn't have a client_code column.

export function normalizePhoneDigits(v) {
  return String(v ?? '').replace(/\D+/g, '');
}

function mapKey(tid) {
  return `transport_client_code_map_v1_${String(tid || '')}`;
}

function counterKey(tid) {
  return `transport_client_code_counter_v1_${String(tid || '')}`;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function getOrAssignTransportClientCode(transportId, phoneDigits) {
  const tid = String(transportId || '').trim();
  const pd = normalizePhoneDigits(phoneDigits);
  if (!tid || !pd) return null;

  const map = readJson(mapKey(tid), {});
  if (map[pd]) return Number(map[pd]);

  const next = Number(readJson(counterKey(tid), 0)) + 1;
  map[pd] = next;
  writeJson(mapKey(tid), map);
  writeJson(counterKey(tid), next);
  return next;
}
