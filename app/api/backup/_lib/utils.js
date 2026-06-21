export const BACKUPS_TABLE = process.env.BACKUPS_TABLE || 'app_backups';

export function getReqPin(req) {
  try {
    const u = new URL(req.url);
    const qp = u.searchParams.get('pin');
    const hp = req.headers.get('x-backup-pin');
    return (qp || hp || '').trim();
  } catch {
    return '';
  }
}

export function requirePinOrBypass(pin) {
  const required = (process.env.BACKUP_PIN || process.env.BACKUP_COMPANY_PIN || '').trim();
  // If no pin configured in env, allow without pin (dev-friendly)
  if (!required) return { ok: true, used_pin: null, note: 'FALLBACK_NO_PIN' };
  if (!pin) return { ok: false, error: 'PIN_REQUIRED' };
  if (pin !== required) return { ok: false, error: 'PIN_INVALID' };
  return { ok: true, used_pin: required, note: 'PIN_OK' };
}

export function toDevice(req) {
  return String(req.headers.get('user-agent') || '').slice(0, 240);
}

export function jsonOk(extra = {}) {
  return { ok: true, ...extra };
}

export function jsonErr(code, detail = undefined) {
  return { ok: false, error: code, ...(detail ? { detail } : {}) };
}

export function deriveClientsFromOrders(orders) {
  const byPhone = new Map();
  for (const o of orders) {
    const d = o?.data || {};
    const c = d?.client || {};
    const phone = (o.client_phone || c.phone || '').trim();
    const name = (o.client_name || c.name || '').trim();
    const key = phone || name || String(o.code || o.id);
    if (!key) continue;

    const prev = byPhone.get(key) || {
      name: name || '-',
      phone: phone || '-',
      orders_count: 0,
      total_sum: 0,
      last_order_at: null,
    };
    prev.name = name || prev.name;
    prev.phone = phone || prev.phone;
    prev.orders_count += 1;
    prev.total_sum += Number(o.total || 0);
    const t = o.updated_at || o.created_at || null;
    if (!prev.last_order_at || (t && new Date(t).getTime() > new Date(prev.last_order_at).getTime())) {
      prev.last_order_at = t;
    }
    byPhone.set(key, prev);
  }
  const out = Array.from(byPhone.values());
  out.sort((a, b) => {
    const ta = a.last_order_at ? new Date(a.last_order_at).getTime() : 0;
    const tb = b.last_order_at ? new Date(b.last_order_at).getTime() : 0;
    return tb - ta;
  });
  return out;
}
