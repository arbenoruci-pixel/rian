// Transport system constants (structure only)

export const TRANSPORT_PREFIX = 'T';

export const TRANSPORT_STATUSES = {
  INCOMPLETE: 'transport_incomplete',
  READY_FOR_BASE: 'transport_ready_for_base',
  // after unload at base:
  PASTRIM: 'pastrim',
  GATI_TRANSPORT: 'gati_transport',
  DOREZIM_TRANSPORT: 'dorezim_transport',
};

export function isTransportCode(code) {
  return /^T\d+$/i.test(String(code || '').trim());
}

export function normalizeTransportCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (isTransportCode(s)) return s;
  // allow numeric input => convert to T<num>
  const n = s.replace(/\D+/g, '');
  if (!n) return '';
  return `${TRANSPORT_PREFIX}${Number(n)}`;
}
