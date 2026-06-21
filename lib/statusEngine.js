const BASE_ALIASES = {
  pranim: 'pranim',
  pranimi: 'pranim',
  pastrim: 'pastrim',
  pastrimi: 'pastrim',
  gati: 'gati',
  dispatched: 'dispatched',
  marrje: 'marrje',
  marrje_sot: 'marrje',
  dorzim: 'dorzim',
  dorezim: 'dorzim',
  'dorëzim': 'dorzim',
  dorezuar: 'dorzim',
  'dorëzuar': 'dorzim',
};

const TRANSPORT_ALIASES = {
  new: 'pickup',
  inbox: 'pickup',
  pickup: 'pickup',
  pranim: 'pickup',
  dispatched: 'dispatched',
  loaded: 'loaded',
  ngarkim: 'loaded',
  ngarkuar: 'loaded',
  gati: 'gati',
  depo: 'depo',
  delivery: 'delivery',
  dorzim: 'delivery',
  dorezim: 'delivery',
  'dorëzim': 'delivery',
  marrje: 'delivery',
  failed: 'failed',
  deshtuar: 'failed',
  'dështuar': 'failed',
  no_show: 'failed',
  noshow: 'failed',
  returned: 'failed',
  kthim: 'failed',
};

const BASE_TRANSITIONS = {
  pranim: new Set(['pranim', 'pastrim']),
  pastrim: new Set(['pastrim', 'gati', 'dispatched']),
  gati: new Set(['gati', 'dorzim', 'marrje', 'pastrim', 'dispatched']),
  dispatched: new Set(['dispatched', 'pastrim', 'gati']),
  marrje: new Set(['marrje']),
  dorzim: new Set(['dorzim']),
  unknown: new Set(['pranim', 'pastrim', 'gati', 'dispatched', 'marrje', 'dorzim']),
};

const TRANSPORT_TRANSITIONS = {
  pickup: new Set(['pickup', 'dispatched', 'loaded', 'failed']),
  dispatched: new Set(['dispatched', 'loaded', 'pickup', 'failed']),
  loaded: new Set(['loaded', 'gati', 'delivery', 'depo', 'failed']),
  gati: new Set(['gati', 'delivery', 'depo', 'failed', 'loaded']),
  depo: new Set(['depo', 'delivery', 'failed', 'loaded']),
  delivery: new Set(['delivery', 'failed', 'depo', 'gati']),
  failed: new Set(['failed', 'dispatched', 'delivery', 'depo', 'gati', 'loaded']),
  unknown: new Set(['pickup', 'dispatched', 'loaded', 'gati', 'depo', 'delivery', 'failed']),
};

function normalizeString(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeStatusForTable(table, status) {
  const t = String(table || '').trim().toLowerCase();
  const raw = normalizeString(status);
  if (!raw) return '';
  if (t === 'transport_orders' || t === 'transport') return TRANSPORT_ALIASES[raw] || raw;
  return BASE_ALIASES[raw] || raw;
}

export function canTransitionStatus(table, fromStatus, toStatus) {
  const t = String(table || '').trim().toLowerCase();
  const from = normalizeStatusForTable(table, fromStatus) || 'unknown';
  const to = normalizeStatusForTable(table, toStatus);
  if (!to) return false;
  const map = (t === 'transport_orders' || t === 'transport') ? TRANSPORT_TRANSITIONS : BASE_TRANSITIONS;
  const allowed = map[from] || map.unknown;
  return !!allowed && allowed.has(to);
}

export function assertTransitionStatus(table, fromStatus, toStatus) {
  if (!canTransitionStatus(table, fromStatus, toStatus)) {
    const from = normalizeStatusForTable(table, fromStatus) || 'unknown';
    const to = normalizeStatusForTable(table, toStatus) || 'unknown';
    throw new Error(`STATUS_TRANSITION_NOT_ALLOWED:${String(table || '')}:${from}->${to}`);
  }
  return true;
}
