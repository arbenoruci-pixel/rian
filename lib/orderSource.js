export function normalizeOrderTable(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'transport_orders' || v === 'transport') return 'transport_orders';
  if (v === 'orders' || v === 'base') return 'orders';
  return '';
}

export function getOrderTable(row) {
  return normalizeOrderTable(row?._table || row?.table || row?.source || row?.__src || row?.order_table);
}

export function isTransportOrder(row) {
  return getOrderTable(row) === 'transport_orders';
}

export function isBaseOrder(row) {
  return getOrderTable(row) === 'orders';
}

export function withOrderTable(row, table) {
  const t = normalizeOrderTable(table);
  return { ...(row || {}), _table: t || row?._table || '' };
}
