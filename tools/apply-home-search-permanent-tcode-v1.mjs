import fs from 'node:fs';

const targetPath = 'lib/homeSearch.js';
const marker = 'HOME_SEARCH_PERMANENT_TCODE_V1';
const finalBoundaryMarker = 'HOME_SEARCH_BASE_ROLE_BOUNDARY_V1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) {
    console.log(`SKIP ${label}: already patched`);
    return source;
  }

  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected one match, found ${count}`);
  }

  console.log(`PATCH ${label}`);
  return source.replace(oldText, newText);
}

let source = fs.readFileSync(targetPath, 'utf8');

// The final BASE/Transport role boundary supersedes this legacy code-shape
// installer while preserving permanent T-code matching for genuine transport rows.
// During a full prebuild the final installer may already have run once (for example
// in a verification workflow), so this older installer must never overwrite it.
if (source.includes(finalBoundaryMarker)) {
  console.log('SKIP home search permanent T-code V1: superseded by final BASE/Transport role boundary V1');
  process.exit(0);
}

const oldPickCode = `function pickCode(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_tcode,
    row?.transport_code,
    row?.t_code,
    row?.code_str,
    row?.code,
    row?.code_n,
    row?.client_code,
    data?.client_tcode,
    data?.transport_code,
    data?.t_code,
    data?.code_str,
    data?.code,
    data?.code_n,
    data?.client_code
  );
}`;

const newPickCode = `function collectTransportCodes(row) {
  // ${marker}
  const data = unwrapData(row);
  const candidates = [
    row?.client_tcode,
    data?.transport_client_tcode,
    data?.client_tcode,
    data?.client?.transport_client_tcode,
    data?.client?.tcode,
    row?.transport_code,
    row?.t_code,
    row?.code_str,
    data?.official_order_code,
    data?.order_code,
    data?.order_tcode,
    data?.transport_code,
    data?.t_code,
    data?.code_str,
    data?.code,
    row?.code,
    row?.code_n ? \`T\${row.code_n}\` : '',
    data?.code_n ? \`T\${data.code_n}\` : '',
  ];

  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const code = normalizeTransportCodeStrict(candidate);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function pickCode(row) {
  const data = unwrapData(row);
  const transportCodes = collectTransportCodes(row);
  if (transportCodes.length) return transportCodes[0];
  return pickFirst(
    row?.code,
    row?.code_n,
    row?.client_code,
    data?.code,
    data?.code_n,
    data?.client_code
  );
}`;

source = replaceOnce(source, oldPickCode, newPickCode, 'canonical transport T-code selection');

const oldNormalizeHeader = `function normalizeResult(row, options = {}) {
  const kind = getKind(row);
  const data = unwrapData(row);
  const rawCode = pickCode(row);
  const code = kind === 'TRANSPORT' ? normalizeCode(rawCode) : safeString(rawCode).replace(/^#+/, '');`;

const newNormalizeHeader = `function normalizeResult(row, options = {}) {
  const kind = getKind(row);
  const data = unwrapData(row);
  const transportCodes = kind === 'TRANSPORT' ? collectTransportCodes(row) : [];
  const rawCode = transportCodes[0] || pickCode(row);
  const code = kind === 'TRANSPORT' ? normalizeCode(rawCode) : safeString(rawCode).replace(/^#+/, '');`;

source = replaceOnce(source, oldNormalizeHeader, newNormalizeHeader, 'normalize canonical transport code');

source = replaceOnce(
  source,
  `    code,
    clientCode: kind === 'BASE' ? code : null,`,
  `    code,
    codeAliases: kind === 'TRANSPORT' ? transportCodes.filter((candidate) => candidate !== code) : [],
    clientCode: kind === 'BASE' ? code : null,`,
  'retain legacy transport code aliases',
);

source = replaceOnce(
  source,
  `  const code = normalizeCode(result.code);
  const orderIdDigits = kind === 'BASE' ? normalizeNumericCode(result.orderId || result.id) : '';`,
  `  const code = normalizeCode(result.code);
  const transportCodes = kind === 'TRANSPORT'
    ? Array.from(new Set([result.code, ...(Array.isArray(result.codeAliases) ? result.codeAliases : [])]
        .map((value) => normalizeTransportCodeStrict(value))
        .filter(Boolean)))
    : [];
  const orderIdDigits = kind === 'BASE' ? normalizeNumericCode(result.orderId || result.id) : '';`,
  'prepare canonical and legacy T-code matching',
);

source = replaceOnce(
  source,
  `  if (mode === 'TRANSPORT_ONLY') {
    if (kind !== 'TRANSPORT') return false;
    const wanted = normalizeTransportCodeStrict(qCode);
    const actual = normalizeTransportCodeStrict(code);
    return !!wanted && !!actual && actual === wanted;
  }`,
  `  if (mode === 'TRANSPORT_ONLY') {
    if (kind !== 'TRANSPORT') return false;
    const wanted = normalizeTransportCodeStrict(qCode);
    return !!wanted && transportCodes.includes(wanted);
  }`,
  'match exact searches by permanent code or legacy alias',
);

source = replaceOnce(
  source,
  `function dedupeResults(results) {
  const order = [];
  const bestByKey = new Map();

  for (const item of results) {
    const key = getHomeDedupeKey(item);`,
  `function dedupeResults(results, options = {}) {
  const order = [];
  const bestByKey = new Map();
  const collapseTransportByCode = options?.collapseTransportByCode === true;

  for (const item of results) {
    const kind = String(item?.kind || '').toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
    const strictTransportCode = kind === 'TRANSPORT' ? normalizeTransportCodeStrict(item?.code) : '';
    const key = collapseTransportByCode && strictTransportCode
      ? ['TRANSPORT', 'CODE', strictTransportCode].join('|')
      : getHomeDedupeKey(item);`,
  'collapse exact transport search to the strongest current visit',
);

source = replaceOnce(
  source,
  `.select('id,code_n,code_str,client_name,client_phone,status,data,created_at,updated_at')
          .eq('code_n', codeNumber)
          .limit(10);`,
  `.select('id,code_n,code_str,client_tcode,visit_nr,client_name,client_phone,status,ready_at,data,created_at,updated_at')
          .eq('code_n', codeNumber)
          .order('updated_at', { ascending: false })
          .limit(20);`,
  'load permanent T-code identity in exact DB search',
);

source = replaceOnce(
  source,
  `  const results = dedupeResults(matches);`,
  `  const results = dedupeResults(matches, { collapseTransportByCode: mode === 'TRANSPORT_ONLY' });`,
  'dedupe exact T-code results by permanent code',
);

fs.writeFileSync(targetPath, source, 'utf8');

const after = fs.readFileSync(targetPath, 'utf8');
const required = [
  marker,
  'function collectTransportCodes(row)',
  'data?.transport_client_tcode',
  'codeAliases:',
  'transportCodes.includes(wanted)',
  "collapseTransportByCode: mode === 'TRANSPORT_ONLY'",
  'id,code_n,code_str,client_tcode,visit_nr,client_name,client_phone,status,ready_at,data,created_at,updated_at',
];

for (const token of required) {
  if (!after.includes(token)) throw new Error(`home search permanent T-code patch missing: ${token}`);
}

if (after.includes(".select('id,code_n,code_str,client_name,client_phone,status,data,created_at,updated_at')")) {
  throw new Error('exact transport search still omits client_tcode');
}

console.log('PASS home search shows the permanent T-code while legacy visit aliases remain searchable');
