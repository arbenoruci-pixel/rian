import { supabase } from "@/lib/supabaseClient";

const LS_KEY = "tepiha_client_balances_v1";
const TABLE = "client_balances";

function normPhone(phone) {
  return String(phone || "").replace(/\D+/g, "");
}

function isBrowser() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function readLocal() {
  if (!isBrowser()) return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeLocal(map) {
  if (!isBrowser()) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(map || {})); } catch {}
}

export async function getClientBalanceByPhone(phone) {
  const key = normPhone(phone);
  if (!key) return { ok: true, phone: key, debt_eur: 0, source: "none" };

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('phone,debt_eur,updated_at,client_name,last_order_id')
      .eq('phone', key)
      .maybeSingle();
    if (!error && data) {
      const debt = Math.max(0, Number(data.debt_eur || 0));
      const next = { ...readLocal(), [key]: { ...(readLocal()[key] || {}), ...data, debt_eur: debt } };
      writeLocal(next);
      return { ok: true, phone: key, debt_eur: debt, updated_at: data.updated_at || null, client_name: data.client_name || '', last_order_id: data.last_order_id || null, source: 'db' };
    }
  } catch {}

  const map = readLocal();
  const row = map[key] || null;
  return { ok: true, phone: key, debt_eur: Math.max(0, Number(row?.debt_eur || 0)), updated_at: row?.updated_at || null, client_name: row?.client_name || '', last_order_id: row?.last_order_id || null, source: row ? 'local' : 'none' };
}

export async function setClientBalanceByPhone({ phone, debt_eur = 0, client_name = '', last_order_id = null } = {}) {
  const key = normPhone(phone);
  if (!key) return { ok: false, error: 'MISSING_PHONE' };
  const debt = Math.max(0, Number(debt_eur || 0));
  const payload = {
    phone: key,
    debt_eur: debt,
    client_name: client_name || null,
    last_order_id: last_order_id || null,
    updated_at: new Date().toISOString(),
  };

  const map = readLocal();
  map[key] = payload;
  writeLocal(map);

  try {
    const { error } = await supabase.from(TABLE).upsert(payload, { onConflict: 'phone' });
    if (!error) return { ok: true, row: payload, source: 'db' };
  } catch {}
  return { ok: true, row: payload, source: 'local' };
}
