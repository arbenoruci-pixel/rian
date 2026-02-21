import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

export function adminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('MISSING_SUPABASE_URL');
  if (!key) throw new Error('MISSING_SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}

export function requirePinFromReq(req) {
  const required = String(process.env.BACKUP_PIN || '').trim();
  if (!required) return { ok: true, pin: '' };
  const url = new URL(req.url);
  const pin = String(url.searchParams.get('pin') || '').trim();
  if (!pin) return { ok: false, error: 'PIN_REQUIRED' };
  if (pin !== required) return { ok: false, error: 'INVALID_PIN' };
  return { ok: true, pin };
}

function toNum(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function mapOrdersForUI(ordersAll) {
  const out = [];
  for (const o of ordersAll || []) {
    const data = o?.data || {};
    const pay = data?.pay || {};
    const client = data?.client || {};
    out.push({
      id: o?.id,
      code: data?.code ?? o?.client_code ?? null,
      status: o?.status || data?.status || null,
      client_name: client?.name || o?.client_name || null,
      client_phone: client?.phone || o?.client_phone || null,
      total: toNum(pay?.euro ?? pay?.total ?? pay?.amount ?? o?.total),
      paid: toNum(pay?.paid ?? o?.paid),
      created_at: o?.created_at || null,
    });
  }
  return out;
}

export function summarizeClientsForUI(clientsAll, ordersUI) {
  const byCode = new Map();
  for (const c of clientsAll || []) {
    const code = String(c?.code ?? '').trim();
    if (!code) continue;

    // clients table fields vary between versions.
    // Prefer real column values, but gracefully handle older/newer schemas.
    const name =
      c?.name ||
      c?.full_name ||
      c?.client_name ||
      c?.display_name ||
      c?.emri ||
      '';
    const phone = c?.phone || c?.client_phone || c?.telefon || c?.tel || '';

    byCode.set(code, {
      code,
      name,
      phone,
      orders_count: 0,
      total_sum: 0,
      last_order_at: null,
    });
  }

  for (const o of ordersUI || []) {
    const code = String(o?.code ?? '').trim();
    if (!code) continue;
    const c = byCode.get(code) || {
      code,
      name: o?.client_name || '',
      phone: o?.client_phone || '',
      orders_count: 0,
      total_sum: 0,
      last_order_at: null,
    };
    c.orders_count += 1;
    c.total_sum += toNum(o?.total);
    const t = o?.created_at ? new Date(o.created_at).toISOString() : null;
    if (t && (!c.last_order_at || t > c.last_order_at)) c.last_order_at = t;
    byCode.set(code, c);
  }

  return Array.from(byCode.values()).sort((a, b) => {
    const an = Number(a.code);
    const bn = Number(b.code);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return String(a.code).localeCompare(String(b.code));
  });
}

export function buildPayload(snapshotRow) {
  const clientsAll = snapshotRow?.clients_all || [];
  const ordersAll = snapshotRow?.orders_all || [];

  const orders = mapOrdersForUI(ordersAll);
  const clients = summarizeClientsForUI(clientsAll, orders);

  return {
    generated_at: snapshotRow?.created_at || null,
    clients_count: clients.length,
    orders_count: orders.length,
    clients,
    orders,
  };
}
