export const CONTROL_BUCKET = 'transport-control-evidence';
export const CONTROL_BONUS = 0.50;
export const CONTROL_MAX_PHOTOS = 6;
export const CONTROL_MAX_BYTES = 2 * 1024 * 1024;
export const roundMoney = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const controlStatusLabel = s => ({ DRAFT: 'Vazhdo kontrollin', PENDING: 'Në aprovim', RETURNED: 'Plotëso provat', APPROVED: 'U aprovua' })[s] || 'Për kontroll';
export function measurementSnapshot(data = {}) {
  return {
    tepiha: data.tepiha || data.tepihaRows || [], staza: data.staza || data.stazaRows || [],
    shkallore: data.shkallore || { qty: 0, per: 0.3 },
    rate: Number(data.pay?.rate ?? 1.8),
    pay_m2: data.pay?.m2 == null ? null : Number(data.pay.m2), pay_euro: data.pay?.euro == null ? null : Number(data.pay.euro),
    totals: Object.fromEntries(['pieces','cope','m2','m2_total','totalM2','total_m2','total','totalEuro','total_eur','price_total'].map(k=>[k,data[k]??null])),
  };
}
export function controlRows(data = {}) {
  const m = measurementSnapshot(data), rows = [];
  for (const kind of ['tepiha', 'staza']) for (const [i, r] of m[kind].entries()) {
    rows.push({ id: String(r.id || `${kind}-${i}`), kind, qty: Number(r.qty ?? r.pieces ?? 1), m2: Number(r.m2 ?? (Number(r.length || r.len || 0) * Number(r.width || 0))) });
  }
  if (Number(m.shkallore.qty) > 0) rows.push({ id: 'shkallore', kind: 'shkallore', qty: Number(m.shkallore.qty), m2: Number(m.shkallore.per || 0.3) });
  return rows;
}
export function controlTotals(rows, rate = 1.8) {
  const pieces = rows.reduce((s,r) => s + Number(r.qty || 0), 0);
  const m2 = roundMoney(rows.reduce((s,r) => s + Number(r.qty || 0) * Number(r.m2 || 0), 0));
  return { pieces, m2, euro: roundMoney(m2 * rate) };
}
export function validateControlRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new Error('CONTROL_ITEMS_REQUIRED');
  const clean = rows.map(r => {
    const qty = Number(r.qty), m2 = Number(r.m2);
    if (!['tepiha','staza','shkallore'].includes(r.kind) || !Number.isInteger(qty) || qty < 1 || qty > 100 || !Number.isFinite(m2) || m2 <= 0 || m2 > 500) throw new Error('CONTROL_MEASUREMENTS_INVALID');
    return { id: String(r.id || '').slice(0,80), kind:r.kind, qty, m2:roundMoney(m2) };
  });
  if (clean.filter(r=>r.kind==='shkallore').length > 1 || new Set(clean.map(r=>r.id)).size !== clean.length || clean.some(r=>!r.id)) throw new Error('CONTROL_MEASUREMENTS_INVALID');
  return clean;
}
export function rowsChanged(before, after) {
  const normalize = rows => rows.map(r=>[r.kind,Number(r.qty),Number(r.m2)]);
  return JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after));
}
