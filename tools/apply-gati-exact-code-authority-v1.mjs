import fs from 'node:fs';

const gatiPath = 'app/gati/page.jsx';
const homePath = 'lib/homeSearch.js';

function fail(message) {
  console.error(`GATI_EXACT_CODE_AUTHORITY_V1_FAIL: ${message}`);
  process.exit(1);
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) fail(`${label}: source block missing`);
  if (source.indexOf(before, first + before.length) >= 0) fail(`${label}: source block is not unique`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function blockEnd(source, start) {
  const brace = source.indexOf('{', start);
  if (brace < 0) fail('if block opening brace missing');
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  fail('if block closing brace missing');
}

let gati = fs.readFileSync(gatiPath, 'utf8');
if (!gati.includes('GATI_EXACT_CODE_AUTHORITY_V1')) {
  gati = replaceOnce(
    gati,
    "  const exactMode = String(sp?.get('exact') || '') === '1';\n  const openId = String(sp?.get('openId') || '').trim();",
    "  const exactMode = String(sp?.get('exact') || '') === '1';\n  const openId = String(sp?.get('openId') || '').trim();\n  // GATI_EXACT_CODE_AUTHORITY_V1: HOME search may carry a stale visit id from cache.\n  // The permanent client code remains a safe fallback to the current GATI visit.\n  const openCode = String(sp?.get('openCode') || sp?.get('q') || '').trim();",
    'gati query params',
  );

  gati = replaceOnce(
    gati,
    "    if (exactMode && openId) {\n      return list.filter((o) => String(o?.id || '').trim() === openId || String(o?.dbId || '').trim() === openId);\n    }",
    "    if (exactMode && (openId || openCode)) {\n      const wantedId = String(openId || '').trim();\n      const wantedCode = normalizeCode(openCode || search || '');\n      return list.filter((o) => {\n        const rowId = String(o?.id || '').trim();\n        const rowDbId = String(o?.dbId || o?.db_id || '').trim();\n        const rowCode = normalizeCode(o?.code || o?.fullOrder?.code || o?.fullOrder?.client?.code || '');\n        const idMatch = !!wantedId && (rowId === wantedId || rowDbId === wantedId);\n        const codeMatch = !!wantedCode && rowCode === wantedCode;\n        return idMatch || codeMatch;\n      });\n    }",
    'gati exact filter',
  );

  gati = replaceOnce(
    gati,
    "  }, [orders, search, exactMode, openId]);",
    "  }, [orders, search, exactMode, openId, openCode]);",
    'gati filtered dependencies',
  );
}

let home = fs.readFileSync(homePath, 'utf8');
if (!home.includes('HOME_SEARCH_TYPED_BASE_CODE_AUTHORITY_V1')) {
  const idNeedle = "    if (kind === 'BASE' && id && /^\\d+$/.test(id)) {";
  const codeNeedle = "    if (!row && kind === 'BASE' && queryBaseCode) {";
  const idStart = home.indexOf(idNeedle);
  const codeStart = home.indexOf(codeNeedle, idStart + 1);
  if (idStart < 0 || codeStart < 0) fail('home BASE resolver blocks missing');
  const idEnd = blockEnd(home, idStart);
  const codeEnd = blockEnd(home, codeStart);
  if (idEnd >= codeStart) fail('home resolver block order unexpected');

  const idBlock = home.slice(idStart, idEnd)
    .replace(
      "    if (kind === 'BASE' && id && /^\\d+$/.test(id)) {",
      "    if (!row && kind === 'BASE' && id && /^\\d+$/.test(id)) {",
    );
  const codeBlock = home.slice(codeStart, codeEnd)
    .replace(
      "    if (!row && kind === 'BASE' && queryBaseCode) {",
      "    // HOME_SEARCH_TYPED_BASE_CODE_AUTHORITY_V1: a numeric query is the permanent client-code authority.\n    // Resolve the newest visit for that code before trusting a possibly stale cached visit id.\n    if (kind === 'BASE' && queryBaseCode) {",
    );
  const between = home.slice(idEnd, codeStart);
  home = home.slice(0, idStart) + codeBlock + between + idBlock + home.slice(codeEnd);
}

if (!gati.includes('const openCode = String(sp?.get(\'openCode\') || sp?.get(\'q\') || \'\').trim();')) fail('gati openCode marker missing after patch');
if (!gati.includes('const codeMatch = !!wantedCode && rowCode === wantedCode;')) fail('gati code exact match missing after patch');
if (!home.includes('HOME_SEARCH_TYPED_BASE_CODE_AUTHORITY_V1')) fail('home typed code authority marker missing after patch');

fs.writeFileSync(gatiPath, gati);
fs.writeFileSync(homePath, home);
console.log('GATI_EXACT_CODE_AUTHORITY_V1_OK');
