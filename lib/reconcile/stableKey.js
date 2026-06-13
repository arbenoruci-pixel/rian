function cleanString(value) {
  return String(value || '').trim();
}

function isNumericLike(value) {
  return /^\d+$/.test(cleanString(value));
}

function collectLocalOidCandidates(candidate = {}) {
  return [
    candidate?.local_oid,
    candidate?.oid,
    candidate?.payload?.local_oid,
    candidate?.payload?.oid,
    candidate?.fullOrder?.local_oid,
    candidate?.fullOrder?.oid,
    candidate?.data?.local_oid,
    candidate?.data?.oid,
    candidate?.client?.local_oid,
  ].map(cleanString).filter(Boolean);
}

function pickBestLocalOid(candidate = {}) {
  const candidates = collectLocalOidCandidates(candidate);
  const preferred = candidates.find((value) => value && !isNumericLike(value));
  return preferred || candidates[0] || '';
}

export function normalizeCode(raw) {
  const value = cleanString(raw);
  if (!value) return '';
  if (/^t\d+/i.test(value)) {
    const digits = value.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${digits || '0'}`;
  }
  const digits = value.replace(/\D+/g, '').replace(/^0+/, '');
  return digits || '';
}

export function inferTable(candidate = {}) {
  const rawTable = cleanString(
    candidate?._table ||
    candidate?.table ||
    candidate?.sourceTable ||
    candidate?.payload?.table ||
    candidate?.fullOrder?._table ||
    candidate?.fullOrder?.table ||
    candidate?.data?._table ||
    candidate?.data?.table
  );
  if (rawTable) return rawTable;
  const source = cleanString(candidate?.source).toLowerCase();
  if (source === 'transport_orders' || source === 'transport') return 'transport_orders';
  const code = normalizeCode(candidate?.code || candidate?.code_str || candidate?.client_code || candidate?.client?.code);
  if (/^t\d+$/i.test(code)) return 'transport_orders';
  return 'orders';
}

export function stableKeyFromCandidate(candidate = {}) {
  const table = inferTable(candidate);
  const id = cleanString(candidate?.id || candidate?.db_id || candidate?.server_id);
  const localOid = pickBestLocalOid(candidate);

  if (id) return `${table}:id:${id}`;
  if (localOid) return `${table}:local:${localOid}`;
  // Code/name/phone are display/search hints only. They are not authoritative identity
  // for merge/override because the same code can exist on multiple historical orders.
  return '';
}

export function stableTokensFromCandidate(candidate = {}) {
  const table = inferTable(candidate);
  const id = cleanString(candidate?.id || candidate?.db_id || candidate?.server_id);
  const localOid = pickBestLocalOid(candidate);
  return [
    id ? `${table}:id:${id}` : '',
    localOid ? `${table}:local:${localOid}` : '',
  ].filter(Boolean);
}
