const text = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function normalizeInventoryAuditCode(value) {
  const match = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^#/, '').match(/^(T)?#?(\d+)$/);
  if (!match) return '';
  return `${match[1] || ''}${match[2].replace(/^0+(?=\d)/, '')}`;
}

export function matchesInventoryAuditSearch(row, query, mode = 'code') {
  if (!String(query ?? '').trim()) return true;
  if (mode === 'code') {
    const code = normalizeInventoryAuditCode(query);
    if (!code) return false;
    const table = code.startsWith('T') ? 'transport_orders' : 'orders';
    // A carpet label identifies its exact code and source. Never fall back to
    // phone, rack, name, prefix or substring matches when that code is absent.
    return row.table === table && normalizeInventoryAuditCode(row.code) === code;
  }
  if (mode !== 'details') return false;
  const q = text(query);
  const fields = [row.name, row.phone, row.location].map(text);
  if (fields.some(field => q.split(/\s+/).every(word => field.includes(word)))) return true;
  // Separators in pasted phone numbers do not change the number being searched.
  if (/^[+\d\s().-]+$/.test(q)) {
    const digits = q.replace(/\D/g, '');
    return digits.length >= 4 && String(row.phone || '').replace(/\D/g, '').includes(digits);
  }
  return false;
}
