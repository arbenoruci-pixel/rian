import fs from 'node:fs';

const PATH = 'lib/homeSearch.js';
const MARKER = 'HOME_SEARCH_BASE_TRANSPORT_BOUNDARY_V2';
let src = fs.readFileSync(PATH, 'utf8');
if (src.includes(MARKER)) {
  console.log('[home-search-base-transport-boundary-v2] already installed');
  process.exit(0);
}

function replaceOnce(oldText, newText, label) {
  const count = src.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  src = src.replace(oldText, newText);
  console.log(`PATCH ${label}`);
}

replaceOnce(
`export function buildHomeSearchHref(result) {
  const kind = safeString(result?.kind).toUpperCase();
  const code = safeString(result?.code);
  const id = result?.orderId != null ? safeString(result.orderId) : (result?.id != null ? safeString(result.id) : '');
  const status = normalizeText(result?.status);
  if (kind === 'TRANSPORT') {
    if (id) return \`/transport/item?id=\${encodeURIComponent(id)}&src=transport&from=home_inline_search\`;
    if (code) return \`/transport/item?code=\${encodeURIComponent(normalizeCode(code))}&from=home_inline_search\`;
    return '/transport';
  }`,
`export function buildHomeSearchHref(result) {
  // ${MARKER}
  // A plain numeric code (e.g. 915) is always a BASE order. Transport requires
  // an explicit T-code or a UUID transport id. Never send a numeric BASE id to
  // /transport/item because Postgres transport ids are UUIDs.
  const claimedKind = safeString(result?.kind).toUpperCase();
  const code = safeString(result?.code);
  const id = result?.orderId != null ? safeString(result.orderId) : (result?.id != null ? safeString(result.id) : '');
  const normalizedCode = normalizeCode(code);
  const strictTransportCode = normalizeTransportCodeStrict(normalizedCode);
  const transportId = looksUuid(id) ? id : '';
  const numericBaseCode = /^\\d+$/.test(code.replace(/^#+/, '').trim());
  const kind = numericBaseCode
    ? 'BASE'
    : (claimedKind === 'TRANSPORT' && (transportId || strictTransportCode) ? 'TRANSPORT' : 'BASE');
  const status = normalizeText(result?.status);
  if (kind === 'TRANSPORT') {
    if (transportId) return \`/transport/item?id=\${encodeURIComponent(transportId)}&src=transport&from=home_inline_search\`;
    if (strictTransportCode) return \`/transport/item?code=\${encodeURIComponent(strictTransportCode)}&from=home_inline_search\`;
    return '/transport';
  }`,
'build href transport boundary'
);

replaceOnce(
`  const kind = safeString(result?.kind).toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  const table = kind === 'TRANSPORT' ? 'transport_orders' : 'orders';
  const id = safeString(result?.orderId || result?.id);
  const localOid = safeString(result?.localOid || result?.local_oid);
  const code = safeString(result?.code);`,
`  const claimedKind = safeString(result?.kind).toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  const id = safeString(result?.orderId || result?.id);
  const localOid = safeString(result?.localOid || result?.local_oid);
  const code = safeString(result?.code);
  const normalizedCode = normalizeCode(code);
  const strictTransportCode = normalizeTransportCodeStrict(normalizedCode);
  const numericBaseCode = /^\\d+$/.test(code.replace(/^#+/, '').trim());
  const kind = numericBaseCode
    ? 'BASE'
    : (claimedKind === 'TRANSPORT' && (looksUuid(id) || strictTransportCode) ? 'TRANSPORT' : 'BASE');
  const table = kind === 'TRANSPORT' ? 'transport_orders' : 'orders';`,
'live resolver transport boundary'
);

replaceOnce(
`    if (id) {
      const byId = await supabase.from(table).select('*').eq('id', id).limit(1).maybeSingle();
      if (!byId?.error && byId?.data) row = byId.data;
    }`,
`    if (id && (kind === 'BASE' || looksUuid(id))) {
      const byId = await supabase.from(table).select('*').eq('id', kind === 'BASE' && /^\\d+$/.test(id) ? Number(id) : id).limit(1).maybeSingle();
      if (!byId?.error && byId?.data) row = byId.data;
    }`,
'never query transport uuid with numeric base id'
);

replaceOnce(
`      } else if (kind === 'TRANSPORT') {
        const codeNumber = Number(normalizeCode(code).replace(/\\D+/g, ''));
        if (Number.isFinite(codeNumber)) {
          const byCode = await supabase.from('transport_orders').select('*').eq('code_n', codeNumber).order('updated_at', { ascending: false }).limit(1).maybeSingle();`,
`      } else if (kind === 'TRANSPORT' && strictTransportCode) {
        const codeNumber = Number(strictTransportCode.replace(/\\D+/g, ''));
        if (Number.isFinite(codeNumber)) {
          const byCode = await supabase.from('transport_orders').select('*').eq('code_n', codeNumber).order('updated_at', { ascending: false }).limit(1).maybeSingle();`,
'only resolve transport by explicit T-code'
);

fs.writeFileSync(PATH, src, 'utf8');
const out = fs.readFileSync(PATH, 'utf8');
for (const token of [
  MARKER,
  "const numericBaseCode = /^\\d+$/.test(code.replace(/^#+/, '').trim());",
  "if (transportId) return `/transport/item?id=${encodeURIComponent(transportId)}&src=transport&from=home_inline_search`;",
  "if (id && (kind === 'BASE' || looksUuid(id)))",
  "kind === 'TRANSPORT' && strictTransportCode",
]) {
  if (!out.includes(token)) throw new Error(`VERIFY_MISSING:${token}`);
}
console.log('PASS Home Search keeps numeric BASE orders out of Transport routes');
