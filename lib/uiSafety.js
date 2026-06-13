export function getErrorMessage(err, fallback = 'Ndodhi një gabim. Provo përsëri.') {
  const raw = String(err?.message || err?.error || err || '').trim();
  if (!raw) return fallback;
  const low = raw.toLowerCase();
  if (low.includes('load failed') || low.includes('failed to fetch') || low.includes('network')) {
    return 'Gabim rrjeti. Kontrollo internetin dhe provo përsëri.';
  }
  if (low.includes('timeout')) {
    return 'Kërkesa mori shumë kohë. Provo përsëri.';
  }
  return raw;
}

export function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

export function isBusyGuard(...flags) {
  return flags.some(Boolean);
}
