function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeReconcileStatus(status) {
  const st = normalize(status);
  if (st === 'pastrimi') return 'pastrim';
  if (st === 'pranimi') return 'pranim';
  if (st === 'marrje_sot') return 'marrje';
  return st;
}

export function buildRemoteTruthTokenSet(rows = [], getTokens = null) {
  const set = new Set();
  const fn = typeof getTokens === 'function' ? getTokens : (() => []);
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const token of fn(row)) {
      if (token) set.add(String(token));
    }
  }
  return set;
}

export function getRemoteTruthMatch(row, remoteRows = [], getTokens = null) {
  const fn = typeof getTokens === 'function' ? getTokens : (() => []);
  const wanted = new Set(fn(row).map((x) => String(x || '')).filter(Boolean));
  if (!wanted.size) return null;
  for (const item of Array.isArray(remoteRows) ? remoteRows : []) {
    const tokens = fn(item).map((x) => String(x || '')).filter(Boolean);
    if (tokens.some((token) => wanted.has(token))) return item;
  }
  return null;
}

export function filterRowsByRemoteTruth(rows = [], opts = {}) {
  const remoteRows = Array.isArray(opts?.remoteRows) ? opts.remoteRows : [];
  const getTokens = typeof opts?.getTokens === 'function' ? opts.getTokens : (() => []);
  const getStatus = typeof opts?.getStatus === 'function' ? opts.getStatus : ((row) => row?.status);
  const allowed = new Set((Array.isArray(opts?.allowedStatuses) ? opts.allowedStatuses : []).map(normalizeReconcileStatus).filter(Boolean));

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const truth = getRemoteTruthMatch(row, remoteRows, getTokens);
    if (!truth) return true;
    if (!allowed.size) return true;
    const st = normalizeReconcileStatus(getStatus(truth));
    return allowed.has(st);
  });
}
