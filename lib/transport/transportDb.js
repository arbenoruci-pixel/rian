import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';

const LS_TRANSPORT_CODE = 'transport_code_counter_v1';

function isBrowser(){ return typeof window !== 'undefined' && typeof localStorage !== 'undefined'; }

export function nextTransportCode() {
  if (!isBrowser()) return 'T1';
  let n = 0;
  try { n = Number(localStorage.getItem(LS_TRANSPORT_CODE) || '0') || 0; } catch {}
  n += 1;
  try { localStorage.setItem(LS_TRANSPORT_CODE, String(n)); } catch {}
  return `T${n}`;
}

function normPhone(p){ return String(p || '').replace(/\D+/g, ''); }
function normName(n){ return String(n || '').trim().replace(/\s+/g, ' '); }

export async function searchTransportClients(q) {
  const qq = String(q || '').trim();
  if (!qq) return [];
  const digits = normPhone(qq);
  const text = qq.toLowerCase();

  const baseQuery = supabase
    .from('transport_clients')
    .select('id, full_name, phone, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(15);

  const query = digits
    ? baseQuery.or(`phone.ilike.%${digits}%,full_name.ilike.%${text}%`)
    : baseQuery.or(`full_name.ilike.%${text}%,phone.ilike.%${text}%`);

  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function upsertTransportClient({ full_name, phone }) {
  const name = normName(full_name) || 'PA EMER';
  const ph = normPhone(phone);
  if (!ph) throw new Error('MUNGON_NUMRI');

  const actor = getActor();
  const now = new Date().toISOString();

  const { data: existing, error: e0 } = await supabase
    .from('transport_clients')
    .select('id, phone')
    .eq('phone', ph)
    .maybeSingle();

  if (e0 && String(e0.message || '').toLowerCase().includes('relation')) {
    const err = new Error('TRANSPORT_CLIENTS_TABLE_MISSING');
    err.code = 'TRANSPORT_CLIENTS_TABLE_MISSING';
    throw err;
  }
  if (e0) throw e0;

  if (existing?.id) {
    const { data: up, error } = await supabase
      .from('transport_clients')
      .update({
        full_name: name,
        updated_at: now,
        last_by_pin: actor?.pin || null,
        last_by_name: actor?.name || null,
      })
      .eq('id', existing.id)
      .select('id, full_name, phone')
      .single();
    if (error) throw error;
    return up;
  }

  const { data: ins, error } = await supabase
    .from('transport_clients')
    .insert({
      full_name: name,
      phone: ph,
      created_at: now,
      updated_at: now,
      created_by_pin: actor?.pin || null,
      created_by_name: actor?.name || null,
      last_by_pin: actor?.pin || null,
      last_by_name: actor?.name || null,
    })
    .select('id, full_name, phone')
    .single();
  if (error) throw error;
  return ins;
}

export async function insertTransportOrder({ code, client, address, gps, note, pay }) {
  const actor = getActor();
  const now = new Date().toISOString();

  const payload = {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    ts: Date.now(),
    status: 'pastrim',
    client: {
      name: normName(client?.full_name || client?.name || ''),
      phone: String(client?.phone || ''),
    },
    transport: {
      code: String(code || ''),
      pin: actor?.pin || null,
      name: actor?.name || null,
      address: String(address || ''),
      gps: gps || null,
    },
    pay: pay || null,
    notes: String(note || ''),
    _audit: {
      created_at: now,
      created_by_pin: actor?.pin || null,
      created_by_name: actor?.name || null,
      created_by_role: actor?.role || null,
      source: 'TRANSPORT_PRANIMI',
      last_at: now,
      last_by_name: actor?.name || null,
    }
  };

  const { data, error } = await supabase
    .from('orders')
    .insert({
      code: String(code || ''),
      status: 'pastrim',
      client_name: payload.client.name,
      client_phone: payload.client.phone,
      data: payload,
      total: Number(pay?.euro || 0) || 0,
      paid: Number(pay?.paid || 0) || 0,
    })
    .select('id, code, status, created_at')
    .single();

  if (error) throw error;
  return data;
}
