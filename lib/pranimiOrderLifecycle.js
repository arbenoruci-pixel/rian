const FINAL_BASE_ORDER_STATUSES = new Set(['pastrim', 'gati', 'dorzim', 'transport']);
const DRAFT_STATUS_TEXT = new Set(['draft', 'incomplete', 'paplotesuar', 'pa_plotesuar', 'pa_plotsuar', 'e_paplotesuar', 'e_pa_plotesuar', 'e_pa_plotsuar', 'te_paplotesuara', 'te_pa_plotesuara', 'te_pa_plotsuara', 'local_draft', 'pending_draft']);

export function pranimiPlainObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

export function normalizePranimiLifecycleStatus(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function isPranimiFinalOrderStatus(value = '') {
  return FINAL_BASE_ORDER_STATUSES.has(normalizePranimiLifecycleStatus(value));
}

export function isPranimiDraftOrderStatus(value = '') {
  const s = normalizePranimiLifecycleStatus(value);
  if (!s) return false;
  return DRAFT_STATUS_TEXT.has(s) || s.includes('draft') || s.includes('incomplete') || s.includes('paplotes') || s.includes('pa_plotes') || s.includes('pa_plots');
}

export function isPranimiArchivedOrder(row = {}) {
  const data = pranimiPlainObject(row?.data || row);
  const status = normalizePranimiLifecycleStatus(data?.status || row?.status || '');
  const state = normalizePranimiLifecycleStatus(data?.state || '');
  const source = String(data?.source || row?.source || '').trim().toUpperCase();
  return status === 'archived_duplicate' || state === 'archived_duplicate' || source === 'DB_ARCHIVED';
}

export function isPranimiFinalOrderRow(row = {}) {
  if (!row) return false;
  const data = pranimiPlainObject(row?.data || {});
  return isPranimiFinalOrderStatus(row?.status) || isPranimiFinalOrderStatus(data?.status) || isPranimiFinalOrderStatus(data?.state);
}

export function isPranimiDraftFlaggedData(dataInput = {}) {
  const data = pranimiPlainObject(dataInput);
  const life = { ...pranimiPlainObject(data?.pranimi_code_lifecycle), ...pranimiPlainObject(data?.draft_lifecycle) };
  const source = String(data?.source || data?.pranimi_draft_source || '').toUpperCase();
  return data?.pranimi_db_draft === true
    || data?.is_pranimi_incomplete_draft === true
    || source.includes('DB_DRAFT')
    || source.includes('DB DRAFT')
    || life?.db_draft === true
    || String(life?.db_draft || '').toLowerCase() === 'true'
    || normalizePranimiLifecycleStatus(life?.db_draft_status || '') === 'incomplete'
    || normalizePranimiLifecycleStatus(life?.db_verify_state || '') === 'db_draft';
}

export function isPranimiDbDraftRow(row = {}) {
  if (isPranimiArchivedOrder(row)) return false;
  if (isPranimiFinalOrderRow(row)) return false;
  const data = pranimiPlainObject(row?.data || {});
  if (isPranimiDraftFlaggedData(data)) return true;
  return isPranimiDraftOrderStatus(row?.status || data?.status || data?.state || '');
}

function normalizeVerifyState(value = 'DB_VERIFIED') {
  const raw = String(value || '').trim();
  if (!raw) return 'DB_VERIFIED';
  const upper = raw.toUpperCase().replace(/\s+/g, '_');
  if (upper === 'DB_VERIFIED' || upper === 'DB_VERIFY_PENDING' || upper === 'DB_VERIFY_FAILED' || upper === 'LOCAL_/_NOT_SYNCED') return upper === 'LOCAL_/_NOT_SYNCED' ? 'LOCAL / NOT SYNCED' : upper;
  if (/LOCAL.*NOT.*SYNC/i.test(raw)) return 'LOCAL / NOT SYNCED';
  return raw;
}

export function normalizePranimiLocalOid(value, fallback = '') {
  const raw = String(value || '').trim();
  const fb = String(fallback || '').trim();
  if (/^\d+$/.test(raw) && fb && !/^\d+$/.test(fb)) return fb;
  return raw || fb;
}

export function buildPranimiFinalOrderData(dataInput = {}, opts = {}) {
  const nowIso = opts?.nowIso || new Date().toISOString();
  const data = { ...pranimiPlainObject(dataInput) };
  const status = String(opts?.status || data?.status || data?.state || 'pastrim').trim() || 'pastrim';
  const verifyState = normalizeVerifyState(opts?.verifyState || opts?.db_verify_state || 'DB_VERIFIED');
  const localSyncStatus = verifyState === 'DB_VERIFIED'
    ? 'DB_VERIFIED'
    : (verifyState === 'DB_VERIFY_PENDING' ? 'DB_VERIFY_PENDING' : verifyState);
  const localOid = normalizePranimiLocalOid(
    opts?.localOid || opts?.local_oid || data?.local_oid || data?.pranimi_code_lifecycle?.local_oid || data?.draft_lifecycle?.local_oid,
    opts?.fallbackLocalOid || ''
  );
  const existingLife = pranimiPlainObject(data?.pranimi_code_lifecycle);
  const existingDraftLife = pranimiPlainObject(data?.draft_lifecycle);
  const saveAttemptId = String(opts?.saveAttemptId || opts?.save_attempt_id || existingLife?.save_attempt_id || data?.save_attempt_id || '').trim();
  const serverId = String(opts?.serverId || opts?.server_id || existingLife?.server_id || '').trim();

  const finalLife = {
    ...existingLife,
    ...(opts?.lifecycle && typeof opts.lifecycle === 'object' ? opts.lifecycle : {}),
    ...(localOid ? { local_oid: localOid } : {}),
    ...(saveAttemptId ? { save_attempt_id: saveAttemptId } : {}),
    db_draft: false,
    db_draft_status: 'finalized',
    db_verify_state: verifyState,
    db_verified_at: verifyState === 'DB_VERIFIED' ? nowIso : existingLife?.db_verified_at,
    finalized_at: existingLife?.finalized_at || nowIso,
    ...(serverId ? { server_id: serverId } : {}),
  };

  return {
    ...data,
    status,
    state: status,
    ...(localOid ? { local_oid: localOid } : {}),
    source: opts?.source || (verifyState === 'LOCAL / NOT SYNCED' ? 'DB_FINAL_LOCAL_PENDING' : 'DB_FINAL'),
    pranimi_draft_source: opts?.draftSource || opts?.pranimi_draft_source || 'FINAL / NORMALIZED',
    is_pranimi_incomplete_draft: false,
    pranimi_db_draft: false,
    local_sync_status: localSyncStatus,
    updated_at: opts?.updatedAt || opts?.updated_at || data?.updated_at || nowIso,
    sync_error: verifyState === 'DB_VERIFIED' ? null : data?.sync_error,
    pranimi_code_lifecycle: finalLife,
    draft_lifecycle: {
      ...existingDraftLife,
      ...(localOid ? { local_oid: localOid, draft_id: localOid } : {}),
      db_draft: false,
      db_draft_status: 'finalized',
      finalized_at: existingDraftLife?.finalized_at || nowIso,
    },
  };
}

export function normalizePranimiFinalOrderRow(row = {}, opts = {}) {
  const out = { ...(row || {}) };
  const data = pranimiPlainObject(out?.data);
  const status = String(opts?.status || out?.status || data?.status || data?.state || '').trim();
  if (!isPranimiFinalOrderStatus(status)) return out;
  out.status = status;
  out.data = buildPranimiFinalOrderData(data, {
    ...opts,
    status,
    localOid: normalizePranimiLocalOid(out?.local_oid || data?.local_oid, opts?.fallbackLocalOid || ''),
    updatedAt: out?.updated_at || opts?.updatedAt,
  });
  return out;
}
