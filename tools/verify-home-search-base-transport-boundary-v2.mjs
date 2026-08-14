import fs from 'node:fs';

const src = fs.readFileSync('lib/homeSearch.js', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(src.includes('HOME_SEARCH_BASE_TRANSPORT_BOUNDARY_V2'), 'boundary marker missing');
check(src.includes("const numericBaseCode = /^\\d+$/.test(code.replace(/^#+/, '').trim());"), 'plain numeric BASE guard missing');
check(src.includes("const transportId = looksUuid(id) ? id : '';"), 'transport UUID guard missing');
check(src.includes("if (id && (kind === 'BASE' || looksUuid(id)))"), 'resolver UUID guard missing');
check(src.includes("kind === 'TRANSPORT' && strictTransportCode"), 'transport T-code guard missing');

function looksUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}
function normalizeCode(value) {
  const raw = String(value || '').trim().replace(/^#+/, '').replace(/[\s\-_/]+/g, '').toUpperCase();
  const digits = raw.replace(/^T+/, '').replace(/\D+/g, '');
  if (/^T/i.test(raw) && digits) return `T${digits}`;
  return raw;
}
function strictTransportCode(value) {
  const m = normalizeCode(value).match(/^T0*(\d+)$/i);
  return m ? `T${String(m[1] || '0').replace(/^0+/, '') || '0'}` : '';
}
function classify(result) {
  const claimed = String(result?.kind || '').toUpperCase();
  const code = String(result?.code || '').trim();
  const id = String(result?.orderId ?? result?.id ?? '').trim();
  const numericBase = /^\d+$/.test(code.replace(/^#+/, '').trim());
  const tCode = strictTransportCode(code);
  const kind = numericBase ? 'BASE' : (claimed === 'TRANSPORT' && (looksUuid(id) || tCode) ? 'TRANSPORT' : 'BASE');
  return { kind, tCode, transportId: looksUuid(id) ? id : '' };
}

const base915 = classify({ kind: 'TRANSPORT', code: '915', id: '2954', status: 'gati' });
check(base915.kind === 'BASE', '#915 with numeric DB id must stay BASE even if stale cache says TRANSPORT');
check(!base915.transportId, '#915 numeric id must never become transport UUID');

const transport915 = classify({ kind: 'TRANSPORT', code: 'T915', id: '0790f1b1-c732-4356-95e4-6db6c375ce89' });
check(transport915.kind === 'TRANSPORT', 'T915 with UUID must stay TRANSPORT');
check(transport915.tCode === 'T915', 'T915 strict code normalization failed');

const staleTransportNumericId = classify({ kind: 'TRANSPORT', code: 'T915', id: '2954' });
check(staleTransportNumericId.kind === 'TRANSPORT', 'explicit T915 remains transport');
check(!staleTransportNumericId.transportId, 'numeric id must be ignored for transport routing');

if (failures.length) {
  console.error(`FAIL: ${failures.length} home search boundary check(s) failed`);
  failures.forEach((f, i) => console.error(`${i + 1}. ${f}`));
  process.exit(1);
}
console.log('PASS: numeric BASE #915 and T915 are separated safely.');
