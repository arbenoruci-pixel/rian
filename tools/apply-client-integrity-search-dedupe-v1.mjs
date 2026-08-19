import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACKAGE_PATH = 'package.json';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const INSTALLER = 'node tools/apply-client-integrity-search-dedupe-v1.mjs';
const TEST_COMMAND = 'npm run test:client-integrity-search-dedupe-v1';
const MARKER = 'CLIENT_INTEGRITY_SEARCH_DEDUPE_V1';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-client-integrity-search-dedupe-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-client-integrity-search-dedupe-v1';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(?:jsx?|tsx?)$/i.test(entry.name)) out.push(abs);
  }
  return out;
}

function scanBalanced(source, start, openChar, closeChar, label) {
  if (source[start] !== openChar) throw new Error(`${label}_OPEN_MISSING`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1] || '';
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`${label}_UNTERMINATED`);
}

function findHomeSearchFile() {
  const candidates = walk(path.join(ROOT, 'app'))
    .concat(fs.existsSync(path.join(ROOT, 'src')) ? walk(path.join(ROOT, 'src')) : [])
    .filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return /K[ËE]RKO\s+POROSIN[ËE]/i.test(source)
        && /KRIJO\s+POROSI/i.test(source)
        && /TEPIHA\s*PRO/i.test(source);
    });
  if (candidates.length !== 1) {
    throw new Error(`HOME_SEARCH_FILE_NOT_UNIQUE:${candidates.map((x) => path.relative(ROOT, x)).join(',')}`);
  }
  return candidates[0];
}

function helperSource() {
  return `
// ${MARKER}: one business order may arrive from DB, IndexedDB and a cached snapshot.
// Render it once using stable DB/local identity. BASE order codes are unique order IDs;
// Transport T-codes are permanent client codes, so repeat visits remain separate by visit/order identity.
function dedupeHomeSearchRowsV1(inputRows = []) {
  const rows = Array.isArray(inputRows) ? inputRows.filter(Boolean) : [];
  const output = [];
  const aliasToIndex = new Map();

  const clean = (value) => String(value ?? '').trim();
  const upper = (value) => clean(value).toUpperCase();
  const phoneDigits = (value) => clean(value).replace(/\D/g, '');
  const numberOrEmpty = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '';
  };
  const readRaw = (row) => row?.fullOrder || row?.order || row?.raw || row?.data?.order || row || {};
  const readCode = (row, raw) => upper(
    row?.displayCode || row?.code_str || row?.code || row?.order_code || row?.transport_code_str ||
    raw?.code_str || raw?.transport_code_str || raw?.order_code || raw?.code || raw?.client?.code || ''
  ).replace(/^#/, '');
  const readSource = (row, raw, code) => {
    const explicit = upper(row?.source_module || row?.sourceModule || raw?.source_module || raw?.sourceModule || row?.type || raw?.type);
    if (explicit === 'TRANSPORT' || /^T\d+$/.test(code)) return 'TRANSPORT';
    return 'BASE';
  };
  const rowScore = (row) => {
    const raw = readRaw(row);
    let score = 0;
    if (numberOrEmpty(raw?.id || row?.id || row?.server_id || raw?.server_id)) score += 100;
    if (clean(raw?.local_oid || row?.local_oid || raw?.oid || row?.oid)) score += 60;
    if (clean(raw?.updated_at || row?.updated_at)) score += 12;
    if (clean(raw?.status || row?.status || raw?.state || row?.state)) score += 8;
    if (Array.isArray(raw?.tepiha || raw?.tepihaRows || row?.tepiha || row?.tepihaRows)) score += 5;
    if (clean(raw?.client_name || row?.client_name || raw?.name || row?.name)) score += 3;
    return score;
  };

  for (const row of rows) {
    const raw = readRaw(row);
    const code = readCode(row, raw);
    const source = readSource(row, raw, code);
    const dbId = numberOrEmpty(raw?.id || row?.id || row?.server_id || raw?.server_id || row?.order_id || raw?.order_id);
    const localOid = clean(raw?.local_oid || row?.local_oid || raw?.oid || row?.oid || raw?.data?.local_oid || row?.data?.local_oid);
    const visit = clean(raw?.visit_id || raw?.visit_nr || raw?.data?.visit_id || raw?.data?.visit_nr || row?.visit_id || row?.visit_nr);
    const created = clean(raw?.created_at || row?.created_at || raw?.ts || row?.ts);
    const phone = phoneDigits(raw?.client_phone || row?.client_phone || raw?.phone || row?.phone || raw?.client?.phone || row?.client?.phone);
    const aliases = [];

    if (dbId) aliases.push(`${source}:DB:${dbId}`);
    if (localOid) aliases.push(`${source}:OID:${localOid}`);
    if (source === 'BASE' && code && /^\d+$/.test(code)) aliases.push(`BASE:CODE:${Number(code)}`);
    if (source === 'TRANSPORT' && code && (visit || created || localOid || dbId)) {
      aliases.push(`TRANSPORT:VISIT:${code}:${visit || localOid || dbId || created}`);
    }
    if (!aliases.length) aliases.push(`${source}:FALLBACK:${code}:${phone}:${visit}:${created}`);

    let existingIndex = -1;
    for (const alias of aliases) {
      if (aliasToIndex.has(alias)) { existingIndex = aliasToIndex.get(alias); break; }
    }

    if (existingIndex < 0) {
      existingIndex = output.length;
      output.push(row);
    } else if (rowScore(row) > rowScore(output[existingIndex])) {
      output[existingIndex] = row;
    }
    for (const alias of aliases) aliasToIndex.set(alias, existingIndex);
  }
  return output;
}
`;
}

function patchHomeSearch() {
  const file = findHomeSearchFile();
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes(MARKER)) {
    const importMatches = [...source.matchAll(/^import[^;]+;\s*$/gm)];
    const insertAt = importMatches.length
      ? importMatches[importMatches.length - 1].index + importMatches[importMatches.length - 1][0].length
      : 0;
    source = `${source.slice(0, insertAt)}${helperSource()}${source.slice(insertAt)}`;
  }

  const searchMarkerMatch = source.match(/K[ËE]RKO\s+POROSIN[ËE]/i);
  if (!searchMarkerMatch) throw new Error('HOME_SEARCH_TITLE_MISSING_AFTER_HELPER');
  const markerIndex = searchMarkerMatch.index;
  const moduleMatch = source.slice(markerIndex).match(/ZGJEDH\s+MODULIN/i);
  const regionEnd = moduleMatch ? markerIndex + moduleMatch.index : Math.min(source.length, markerIndex + 45000);
  const region = source.slice(markerIndex, regionEnd);

  const mapMatches = [...region.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)map\s*\(/g)];
  const scored = new Map();
  for (const match of mapMatches) {
    const name = match[1];
    let score = (scored.get(name) || 0) + 1;
    if (/search|result|match|found|order|row|item/i.test(name)) score += 10;
    scored.set(name, score);
  }
  const selected = [...scored.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  if (!selected) throw new Error('HOME_SEARCH_RESULT_MAP_NOT_FOUND');

  const escaped = selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mapRegex = new RegExp(`\\b${escaped}\\s*(?:\\?\\.|\\.)map\\s*\\(`, 'g');
  const patchedRegion = region.replace(mapRegex, `dedupeHomeSearchRowsV1(${selected}).map(`);
  if (patchedRegion === region && !region.includes(`dedupeHomeSearchRowsV1(${selected}).map(`)) {
    throw new Error(`HOME_SEARCH_MAP_PATCH_FAILED:${selected}`);
  }
  source = source.slice(0, markerIndex) + patchedRegion + source.slice(regionEnd);

  if (!source.includes(MARKER) || !source.includes('dedupeHomeSearchRowsV1(')) {
    throw new Error('HOME_SEARCH_DEDUPE_VERIFICATION_FAILED');
  }
  fs.writeFileSync(file, source, 'utf8');
  return path.relative(ROOT, file);
}

function patchFinalVersionOwner() {
  let source = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  source = source
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);
  fs.writeFileSync(GATI_INSTALLER_PATH, source, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const gati = 'node tools/apply-gati-rack-save-v1.mjs';
  const pre = String(scripts.prebuild || '')
    .split('&&').map((x) => x.trim()).filter(Boolean)
    .filter((x) => x !== INSTALLER);
  const gatiIndex = pre.indexOf(gati);
  if (gatiIndex >= 0) pre.splice(gatiIndex, 0, INSTALLER);
  else pre.push(INSTALLER, gati);
  scripts.prebuild = pre.join(' && ');
  scripts['test:client-integrity-search-dedupe-v1'] = 'node tools/verify-client-integrity-search-dedupe-v1.mjs';
  let build = String(scripts.build || '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

const homeFile = patchHomeSearch();
patchFinalVersionOwner();
patchPackage();
console.log(`PASS ${MARKER}: dedupe installed in ${homeFile}; final version owner and build checks registered.`);
