// The client code is the HOME search authority; a cached visit id can be old.
export async function fetchGatiExactTarget(target, listOrders) {
  const code = String(target?.openCode || '').trim().replace(/^0+/, '');
  const id = String(target?.openId || '').trim();
  const eq = /^\d+$/.test(code) ? { code: Number(code) }
    : /^\d+$/.test(id) && !code ? { id: Number(id) } : null;
  if (!eq) return { kind: 'missing', row: null };
  const rows = await listOrders('orders', {
    select: 'id,status,ready_at,picked_up_at,delivered_at,local_oid,created_at,updated_at,data,code,client_id,client_name,client_phone',
    eq, orderBy: 'updated_at', ascending: false, tieBreakBy: 'id', limit: 1, timeoutMs: 12000,
  });
  const row = rows?.[0] || null;
  return { kind: row ? 'found' : 'missing', row };
}
