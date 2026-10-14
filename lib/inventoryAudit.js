import { ADMIN_ROLES } from './roles.js';

export const AUDIT_PROCESSING = ['pastrim', 'pastrimi', 'at_base', 'in_base', 'base'];
export const AUDIT_READY = ['gati', 'ready'];
export const AUDIT_ACTIVE = [...AUDIT_PROCESSING, ...AUDIT_READY];
export const AUDIT_AGE_MS = 4 * 24 * 60 * 60 * 1000;
export const canAuditInventory = role => [...ADMIN_ROLES, 'MASTER'].includes(String(role || '').trim().toUpperCase());
export const auditObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const auditData = row => ({ ...auditObject(row?.data?.data), ...auditObject(row?.data) });
const clean = value => String(value ?? '').trim();
const number = (...values) => {
  for (const v of values) if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
};

export function auditTime(value) {
  if (value == null || value === '') return 0;
  const s = clean(value);
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : 0;
    return Number.isFinite(ms) && ms <= 8640000000000000 ? ms : 0;
  }
  const n = Date.parse(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function auditProcessingStarted(row) {
  const d = auditObject(row?.data), nested = auditObject(d.data);
  // This value is owned by the database transition trigger. Offline snapshots
  // cannot erase it or replace it with an earlier cycle (or a device clock).
  if (Object.hasOwn(d, 'inventory_processing_started_at')) return auditTime(d.inventory_processing_started_at);
  let latest = 0, ready = auditTime(row?.ready_at);
  for (const source of [nested, d]) {
    for (const key of ['pastrim_delay_started_at', 'pastrim_started_at', 'pastrimStartedAt', 'pastrim_at', 'base_processing_at', 'baseProcessingAt']) {
      latest = Math.max(latest, auditTime(source[key]));
    }
    for (const key of ['kthim', 'returnInfo']) {
      if (source[key]?.active !== false) latest = Math.max(latest, auditTime(source[key]?.at));
    }
    ready = Math.max(ready, auditTime(source.ready_at));
    // Histories may be newest-first, merged out of order, or stored under both
    // aliases/layers. Compare event dates, never their array positions.
    for (const key of ['status_history', 'statusHistory']) {
      for (const h of Array.isArray(source[key]) ? source[key] : []) {
        const status = [h?.to, h?.next_status, h?.nextStatus, h?.status].map(clean).find(Boolean)?.toLowerCase();
        const time = Math.max(auditTime(h?.at), auditTime(h?.created_at), auditTime(h?.ts));
        if (AUDIT_PROCESSING.includes(status)) latest = Math.max(latest, time);
        if (AUDIT_READY.includes(status)) ready = Math.max(ready, time);
      }
    }
  }
  // Evidence of a later ready cycle makes the old admission unsafe. Wait for a
  // dated return instead of authorizing a move from a previous cleaning cycle.
  if (ready && ready >= latest) return 0;
  // Ordinary metadata edits must not restart the clock.
  return latest || [row?.created_at, d.created_at, d.ts, nested.created_at, nested.ts].map(auditTime).find(Boolean) || 0;
}

export function summarizeAuditOrder(row, table, now = Date.now()) {
  const d = auditData(row), c = auditObject(d.client), pay = auditObject(d.pay);
  const status = clean(row.status || d.status).toLowerCase();
  const processing = AUDIT_PROCESSING.includes(status), started = auditProcessingStarted(row);
  const inventory = auditObject(d.inventory_audit);
  const audit = inventory.version === 1 ? inventory : {};
  const total = Math.max(0, number(row.price_total, row.total, d.price_total, d.total, pay.euro, d.totalEuro));
  const rawCode = clean(table === 'orders' ? row.code || row.client_code || c.code || d.code : row.client_tcode || row.code_str || c.tcode || d.code);
  const code = table === 'transport_orders' && rawCode && !/^T/i.test(rawCode) ? `T${rawCode}` : rawCode;
  const items = [...(Array.isArray(d.tepiha) ? d.tepiha : []), ...(Array.isArray(d.staza) ? d.staza : [])];
  return {
    key: `${table}:${row.id}`, id: clean(row.id), table, status,
    revision: row.updated_at || null, code: code || 'Pa kod',
    name: clean(row.client_name || d.client_name || c.name || c.full_name || d.name) || 'Pa emër',
    phone: clean(row.client_phone || d.client_phone || c.phone),
    location: clean(d.ready_location || d.ready_note_text || d.ready_note),
    pieces: number(row.pieces, d.pieces, d.paketimi_v1?.pieces?.length, items.length ? items.reduce((a, x) => a + number(x.qty, 1), 0) : null),
    m2: Math.max(0, number(row.m2_total, d.m2_total, d.totalM2, pay.m2)), total,
    createdAt: row.created_at || null, startedAt: started ? new Date(started).toISOString() : null,
    ageDays: started ? Math.max(0, Math.floor((now - started) / 86400000)) : null,
    overdue: processing && started > 0 && now - started > AUDIT_AGE_MS,
    stage: processing ? 'processing' : AUDIT_READY.includes(status) ? 'ready' : 'inactive',
    result: ['seen_in_depot', 'not_found'].includes(audit.result) ? audit.result : 'unverified',
    checkedAt: audit.at || null, checkedBy: clean(audit.by_name), note: clean(audit.note),
    movedForAudit: audit.action === 'MOVE_READY',
  };
}
