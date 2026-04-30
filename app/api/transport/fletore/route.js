import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdminClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function jparse(value, fallback = {}) {
  try {
    if (value && typeof value === 'object') return value;
    if (value == null || value === '') return fallback;
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normPhone(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizeName(value) {
  return String(value || '').trim();
}

function orderData(row) {
  return asObject(jparse(row?.data, {}));
}

function pickClientCode(row, data) {
  const client = asObject(data?.client);
  return String(
    row?.client_tcode ||
    row?.code_str ||
    client?.tcode ||
    client?.code ||
    row?.code ||
    ''
  ).trim();
}

function pickClientName(row, data, clientRow) {
  const client = asObject(data?.client);
  return normalizeName(
    row?.client_name ||
    clientRow?.name ||
    clientRow?.full_name ||
    client?.name ||
    client?.full_name ||
    row?.name ||
    '-'
  );
}

function pickClientPhone(row, data, clientRow) {
  const client = asObject(data?.client);
  return String(
    row?.client_phone ||
    clientRow?.phone ||
    client?.phone ||
    ''
  ).trim();
}

function extractClientKeys(row, data) {
  const client = asObject(data?.client);
  const keys = new Set();
  const tcode = String(row?.client_tcode || client?.tcode || client?.code || '').trim();
  const id = String(row?.client_id || client?.id || '').trim();
  const phone = normPhone(row?.client_phone || client?.phone || '');
  if (tcode) keys.add(`tcode:${tcode.toUpperCase()}`);
  if (id) keys.add(`id:${id}`);
  if (phone) keys.add(`phone:${phone}`);
  return Array.from(keys);
}

async function readUsers(sb) {
  const attempts = [
    () => sb.from('users').select('id,name,pin,role').order('name', { ascending: true }).limit(5000),
    () => sb.from('tepiha_users').select('id,name,pin,role').order('name', { ascending: true }).limit(5000),
  ];
  for (const run of attempts) {
    try {
      const res = await run();
      if (!res?.error) return Array.isArray(res?.data) ? res.data : [];
    } catch {}
  }
  return [];
}

export async function GET(req) {
  try {
    const sb = getSupabaseAdmin();
    if (!sb) {
      return NextResponse.json({ ok: false, error: 'SUPABASE_ADMIN_MISSING' }, { status: 500 });
    }

    const url = new URL(req.url);
    const transportId = String(url.searchParams.get('transport_id') || '').trim();
    const includeAll = String(url.searchParams.get('all') || '').trim() === '1';

    let ordersQ = sb
      .from('transport_orders')
      .select('id,created_at,updated_at,code_str,client_id,client_tcode,client_name,client_phone,status,data,transport_id,visit_nr,ready_at')
      .order('created_at', { ascending: false })
      .limit(5000);

    if (transportId && !includeAll) {
      ordersQ = ordersQ.eq('transport_id', transportId);
    }

    const [ordersRes, clientsRes, users] = await Promise.all([
      ordersQ,
      sb.from('transport_clients').select('*').order('created_at', { ascending: true }).limit(5000),
      readUsers(sb),
    ]);

    if (ordersRes?.error) throw ordersRes.error;

    const rawOrders = Array.isArray(ordersRes?.data) ? ordersRes.data : [];
    const rawClients = clientsRes?.error ? [] : (Array.isArray(clientsRes?.data) ? clientsRes.data : []);

    const usersById = new Map((users || []).map((u) => [String(u?.id || '').trim(), u]));

    const clientLookup = new Map();
    for (const row of rawClients) {
      const keys = new Set();
      const tcode = String(row?.tcode || row?.code || '').trim();
      const id = String(row?.id || '').trim();
      const phone = normPhone(row?.phone);
      if (tcode) keys.add(`tcode:${tcode.toUpperCase()}`);
      if (id) keys.add(`id:${id}`);
      if (phone) keys.add(`phone:${phone}`);
      for (const key of keys) clientLookup.set(key, row);
    }

    const normalizedOrders = rawOrders.map((row) => {
      const data = orderData(row);
      const keys = extractClientKeys(row, data);
      const clientRow = keys.map((key) => clientLookup.get(key)).find(Boolean) || null;
      const transportKey = String(row?.transport_id || '').trim();
      const transportUser = usersById.get(transportKey) || null;
      const code = pickClientCode(row, data);
      return {
        ...row,
        code,
        client_name: pickClientName(row, data, clientRow),
        client_phone: pickClientPhone(row, data, clientRow),
        transport_name: normalizeName(transportUser?.name || data?.transport_name || row?.transport_name || transportKey || 'PA CAKTUAR'),
        data,
      };
    });

    const transportMap = new Map();
    for (const order of normalizedOrders) {
      const tid = String(order?.transport_id || '').trim() || 'unassigned';
      const current = transportMap.get(tid) || {
        id: tid,
        name: normalizeName(order?.transport_name || usersById.get(tid)?.name || (tid === 'unassigned' ? 'PA CAKTUAR' : tid)),
        orders: [],
      };
      current.orders.push(order);
      transportMap.set(tid, current);
    }

    const transports = Array.from(transportMap.values())
      .map((group) => {
        const seen = new Set();
        const clients = [];
        for (const order of group.orders) {
          const key = `${String(order?.code || '').trim()}|${normPhone(order?.client_phone)}`;
          if (!String(order?.code || '').trim() && !normPhone(order?.client_phone)) continue;
          if (seen.has(key)) continue;
          seen.add(key);
          clients.push({
            code: String(order?.code || '').trim(),
            full_name: normalizeName(order?.client_name || '-'),
            phone: String(order?.client_phone || '-').trim() || '-',
          });
        }
        group.orders.sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
        clients.sort((a, b) => String(a?.code || '').localeCompare(String(b?.code || ''), undefined, { numeric: true, sensitivity: 'base' }));
        return { ...group, clients };
      })
      .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' }));

    const selected = transportId && !includeAll
      ? transports.filter((t) => String(t?.id || '') === transportId)
      : transports;

    return NextResponse.json({
      ok: true,
      generated_at: new Date().toISOString(),
      clients_warning: !!clientsRes?.error,
      clients_warning_message: clientsRes?.error ? String(clientsRes.error.message || clientsRes.error) : '',
      transports: selected,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: 'TRANSPORT_FLETORE_FAILED', detail: String(error?.message || error) }, { status: 500 });
  }
}
