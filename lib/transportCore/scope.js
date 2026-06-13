export function isTransportPath(pathname = '') {
  const path = String(pathname || '').trim();
  return path === '/transport' || path.startsWith('/transport/');
}

export function getSyncOpPayload(op = {}) {
  const payload = op?.payload && typeof op.payload === 'object' ? op.payload : {};
  const data = op?.data && typeof op.data === 'object' ? op.data : {};
  return Object.keys(payload).length ? payload : data;
}

export function getSyncOpTable(op = {}) {
  const payload = getSyncOpPayload(op);
  return String(
    payload?.table ||
    payload?.insertRow?.table ||
    op?.table ||
    ''
  ).trim();
}

export function isTransportSyncTable(table = '') {
  const t = String(table || '').trim();
  return t === 'transport_orders' || t === 'transport_clients';
}

export function isTransportScopedOp(op = {}) {
  return isTransportSyncTable(getSyncOpTable(op));
}

export function isBaseScopedOp(op = {}) {
  return !isTransportScopedOp(op);
}
