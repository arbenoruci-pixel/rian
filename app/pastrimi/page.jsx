function saveOrderLocal(order) {
  if (typeof window === 'undefined') return;
  const { id } = order;
  localStorage.setItem(`order_${id}`, JSON.stringify(order));

  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  const pieces = computePieces(order);
  const m2 = computeM2(order);
  const total = computeTotalEuro(order);

  const entry = {
    id,
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    code: order.client?.code || '',
    pieces,
    m2,
    total,
    queued: !!order.queued,
    status: order.status || 'pastrim',   // <<< E RE
    ts: order.ts || Date.now(),
  };

  const idx = list.findIndex((o) => o.id === id);
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);

  list = list.slice(0, 200);
  localStorage.setItem('order_list_v1', JSON.stringify(list));
}