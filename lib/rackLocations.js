export const SLOT_MAP_KEY = 'tepiha_gati_slot_map_v1';
export const RACK_SPOTS = Array.from({ length: 30 }, (_, i) => `A${i + 1}`);

export function loadSlotMap() {
  try {
    const raw = localStorage.getItem(SLOT_MAP_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const map = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (Array.isArray(v)) map[k] = v;
      else if (v && v.orderId) map[k] = [v];
    }
    return map;
  } catch {
    return {};
  }
}

export function saveSlotMap(map) {
  try { localStorage.setItem(SLOT_MAP_KEY, JSON.stringify(map || {})); } catch {}
}

export function releaseSlotsOwnedBy(map, orderId) {
  const oid = String(orderId || '');
  if (!oid) return map;
  const next = { ...(map || {}) };
  for (const k of Object.keys(next)) {
    next[k] = (next[k] || []).filter((x) => String(x.orderId) !== oid);
    if (next[k].length === 0) delete next[k];
  }
  return next;
}

export function reserveSlots(map, orderId, meta, slots) {
  const oid = String(orderId || '');
  if (!oid) return map;
  const next = { ...(map || {}) };
  const ts = Date.now();
  for (const s of slots || []) {
    const key = String(s || '').toUpperCase().trim();
    if (!key) continue;
    if (!next[key]) next[key] = [];
    if (!next[key].some((x) => String(x.orderId) === oid)) {
      next[key].push({ orderId: oid, code: meta?.code || '', name: meta?.name || '', ts });
    }
  }
  return next;
}
