import { isPranimiArchivedOrder, isPranimiFinalOrderRow } from './pranimiOrderLifecycle.js';
const PRANIMI_DRAFT_SELECT = 'id,status,local_oid,code,client_name,client_phone,pieces,m2_total,price_total,paid_cash,is_paid_upfront,note,updated_at,created_at,data';
const PRANIMI_DB_DRAFT_STATUS = 'incomplete';
const PRANIMI_DB_DRAFT_FALLBACK_TOP_STATUS = 'pranim';

const DRAFT_LIKE_STATUSES = new Set([
  'draft',
  'incomplete',
  'paplotesuar',
  'pa_plotesuar',
  'pa_plotsuar',
  'e_paplotesuar',
  'e_pa_plotesuar',
  'e_pa_plotsuar',
  'te_paplotesuara',
  'te_pa_plotesuara',
  'te_pa_plotsuara',
  'local_draft',
  'pending_draft',
]);

function plain(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function normalizeStatus(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isDraftLikeStatus(value = '') {
  const s = normalizeStatus(value);
  if (!s) return false;
  return DRAFT_LIKE_STATUSES.has(s) || s.includes('draft') || s.includes('incomplete') || s.includes('paplotes') || s.includes('pa_plotes') || s.includes('pa_plots');
}

function isDbDraftFlagged(row = {}) {
  if (isPranimiArchivedOrder(row) || isPranimiFinalOrderRow(row)) return false;
  const data = plain(row?.data);
  const life = { ...plain(data?.pranimi_code_lifecycle), ...plain(data?.draft_lifecycle) };
  return data?.pranimi_db_draft === true
    || data?.is_pranimi_incomplete_draft === true
    || String(data?.source || data?.pranimi_draft_source || '').toUpperCase().includes('DB_DRAFT')
    || String(data?.source || data?.pranimi_draft_source || '').toUpperCase().includes('DB DRAFT')
    || life?.db_draft === true
    || String(life?.db_draft || '').toLowerCase() === 'true'
    || String(life?.db_draft_status || '').trim().toLowerCase() === PRANIMI_DB_DRAFT_STATUS;
}

function readDraftStatus(row = {}) {
  const data = plain(row?.data);
  const life = { ...plain(data?.pranimi_code_lifecycle), ...plain(data?.draft_lifecycle) };
  if (isDbDraftFlagged(row)) return String(data?.status || life?.db_draft_status || PRANIMI_DB_DRAFT_STATUS).trim();
  return String(row?.status || data?.status || '').trim();
}

function isBlockingOrder(row = {}) {
  if (!row?.id) return false;
  if (isPranimiArchivedOrder(row) || isPranimiFinalOrderRow(row)) return true;
  if (isDbDraftFlagged(row)) return false;
  return !isDraftLikeStatus(readDraftStatus(row));
}

function cleanNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[^0-9]/g, ''));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function extractLocalOid(row = {}) {
  const data = plain(row?.data);
  const life = { ...plain(data?.pranimi_code_lifecycle), ...plain(data?.draft_lifecycle) };
  return String(row?.local_oid || data?.local_oid || life?.local_oid || life?.draft_id || row?.id || '').trim();
}

function extractCode(row = {}) {
  const data = plain(row?.data);
  const life = { ...plain(data?.pranimi_code_lifecycle), ...plain(data?.draft_lifecycle) };
  const client = plain(data?.client);
  return normalizeCode(row?.code ?? data?.code ?? data?.client_code ?? client?.code ?? life?.code ?? life?.final_code ?? null);
}

function prepareDraftRow(input = {}, { topStatus = PRANIMI_DB_DRAFT_STATUS, reason = 'api_draft_save' } = {}) {
  const row = plain(input);
  const dataIn = plain(row?.data);
  const lifeIn = { ...plain(dataIn?.pranimi_code_lifecycle), ...plain(dataIn?.draft_lifecycle) };
  const localOid = extractLocalOid(row);
  const code = extractCode(row);
  if (!localOid) throw new Error('DRAFT_LOCAL_OID_REQUIRED');
  if (code == null) throw new Error('DRAFT_CODE_REQUIRED');

  const nowIso = new Date().toISOString();
  const data = {
    ...dataIn,
    id: String(dataIn?.id || localOid),
    oid: String(dataIn?.oid || localOid),
    local_oid: localOid,
    status: PRANIMI_DB_DRAFT_STATUS,
    code,
    client_code: code,
    client_name: row?.client_name ?? dataIn?.client_name ?? null,
    client_phone: row?.client_phone ?? dataIn?.client_phone ?? '',
    pranimi_db_draft: true,
    is_pranimi_incomplete_draft: true,
    pranimi_draft_source: 'DB DRAFT / SYNCED',
    source: dataIn?.source || 'DB_DRAFT',
    has_meaningful_work: true,
    updated_at: nowIso,
    pranimi_code_lifecycle: {
      ...lifeIn,
      local_oid: localOid,
      draft_id: localOid,
      code,
      final_code: code,
      db_draft: true,
      db_draft_status: PRANIMI_DB_DRAFT_STATUS,
      db_draft_reason: reason,
      db_draft_saved_at: nowIso,
      db_verify_state: 'DB_DRAFT',
      last_activity_at: Date.now(),
      last_activity_at_iso: nowIso,
      has_meaningful_work: true,
    },
    draft_lifecycle: {
      ...lifeIn,
      local_oid: localOid,
      draft_id: localOid,
      code,
      final_code: code,
      db_draft: true,
      db_draft_status: PRANIMI_DB_DRAFT_STATUS,
    },
  };

  return {
    local_oid: localOid,
    status: String(topStatus || PRANIMI_DB_DRAFT_STATUS).trim(),
    code,
    client_code: code,
    client_name: row?.client_name ?? data.client_name ?? null,
    client_phone: row?.client_phone ?? data.client_phone ?? '',
    pieces: cleanNumber(row?.pieces ?? data?.pieces) || 0,
    m2_total: cleanNumber(row?.m2_total ?? data?.m2_total) || 0,
    price_total: cleanNumber(row?.price_total ?? data?.price_total) || 0,
    paid_cash: cleanNumber(row?.paid_cash ?? data?.paid_cash) || 0,
    is_paid_upfront: !!row?.is_paid_upfront,
    note: row?.note ?? data?.note ?? null,
    updated_at: nowIso,
    data,
  };
}

async function firstRow(query) {
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function findDraftRowByLocalOid(sb, localOid = '') {
  const id = String(localOid || '').trim();
  if (!id) return null;
  const attempts = [
    () => sb.from('orders').select(PRANIMI_DRAFT_SELECT).eq('local_oid', id).order('updated_at', { ascending: false }),
    () => sb.from('orders').select(PRANIMI_DRAFT_SELECT).filter('data->>local_oid', 'eq', id).order('updated_at', { ascending: false }),
    () => sb.from('orders').select(PRANIMI_DRAFT_SELECT).filter('data->pranimi_code_lifecycle->>local_oid', 'eq', id).order('updated_at', { ascending: false }),
    () => sb.from('orders').select(PRANIMI_DRAFT_SELECT).filter('data->draft_lifecycle->>local_oid', 'eq', id).order('updated_at', { ascending: false }),
  ];
  for (const run of attempts) {
    try {
      const row = await firstRow(run());
      if (row) return row;
    } catch {}
  }
  return null;
}

async function writeDraftRow(sb, row, existing = null) {
  if (existing?.id) {
    const { data, error } = await sb.from('orders').update(row).eq('id', existing.id).select(PRANIMI_DRAFT_SELECT).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  const { data, error } = await sb.from('orders').insert(row).select(PRANIMI_DRAFT_SELECT).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function upsertDraft(sb, body = {}) {
  const input = plain(body?.row || body?.payload || {});
  const reason = String(body?.reason || 'api_draft_save');
  const localOid = extractLocalOid(input);
  if (!localOid) throw new Error('DRAFT_LOCAL_OID_REQUIRED');

  const existing = await findDraftRowByLocalOid(sb, localOid);
  if (existing && isBlockingOrder(existing)) {
    return { ok: false, error: 'EXISTING_FINAL_ORDER_FOR_LOCAL_OID', status: 409, row: existing };
  }

  let saved = null;
  let firstError = null;
  try {
    saved = await writeDraftRow(sb, prepareDraftRow(input, { topStatus: PRANIMI_DB_DRAFT_STATUS, reason }), existing);
  } catch (error) {
    firstError = error;
    saved = await writeDraftRow(sb, prepareDraftRow(input, { topStatus: PRANIMI_DB_DRAFT_FALLBACK_TOP_STATUS, reason: `${reason}_fallback_pranim` }), existing);
  }

  const verified = saved?.id ? (await findDraftRowByLocalOid(sb, localOid)) : null;
  if (!verified || isBlockingOrder(verified)) {
    throw new Error(`DRAFT_DB_VERIFY_FAILED${firstError ? `:${String(firstError?.message || firstError)}` : ''}`);
  }
  return { ok: true, verified: true, row: verified, via: firstError ? 'api_service_fallback_pranim' : 'api_service_incomplete' };
}

async function deleteDraft(sb, body = {}) {
  const localOid = String(body?.local_oid || extractLocalOid(body?.row || body?.payload || {}) || '').trim();
  const dbOrderId = String(body?.db_order_id || '').trim();
  let existing = null;
  if (dbOrderId && /^\d+$/.test(dbOrderId)) {
    const { data, error } = await sb.from('orders').select(PRANIMI_DRAFT_SELECT).eq('id', Number(dbOrderId)).maybeSingle();
    if (error) throw error;
    existing = data || null;
  }
  if (!existing && localOid) existing = await findDraftRowByLocalOid(sb, localOid);
  if (!existing) return { ok: true, deleted: false, row: null };
  if (isBlockingOrder(existing)) return { ok: false, error: 'DELETE_BLOCKED_FINAL_ORDER', status: 409, row: existing };
  const { error } = await sb.from('orders').delete().eq('id', existing.id);
  if (error) throw error;
  return { ok: true, deleted: true, row: existing };
}

export async function runPranimiDraftDbAction(body = {}, { supabase } = {}) {
  if (!supabase) throw new Error('SUPABASE_REQUIRED');
  const action = String(body?.action || 'upsert').trim().toLowerCase();
  if (action === 'delete') return deleteDraft(supabase, body);
  return upsertDraft(supabase, body);
}
