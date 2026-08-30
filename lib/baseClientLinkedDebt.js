const BASE_DEBT_STATUSES = new Set([
  'pastrim', 'gati', 'dorzim',
]);

function clean(value) {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function maxCents(values = []) {
  return Math.max(0, ...(Array.isArray(values) ? values : []).map(cents));
}

function euro(valueCents) {
  return Number((Math.max(0, Number(valueCents) || 0) / 100).toFixed(2));
}

function normalizedStatus(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '_');
}

function normalizedSource(value) {
  return clean(value).toUpperCase();
}

function normalizedClientId(value) {
  return clean(value).toLowerCase();
}

function baseOrderId(value) {
  const text = clean(value);
  return /^\d+$/.test(text) ? text : '';
}

function visitData(rowLike) {
  const row = asObject(rowLike);
  const data = asObject(row.data);
  const nested = asObject(data.data);
  return Object.keys(nested).length ? { ...data, ...nested, data: nested } : data;
}

/**
 * Resolve legacy BASE money fields without allowing a zero shadow column to
 * hide a real nested payment. Explicit debt is only a fallback when no total
 * exists; total minus the greatest recorded paid value is authoritative.
 */
export function resolveBaseVisitMoney(rowLike = {}) {
  const row = asObject(rowLike);
  const data = visitData(row);
  const pay = asObject(data.pay);
  const totals = asObject(data.totals);
  const totalCents = maxCents([
    row.total,
    row.price_total,
    data.total,
    data.price_total,
    pay.euro,
    pay.total,
    totals.total,
    totals.euro,
  ]);
  const paidCents = maxCents([
    row.paid,
    row.paid_cash,
    row.paid_amount,
    data.paid,
    data.paid_cash,
    data.clientPaid,
    pay.paid,
    pay.arkaRecordedPaid,
  ]);
  const explicitDebtCents = maxCents([
    row.debt,
    data.debt,
    data.debt_amount,
    asObject(data.payment_state).debt_remaining,
    pay.debt,
  ]);
  const debtCents = totalCents > 0
    ? Math.max(0, totalCents - paidCents)
    : explicitDebtCents;
  return {
    total: euro(totalCents),
    paid: euro(Math.min(paidCents, totalCents || paidCents)),
    debt: euro(debtCents),
    totalCents,
    paidCents,
    debtCents,
  };
}

function debtItem(rowLike, currentOrderId, canonicalClientId) {
  const row = asObject(rowLike);
  const orderId = baseOrderId(row.id || row.orderId || row.order_id);
  if (!orderId) return null;
  const source = normalizedSource(row.source || row._table || 'BASE');
  if (source && !['BASE', 'ORDERS', 'DB', 'LOCAL', 'OUTBOX'].includes(source)) return null;
  const status = normalizedStatus(row.status || row.state);
  if (!BASE_DEBT_STATUSES.has(status)) return null;
  const clientId = normalizedClientId(row.clientId || row.client_id);
  if (!canonicalClientId || clientId !== canonicalClientId) return null;
  const money = resolveBaseVisitMoney(row);
  if (money.debtCents <= 0) return null;
  return {
    orderId,
    clientId,
    status,
    current: orderId === currentOrderId,
    createdAt: clean(row.createdAt || row.created_at),
    total: money.total,
    paid: money.paid,
    debt: money.debt,
    debtCents: money.debtCents,
    code: clean(row.code),
  };
}

function currentAnchorItem(rowLike, currentOrderId, canonicalClientId) {
  const row = asObject(rowLike);
  const orderId = baseOrderId(row.id || row.orderId || row.order_id);
  const source = normalizedSource(row.source || row._table || 'BASE');
  const status = normalizedStatus(row.status || row.state);
  const clientId = normalizedClientId(row.clientId || row.client_id);
  if (!currentOrderId || orderId !== currentOrderId) return null;
  if (source && !['BASE', 'ORDERS', 'DB', 'LOCAL', 'OUTBOX'].includes(source)) return null;
  if (!BASE_DEBT_STATUSES.has(status)) return null;
  if (!canonicalClientId || clientId !== canonicalClientId) return null;
  const money = resolveBaseVisitMoney(row);
  return {
    orderId,
    clientId,
    status,
    current: true,
    createdAt: clean(row.createdAt || row.created_at),
    total: money.total,
    paid: money.paid,
    debt: money.debt,
    debtCents: money.debtCents,
    code: clean(row.code),
  };
}

/**
 * Build a fail-closed payment snapshot. Multi-visit linking requires the same
 * canonical client_id; name, phone, code and local_oid never join debt.
 */
export function buildBaseClientLinkedDebtPlan({
  currentOrderId: currentOrderIdLike,
  currentClientId: currentClientIdLike,
  profileClientId: profileClientIdLike,
  currentVisit,
  visits = [],
} = {}) {
  const currentOrderId = baseOrderId(currentOrderIdLike);
  const currentClientId = normalizedClientId(currentClientIdLike);
  const profileClientId = normalizedClientId(profileClientIdLike);
  const canonicalClientId = currentClientId && profileClientId && currentClientId === profileClientId
    ? currentClientId
    : '';

  const current = currentAnchorItem(currentVisit, currentOrderId, canonicalClientId);
  if (!current) {
    return { ok: false, error: 'CURRENT_ORDER_IDENTITY_NOT_VERIFIED', clientId: canonicalClientId || null, items: [], total: 0, totalCents: 0 };
  }

  const candidates = [...(Array.isArray(visits) ? visits : []), currentVisit]
    .filter(Boolean);
  const byOrder = new Map();
  for (const candidate of candidates) {
    const item = debtItem(candidate, currentOrderId, canonicalClientId);
    if (!item) continue;
    const existing = byOrder.get(item.orderId);
    if (!existing || item.current || item.debtCents > existing.debtCents) byOrder.set(item.orderId, item);
  }

  const items = Array.from(byOrder.values()).sort((a, b) => {
    const dateOrder = clean(a.createdAt).localeCompare(clean(b.createdAt));
    if (dateOrder) return dateOrder;
    return Number(a.orderId) - Number(b.orderId);
  });
  if (!items.length) {
    return { ok: false, error: 'CLIENT_HAS_NO_DEBT', clientId: canonicalClientId, currentOrderId, current, items: [], total: 0, totalCents: 0 };
  }
  const totalCents = items.reduce((sum, item) => sum + item.debtCents, 0);
  return {
    ok: true,
    clientId: canonicalClientId,
    currentOrderId,
    items,
    current,
    total: euro(totalCents),
    totalCents,
    linked: items.some((item) => item.orderId !== currentOrderId),
  };
}

export function allocateBaseClientLinkedDebt(itemsLike = [], amountLike = 0) {
  const amountCents = cents(amountLike);
  let remaining = amountCents;
  const allocations = [];
  for (const raw of Array.isArray(itemsLike) ? itemsLike : []) {
    const orderId = baseOrderId(raw?.orderId || raw?.order_id || raw?.id);
    const debtCents = cents(raw?.debt ?? (Number(raw?.debtCents || 0) / 100));
    if (!orderId || debtCents <= 0 || remaining <= 0) continue;
    const appliedCents = Math.min(debtCents, remaining);
    allocations.push({
      orderId,
      amount: euro(appliedCents),
      amountCents: appliedCents,
      debtBefore: euro(debtCents),
      debtAfter: euro(debtCents - appliedCents),
      current: raw?.current === true,
    });
    remaining -= appliedCents;
  }
  return {
    allocations,
    amount: euro(amountCents),
    applied: euro(amountCents - remaining),
    unallocated: euro(remaining),
  };
}

export function serializeBaseClientDebtSnapshot(itemsLike = []) {
  return (Array.isArray(itemsLike) ? itemsLike : [])
    .map((item) => ({
      orderId: baseOrderId(item?.orderId || item?.order_id || item?.id),
      debt: euro(cents(item?.debt ?? (Number(item?.debtCents || 0) / 100))),
    }))
    .filter((item) => item.orderId && item.debt > 0)
    .sort((a, b) => Number(a.orderId) - Number(b.orderId));
}

export function buildBaseClientDebtSnapshotToken(itemsLike = []) {
  const canonical = JSON.stringify(serializeBaseClientDebtSnapshot(itemsLike));
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 16777619);
    h2 = Math.imul(h2 ^ code, 2246822519);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}
