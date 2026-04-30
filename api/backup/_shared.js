import { createAdminClientOrThrow } from '../_helpers.js';

export function getAdmin() {
  return createAdminClientOrThrow();
}

export function getQuery(req, key) {
  if (req?.query && key in req.query) {
    const value = req.query[key];
    return Array.isArray(value) ? value[0] : value;
  }
  try {
    const url = new URL(req.url, 'http://local');
    return url.searchParams.get(key);
  } catch {
    return null;
  }
}

export function getHeader(req, key) {
  try {
    const headers = req?.headers || {};
    if (typeof headers.get === 'function') return headers.get(key);
    return headers[key.toLowerCase()] || headers[key] || '';
  } catch {
    return '';
  }
}

export function readExpectedBackupPin() {
  return String(
    process.env.BACKUP_PIN ||
    process.env.BACKUP_COMPANY_PIN ||
    process.env.ADMIN_PIN ||
    process.env.TEPIHA_RESET_PIN ||
    ''
  ).trim();
}

export function requireBackupPinNode(req, { allowCron = false } = {}) {
  const expectedPin = readExpectedBackupPin();
  if (!expectedPin) return { ok: false, status: 500, error: 'BACKUP_PIN_NOT_SET' };

  if (allowCron) {
    const expectedCron = String(process.env.CRON_SECRET || '').trim();
    const auth = String(getHeader(req, 'authorization') || '').trim();
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const xCron = String(getHeader(req, 'x-cron-secret') || '').trim();
    const providedCron = xCron || bearer;
    if (expectedCron && providedCron && providedCron === expectedCron) {
      return { ok: true, via: 'cron' };
    }
  }

  const pin = String(getQuery(req, 'pin') || getHeader(req, 'x-backup-pin') || getHeader(req, 'x-admin-pin') || '').trim();
  if (!pin) return { ok: false, status: 401, error: 'PIN_REQUIRED' };
  if (pin !== expectedPin) return { ok: false, status: 401, error: 'INVALID_PIN' };
  return { ok: true, via: 'pin', pin };
}

export async function detectBackupsTable(sb) {
  for (const t of ['app_backups', 'backups']) {
    try {
      const { error } = await sb.from(t).select('id').limit(1);
      if (!error) return t;
    } catch {}
  }
  throw new Error('NO_BACKUPS_TABLE_ACCESS');
}

export function normalizeClient(c) {
  const first = String(c?.first_name || '').trim();
  const last = String(c?.last_name || '').trim();
  const full = String(c?.full_name || '').trim();
  const name = (full || `${first} ${last}`.trim()).trim();
  return {
    ...c,
    name: name || null,
  };
}

export function normalizeLatestRow(row) {
  const payload = row?.payload || null;
  const clients = Array.isArray(payload?.clients) ? payload.clients : [];
  const orders = Array.isArray(payload?.orders) ? payload.orders : [];
  const generatedAt = row?.generated_at || row?.created_at || null;
  const backupDate = payload?.backup_date || (generatedAt ? String(generatedAt).slice(0, 10) : null);
  return {
    id: row?.id,
    created_at: row?.created_at || null,
    generated_at: generatedAt,
    pin: row?.pin || null,
    backup_date: backupDate,
    clients_count: row?.clients_count ?? payload?.clients_cnt ?? clients.length,
    orders_count: row?.orders_count ?? payload?.orders_cnt ?? orders.length,
    open_orders_count: row?.open_orders_count ?? payload?.open_orders_cnt ?? null,
    clients,
    orders,
    payload,
  };
}

export async function buildLivePayload(sb) {
  const { data: clients, error: cErr } = await sb
    .from('clients')
    .select('id, code, full_name, first_name, last_name, phone, photo_url, created_at, updated_at')
    .order('code', { ascending: true });
  if (cErr) throw cErr;

  const { data: orders, error: oErr } = await sb
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (oErr) throw oErr;

  const clientsN = (clients || []).map(normalizeClient);
  const byCode = new Map(clientsN.map((c) => [String(c.code ?? ''), c]));

  const ordersN = (orders || []).map((o) => {
    const cc = String(o?.client_code ?? o?.clientCode ?? '');
    const c = byCode.get(cc);
    const client_name = c ? (c.name || c.full_name || '') : String(o?.client_name || o?.clientName || '');
    const client_phone = c ? String(c.phone || '') : String(o?.client_phone || o?.clientPhone || '');
    return {
      ...o,
      client_name: client_name || null,
      client_phone: client_phone || null,
    };
  });

  const openOrdersCount = ordersN.filter((o) => !['dorzim', 'archived'].includes(String(o.status || '').toLowerCase())).length;
  const generatedAt = new Date().toISOString();
  return {
    id: 'live',
    created_at: generatedAt,
    generated_at: generatedAt,
    pin: null,
    backup_date: generatedAt.slice(0, 10),
    clients_count: clientsN.length,
    orders_count: ordersN.length,
    open_orders_count: openOrdersCount,
    clients: clientsN,
    orders: ordersN,
    payload: {
      live: true,
      clients: clientsN,
      orders: ordersN,
      clients_count: clientsN.length,
      orders_count: ordersN.length,
      open_orders_count: openOrdersCount,
      generated_at: generatedAt,
    },
  };
}

export async function getTableColumns(sb, tableName) {
  const { data, error } = await sb
    .from('information_schema.columns')
    .select('column_name')
    .eq('table_schema', 'public')
    .eq('table_name', tableName);
  if (error) throw new Error(`COLUMNS_QUERY_FAILED_${tableName}: ${error.message}`);
  return new Set((data || []).map((r) => r.column_name));
}

export function pickKnown(obj, cols) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (cols.has(k)) out[k] = obj[k];
  }
  return out;
}

export async function upsertInChunks(sb, table, rows, onConflict) {
  const chunkSize = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const { error } = await sb.from(table).upsert(chunk, { onConflict });
    if (error) throw new Error(`UPSERT_FAILED_${table}: ${error.message}`);
    total += chunk.length;
  }
  return total;
}
