import { isStatusVisibleOnPage, normalizeStatus, pickMonotonicStatus, getStatusRank } from '@/lib/reconcile/statusRules';
import { inferTable, normalizeCode, stableKeyFromCandidate } from '@/lib/reconcile/stableKey';
import { listActivePendingMutations } from '@/lib/reconcile/pendingMutations';
import { isCandidateBlockedByTombstone, readReconcileTombstones } from '@/lib/reconcile/tombstones';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseDateToMs(value) {
  const ms = Date.parse(value || 0);
  return Number.isFinite(ms) ? ms : 0;
}

function extractArray(obj, ...keys) {
  for (const key of keys) {
    if (Array.isArray(obj?.[key])) return obj[key];
    if (obj?.data && typeof obj.data === 'object' && Array.isArray(obj.data[key])) return obj.data[key];
  }
  return [];
}

function rowQty(row) {
  return toNumber(row?.qty ?? row?.pieces ?? 0, 0);
}

function rowM2(row) {
  return toNumber(row?.m2 ?? row?.m ?? row?.area ?? 0, 0);
}

function computePieces(order = {}) {
  const tepiha = extractArray(order, 'tepiha', 'tepihaRows');
  const staza = extractArray(order, 'staza', 'stazaRows');
  const tepihaCount = tepiha.reduce((sum, row) => sum + Math.max(1, rowQty(row)), 0);
  const stazaCount = staza.reduce((sum, row) => sum + Math.max(1, rowQty(row)), 0);
  const stairsQty = toNumber(order?.stairsQty ?? order?.data?.stairsQty ?? order?.shkallore?.qty ?? order?.data?.shkallore?.qty ?? 0, 0);
  return tepihaCount + stazaCount + stairsQty;
}

function computeM2(order = {}) {
  const tepiha = extractArray(order, 'tepiha', 'tepihaRows');
  const staza = extractArray(order, 'staza', 'stazaRows');
  const tepihaM2 = tepiha.reduce((sum, row) => sum + (rowM2(row) * Math.max(1, rowQty(row))), 0);
  const stazaM2 = staza.reduce((sum, row) => sum + (rowM2(row) * Math.max(1, rowQty(row))), 0);
  const stairsQty = toNumber(order?.stairsQty ?? order?.data?.stairsQty ?? order?.shkallore?.qty ?? order?.data?.shkallore?.qty ?? 0, 0);
  const stairsPer = toNumber(order?.stairsPer ?? order?.data?.stairsPer ?? order?.shkallore?.per ?? order?.data?.shkallore?.per ?? 0.3, 0.3);
  return Number((tepihaM2 + stazaM2 + (stairsQty * stairsPer)).toFixed(2));
}

function mergeOrderData(baseData = {}, patch = {}) {
  const safeBase = baseData && typeof baseData === 'object' ? { ...baseData } : {};
  const safePatch = patch && typeof patch === 'object' ? { ...patch } : {};
  const merged = { ...safeBase, ...safePatch };
  if (safeBase.client || safePatch.client) merged.client = { ...(safeBase.client || {}), ...(safePatch.client || {}) };
  if (safeBase.pay || safePatch.pay) merged.pay = { ...(safeBase.pay || {}), ...(safePatch.pay || {}) };
  return merged;
}

function pickSourcePriority(row = {}) {
  const source = String(row?.source || '').trim().toUpperCase();
  if (source === 'DB' || source === 'ORDERS' || source === 'ONLINE') return 50;
  if (source === 'TRANSPORT_ORDERS') return 45;
  if (row?._masterCache || source === 'BASE_CACHE') return 40;
  if (source === 'OUTBOX') return 30;
  if (source === 'LOCAL') return 20;
  return 10;
}

function normalizeRow(row = {}, fallbackSource = 'LOCAL') {
  if (!row || typeof row !== 'object') return null;
  const nested = row?.fullOrder && typeof row.fullOrder === 'object'
    ? row.fullOrder
    : (row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {});
  const fullOrder = mergeOrderData(nested, row?.data && typeof row.data === 'object' ? row.data : {});
  const status = normalizeStatus(row?.status || fullOrder?.status || '');
  const table = inferTable({ ...row, ...fullOrder });
  const id = String(row?.id || row?.db_id || row?.server_id || fullOrder?.id || '').trim();
  const local_oid = String(row?.local_oid || row?.oid || fullOrder?.local_oid || fullOrder?.oid || '').trim();
  const code = normalizeCode(row?.code || row?.code_str || fullOrder?.code || fullOrder?.code_str || fullOrder?.client?.code || fullOrder?.client_code);
  const name = String(row?.name || row?.client_name || fullOrder?.client_name || fullOrder?.client?.name || '').trim() || 'Pa Emër';
  const phone = String(row?.phone || row?.client_phone || fullOrder?.client_phone || fullOrder?.client?.phone || '').trim();
  const total = toNumber(row?.total ?? row?.price_total ?? fullOrder?.price_total ?? fullOrder?.pay?.euro ?? fullOrder?.total ?? 0, 0);
  const paid = toNumber(row?.paid ?? row?.paid_cash ?? fullOrder?.paid_cash ?? fullOrder?.pay?.paid ?? 0, 0);
  const m2 = Number((toNumber(row?.m2, NaN) || computeM2(fullOrder) || toNumber(fullOrder?.m2_total ?? fullOrder?.size ?? 0, 0)).toFixed(2));
  const cope = toNumber(row?.cope ?? row?.pieces ?? fullOrder?.pieces ?? computePieces(fullOrder), 0);
  const readyNote = String(row?.readyNote || row?.ready_note || fullOrder?.ready_note || fullOrder?.ready_location || '').trim();
  const readyText = String(row?.ready_note_text || fullOrder?.ready_note_text || '').trim();
  const readyLocation = String(row?.ready_location || fullOrder?.ready_location || '').trim();
  const readySlots = Array.isArray(row?.ready_slots)
    ? row.ready_slots
    : (Array.isArray(fullOrder?.ready_slots) ? fullOrder.ready_slots : []);
  const readyTs = parseDateToMs(row?.ready_at || fullOrder?.ready_at || row?.delivered_at || fullOrder?.delivered_at || row?.updated_at || fullOrder?.updated_at || row?.created_at || fullOrder?.created_at || 0);
  const ts = Math.max(
    Number(row?.ts || 0),
    readyTs,
    parseDateToMs(row?.updated_at || 0),
    parseDateToMs(fullOrder?.updated_at || 0),
    parseDateToMs(row?.created_at || 0),
    parseDateToMs(fullOrder?.created_at || 0),
  );
  const normalized = {
    ...row,
    id,
    local_oid,
    table,
    status,
    source: String(row?.source || fallbackSource || 'LOCAL'),
    code,
    name,
    phone,
    total,
    paid,
    m2,
    cope,
    isPaid: paid >= total && total > 0,
    isReturn: !!(row?.isReturn || fullOrder?.returnInfo?.active),
    readyNote,
    ready_note_text: readyText,
    ready_location: readyLocation,
    ready_slots: readySlots,
    readyTs,
    ts,
    updated_at: row?.updated_at || fullOrder?.updated_at || '',
    fullOrder: mergeOrderData(fullOrder, {
      id: fullOrder?.id || id,
      local_oid: fullOrder?.local_oid || local_oid,
      status,
      code: fullOrder?.code || code,
      client_name: fullOrder?.client_name || name,
      client_phone: fullOrder?.client_phone || phone,
      ready_note: readyNote,
      ready_note_text: readyText,
      ready_location: readyLocation,
      ready_slots: readySlots,
      pay: {
        ...(fullOrder?.pay && typeof fullOrder.pay === 'object' ? fullOrder.pay : {}),
        euro: total,
        paid,
      },
    }),
  };
  normalized.stableKey = stableKeyFromCandidate(normalized);
  return normalized.stableKey ? normalized : null;
}

function applyMutation(row, mutation) {
  if (!mutation) return row;
  const patch = mutation?.patch && typeof mutation.patch === 'object' ? mutation.patch : {};
  const mergedFullOrder = mergeOrderData(row?.fullOrder || {}, patch);
  const nextStatus = pickMonotonicStatus(row?.status, mutation?.status || patch?.status || mergedFullOrder?.status || '');
  const next = normalizeRow({
    ...row,
    ...patch,
    status: nextStatus || row?.status,
    source: String(row?.source || 'LOCAL'),
    fullOrder: mergeOrderData(mergedFullOrder, { status: nextStatus || row?.status }),
    _pendingMutation: true,
  }, row?.source || 'LOCAL');
  return next || row;
}

function pickWinner(prev, next) {
  if (!prev) return next;
  const prevRank = getStatusRank(prev?.status);
  const nextRank = getStatusRank(next?.status);
  if (prevRank !== nextRank) return nextRank > prevRank ? next : prev;
  const prevPriority = pickSourcePriority(prev);
  const nextPriority = pickSourcePriority(next);
  if (prevPriority !== nextPriority) return nextPriority > prevPriority ? next : prev;
  if (Number(prev?._pendingMutation ? 1 : 0) !== Number(next?._pendingMutation ? 1 : 0)) {
    return next?._pendingMutation ? next : prev;
  }
  if (Number(prev?.ts || 0) !== Number(next?.ts || 0)) return Number(next?.ts || 0) > Number(prev?.ts || 0) ? next : prev;
  if (Number(prev?.m2 || 0) !== Number(next?.m2 || 0)) return Number(next?.m2 || 0) > Number(prev?.m2 || 0) ? next : prev;
  return {
    ...prev,
    ...next,
    fullOrder: mergeOrderData(prev?.fullOrder || {}, next?.fullOrder || {}),
  };
}

function buildSyntheticRowsFromMutations(mutations = []) {
  return (Array.isArray(mutations) ? mutations : []).map((mutation) => normalizeRow({
    ...(mutation?.patch && typeof mutation.patch === 'object' ? mutation.patch : {}),
    id: mutation?.id || '',
    local_oid: mutation?.local_oid || '',
    code: mutation?.code || '',
    status: mutation?.status || mutation?.patch?.status || '',
    table: mutation?.table || '',
    source: 'OUTBOX',
    fullOrder: mutation?.patch || {},
    _pendingMutation: true,
  }, 'OUTBOX')).filter(Boolean);
}

export function buildReconciledRows({ page, baseRows = [], localRows = [], outboxSnapshot = [], options = {} } = {}) {
  const normalizedPage = String(page || '').trim().toLowerCase() || 'pastrimi';
  const pendingMutations = listActivePendingMutations(outboxSnapshot || []);
  const pendingByKey = new Map();
  for (const mutation of pendingMutations) {
    const key = String(mutation?.stableKey || '').trim();
    if (!key) continue;
    const prev = pendingByKey.get(key);
    if (!prev) {
      pendingByKey.set(key, mutation);
      continue;
    }
    const prevTs = Date.parse(prev?.created_at || 0) || 0;
    const nextTs = Date.parse(mutation?.created_at || 0) || 0;
    pendingByKey.set(key, nextTs >= prevTs ? mutation : prev);
  }

  const tombstones = readReconcileTombstones();
  const candidates = [
    ...(Array.isArray(baseRows) ? baseRows : []),
    ...(Array.isArray(localRows) ? localRows : []),
    ...buildSyntheticRowsFromMutations(Array.from(pendingByKey.values())),
  ].map((row) => normalizeRow(row, row?._masterCache ? 'BASE_CACHE' : (row?.source || 'LOCAL'))).filter(Boolean);

  const winners = new Map();
  for (const rawCandidate of candidates) {
    const stableKey = String(rawCandidate?.stableKey || '').trim();
    if (!stableKey) continue;
    const mutation = pendingByKey.get(stableKey);
    const candidate = applyMutation(rawCandidate, mutation);
    if (!candidate || !candidate.stableKey) continue;
    if (options?.hideTransport === true && /^T\d+$/i.test(String(candidate?.code || '').trim())) continue;
    if (isCandidateBlockedByTombstone(candidate, tombstones)) continue;
    if (!isStatusVisibleOnPage(normalizedPage, candidate?.status)) continue;
    if (normalizedPage === 'pastrimi' && getStatusRank(candidate?.status) > getStatusRank('pastrim')) continue;
    if (normalizedPage === 'gati' && getStatusRank(candidate?.status) > getStatusRank('gati')) continue;
    const prev = winners.get(stableKey);
    winners.set(stableKey, pickWinner(prev, candidate));
  }

  return Array.from(winners.values())
    .sort((a, b) => Number(b?.ts || b?.readyTs || 0) - Number(a?.ts || a?.readyTs || 0))
    .map((row) => ({
      ...row,
      readyNote: row?.readyNote || row?.fullOrder?.ready_note || '',
    }));
}
