import { listMixedOrderRecords } from '@/lib/ordersService';

export const RACK_SPOTS = [
  ...Array.from({ length: 50 }, (_, i) => `A${i + 1}`),
  ...Array.from({ length: 20 }, (_, i) => `B${i + 1}`),
];

export const OVERFLOW_ROOMS = [
  { key: 'FURRA_POSHT', label: 'FURRA POSHT' },
  { key: 'FURRA_NALT', label: 'FURRA NALT' },
];

export const OVERFLOW_ROOM_SLOTS = Array.from({ length: 40 }, (_, i) => `A${i + 1}`);

export const OVERFLOW_SPOTS_BY_ROOM = OVERFLOW_ROOMS.reduce((acc, room) => {
  acc[room.key] = OVERFLOW_ROOM_SLOTS.map((slot) => `${room.key}_${slot}`);
  return acc;
}, {});

export const OVERFLOW_SPOTS = OVERFLOW_ROOMS.flatMap((room) => OVERFLOW_SPOTS_BY_ROOM[room.key] || []);

const ACTIVE_RACK_STATUS = 'gati';
const RACK_FETCH_LIMIT_BASE = 80;
const RACK_FETCH_LIMIT_TRANSPORT = 80;
const RACK_CACHE_TTL_MS = 30000;

const rackMapState = {
  ts: 0,
  map: null,
  promise: null,
};

function stripMarks(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function normalizeOverflowRoomKey(room) {
  const raw = stripMarks(room).replace(/[^A-Z0-9]+/g, '');
  if (raw.includes('POSHT')) return 'FURRA_POSHT';
  if (raw.includes('NALT') || raw.includes('NALTE') || raw.includes('LART')) return 'FURRA_NALT';
  const exact = OVERFLOW_ROOMS.find((item) => raw === item.key.replace(/_/g, ''));
  return exact?.key || '';
}

function normalizeOverflowSlot(slot) {
  const raw = stripMarks(slot).replace(/[^A-Z0-9]+/g, '');
  const match = raw.match(/^A(\d{1,2})$/);
  if (!match) return '';
  const nr = Number(match[1]);
  if (!Number.isFinite(nr) || nr < 1 || nr > 40) return '';
  return `A${nr}`;
}

function parseOverflowLocation(value) {
  const compact = stripMarks(value).replace(/[^A-Z0-9]+/g, '');
  const posht = compact.match(/FURRAPOSHTA(\d{1,2})/);
  if (posht) {
    const slot = normalizeOverflowSlot(`A${posht[1]}`);
    return slot ? `FURRA_POSHT_${slot}` : '';
  }
  const nalt = compact.match(/FURRANALTA(\d{1,2})/);
  if (nalt) {
    const slot = normalizeOverflowSlot(`A${nalt[1]}`);
    return slot ? `FURRA_NALT_${slot}` : '';
  }
  return '';
}

export function buildOverflowLocation(room, slot) {
  const roomKey = normalizeOverflowRoomKey(room);
  const slotKey = normalizeOverflowSlot(slot);
  return roomKey && slotKey ? `${roomKey}_${slotKey}` : '';
}

export function isOverflowLocation(value) {
  return OVERFLOW_SPOTS.includes(parseOverflowLocation(value) || String(value || '').toUpperCase());
}

export function normalizeRackSlotKey(value) {
  const overflowKey = parseOverflowLocation(value);
  if (overflowKey) return overflowKey;

  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\[|\]/g, '');
}

export function formatRackLocationLabel(value) {
  const key = normalizeRackSlotKey(value);
  const match = key.match(/^FURRA_(POSHT|NALT)_A(\d{1,2})$/);
  if (!match) return key;
  const roomLabel = match[1] === 'POSHT' ? 'FURRA POSHT' : 'FURRA NALT';
  return `${roomLabel} - A${Number(match[2])}`;
}

export function normalizeRackSlots(value) {
  const raw = Array.isArray(value)
    ? value
    : (Array.isArray(value?.ready_slots) ? value.ready_slots
      : Array.isArray(value?.data?.ready_slots) ? value.data.ready_slots
      : typeof value?.ready_location === 'string' ? value.ready_location.split(',')
      : typeof value?.data?.ready_location === 'string' ? value.data.ready_location.split(',')
      : typeof value?.ready_note === 'string' ? value.ready_note.split(',')
      : typeof value?.data?.ready_note === 'string' ? value.data.ready_note.split(',')
      : typeof value === 'string' ? value.split(',')
      : []);

  const out = [];
  for (const item of raw || []) {
    const cleaned = normalizeRackSlotKey(item);
    if (!cleaned) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

function readRackStatus(row) {
  return String(row?.status || row?.data?.status || '')
    .trim()
    .toLowerCase();
}

function shouldIncludeRowInRackMap(row) {
  return readRackStatus(row) === ACTIVE_RACK_STATUS;
}

function buildRackEntryKey(row) {
  const table = String(row?._table || row?.table || '').trim();
  const orderId = String(row?.id || row?.orderId || '').trim();
  const code = String(
    row?.client_tcode || row?.code || row?.data?.client_tcode || row?.data?.code || ''
  ).trim();
  return `${table}:${orderId || code}`;
}

export function buildRackMapFromRows(rows = []) {
  const map = {};
  const seen = {};

  for (const row of rows || []) {
    if (!shouldIncludeRowInRackMap(row)) continue;

    const slots = normalizeRackSlots(row);
    if (!slots.length) continue;

    const orderId = String(row?.id || row?.orderId || '');
    const code = String(
      row?.client_tcode || row?.code || row?.data?.client_tcode || row?.data?.code || ''
    ).trim();
    const name = String(row?.client_name || row?.data?.client_name || row?.data?.client?.name || '').trim();
    const entryKey = buildRackEntryKey(row);
    if (!entryKey) continue;

    for (const slot of slots) {
      if (!map[slot]) map[slot] = [];
      if (!seen[slot]) seen[slot] = new Set();
      if (seen[slot].has(entryKey)) continue;
      seen[slot].add(entryKey);
      map[slot].push({ orderId, code, name, ts: Date.now() });
    }
  }

  return map;
}

export async function fetchRackMapFromDb(options = {}) {
  const force = !!options?.force;
  const now = Date.now();

  if (!force && rackMapState.map && (now - Number(rackMapState.ts || 0) < RACK_CACHE_TTL_MS)) {
    return rackMapState.map;
  }

  if (!force && rackMapState.promise) {
    return rackMapState.promise;
  }

  const task = listMixedOrderRecords({
    byTable: {
      orders: {
        select: 'id,code,client_name,data,status',
        eq: { status: ACTIVE_RACK_STATUS },
        orderBy: 'updated_at',
        ascending: false,
        limit: RACK_FETCH_LIMIT_BASE,
      },
      transport_orders: {
        select: 'id,client_tcode,client_name,data,status',
        eq: { status: ACTIVE_RACK_STATUS },
        orderBy: 'updated_at',
        ascending: false,
        limit: RACK_FETCH_LIMIT_TRANSPORT,
      },
    },
  }).then((rows) => {
    const map = buildRackMapFromRows(rows || []);
    rackMapState.map = map;
    rackMapState.ts = Date.now();
    return map;
  }).finally(() => {
    rackMapState.promise = null;
  });

  rackMapState.promise = task;
  return task;
}

// Compatibility alias for existing pages. Single source stays DB-based.
export async function fetchRackSlotMap(options = {}) {
  return fetchRackMapFromDb(options);
}
