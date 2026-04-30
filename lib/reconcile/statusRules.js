const STATUS_ALIAS = {
  pranimi: 'pranim',
  pastrimi: 'pastrim',
  marrje: 'dorzim',
  pickup: 'dorzim',
  pickup_done: 'dorzim',
  delivered: 'dorzim',
  delivery: 'dorzim',
  ready: 'gati',
};

const STATUS_RANK = {
  pranim: 10,
  pastrim: 20,
  gati: 30,
  dorzim: 40,
};

export function normalizeStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return STATUS_ALIAS[raw] || raw;
}

export function getStatusRank(value) {
  return STATUS_RANK[normalizeStatus(value)] || 0;
}

export function pickMonotonicStatus(currentStatus, nextStatus) {
  const current = normalizeStatus(currentStatus);
  const next = normalizeStatus(nextStatus);
  if (!current) return next;
  if (!next) return current;
  return getStatusRank(next) >= getStatusRank(current) ? next : current;
}

export function isStatusVisibleOnPage(page, status) {
  const normalizedPage = String(page || '').trim().toLowerCase();
  const normalizedStatus = normalizeStatus(status);
  if (!normalizedStatus) return false;
  if (normalizedPage === 'pastrimi' || normalizedPage === 'pastrim') {
    return normalizedStatus === 'pastrim';
  }
  if (normalizedPage === 'gati') {
    return normalizedStatus === 'gati';
  }
  if (normalizedPage === 'dorzim' || normalizedPage === 'marrje-sot') {
    return normalizedStatus === 'dorzim';
  }
  return true;
}
