import fs from 'node:fs';

const SEARCH_PATH = 'lib/homeSearch.js';
const HOME_PATH = 'app/page.jsx';
const PACKAGE_PATH = 'package.json';
const ARKA_INSTALLER_PATH = 'tools/apply-arka-daily-close-v2.mjs';
const ARKA_VERIFY_PATH = 'tools/verify-arka-daily-close-v2.mjs';
const MARKER = 'HOME_SEARCH_BASE_ROLE_BOUNDARY_V1';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1';

function scanBalanced(source, start, openChar, closeChar, label) {
  if (source[start] !== openChar) throw new Error(`${label}_OPEN_MISSING`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`${label}_UNTERMINATED`);
}

function replaceNamedFunction(source, signature, replacement, searchStart = 0) {
  const start = source.indexOf(signature, searchStart);
  if (start < 0) throw new Error(`FUNCTION_NOT_FOUND:${signature}`);
  const paramsStart = source.indexOf('(', start);
  const paramsEnd = scanBalanced(source, paramsStart, '(', ')', `${signature}_PARAMS`);
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart] || '')) bodyStart += 1;
  const bodyEnd = scanBalanced(source, bodyStart, '{', '}', `${signature}_BODY`);
  return source.slice(0, start) + replacement + source.slice(bodyEnd + 1);
}

function patchSearchRuntime() {
  let source = fs.readFileSync(SEARCH_PATH, 'utf8');
  if (!source.includes(MARKER)) {
    source = replaceNamedFunction(source, 'function pickOrderId(row)', `function pickOrderId(row) {
  const data = unwrapData(row);
  const numericRowId = /^\\d+$/.test(safeString(row?.id)) ? row?.id : '';
  const numericDataId = /^\\d+$/.test(safeString(data?.id)) ? data?.id : '';
  return pickFirst(
    row?.db_id,
    data?.db_id,
    row?.order_id,
    row?.orderId,
    numericRowId,
    data?.order_id,
    data?.orderId,
    numericDataId,
    row?.id,
    data?.id
  );
}

function normalizeBaseCode(value) {
  const raw = safeString(value).replace(/^#+/, '').replace(/[\\s\-_/]+/g, '').toUpperCase();
  const transportAlias = raw.match(/^T0*(\\d+)$/i);
  if (transportAlias) return String(transportAlias[1] || '0').replace(/^0+/, '') || '0';
  if (/^\\d+$/.test(raw)) return raw.replace(/^0+/, '') || '0';
  return raw;
}

function pickBaseCode(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.code,
    row?.client_code,
    row?.saved_order_code,
    row?.final_code_lifecycle,
    data?.saved_order_code,
    data?.final_code_lifecycle,
    data?.pranimi_code_lifecycle?.final_code,
    data?.pranimi_code_lifecycle?.saved_order_code,
    data?.code,
    data?.client_code,
    row?.code_n,
    data?.code_n,
    pickCode(row)
  );
}

function pickTransportCode(row) {
  const data = unwrapData(row);
  return pickFirst(
    row?.client_tcode,
    row?.code_str,
    row?.transport_code,
    row?.t_code,
    data?.client_tcode,
    data?.code_str,
    data?.transport_code,
    data?.t_code,
    row?.code,
    row?.code_n,
    data?.code,
    data?.code_n
  );
}

function hasStrongBaseIdentity(row) {
  const data = unwrapData(row);
  const table = safeString(row?._table || row?.table || row?.source_table).toLowerCase();
  if (table === 'orders') return true;
  if (/^\\d+$/.test(safeString(row?.id))) return true;
  if (/^\\d+$/.test(safeString(row?.db_id || data?.db_id))) return true;
  if (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') return true;
  if (data?.draft_lifecycle && typeof data.draft_lifecycle === 'object') return true;
  if (data?.base_ready_bonus_v2 && typeof data.base_ready_bonus_v2 === 'object') return true;
  if (safeString(data?.saved_order_code) && safeString(data?.local_oid)) return true;
  return false;
}

function hasStrongTransportIdentity(row) {
  const data = unwrapData(row);
  const id = pickFirst(row?.id, data?.public_order_id, data?.order_id);
  const strictCode = normalizeTransportCodeStrict(pickTransportCode(row));
  const explicitTransportRef = pickFirst(
    row?.transport_id,
    row?.transport_pin,
    row?.driver_pin,
    data?.transport_id,
    data?.transport_pin,
    data?.driver_pin,
    data?.transport_user_id,
    data?.assigned_driver_id
  );
  return !!strictCode && (!!explicitTransportRef || looksUuid(id));
}

function getKind(row) {
  // ${MARKER}: DB/source identity and BASE lifecycle win over stale T-prefix cache aliases.
  const table = safeString(row?._table || row?.table || row?.source_table).toLowerCase();
  if (hasStrongBaseIdentity(row)) return 'BASE';
  if (table === 'transport_orders' || table === 'transport') return 'TRANSPORT';
  if (hasStrongTransportIdentity(row)) return 'TRANSPORT';
  const code = normalizeTransportCodeStrict(pickTransportCode(row));
  if (code) return 'TRANSPORT';
  return 'BASE';
}`);

    const firstKindStart = source.indexOf('function getKind(row)');
    const duplicateKindStart = source.indexOf('function getKind(row)', firstKindStart + 1);
    if (duplicateKindStart >= 0) {
      source = replaceNamedFunction(source, 'function getKind(row)', '', duplicateKindStart);
    }

    source = replaceNamedFunction(source, 'function pickTransporter(row)', `function pickTransporter(row) {
  const data = unwrapData(row);
  return pickFirstVisiblePerson(
    row?.brought_by_name,
    row?.transport_name,
    row?.driver_name,
    row?.transporter_name,
    row?.brought_by,
    row?.created_by_name,
    row?.actor,
    data?.brought_by_name,
    data?.transport_name,
    data?.driver_name,
    data?.transporter_name,
    data?.brought_by,
    data?.created_by_name,
    data?.actor,
    data?._audit?.created_by_name,
    data?.transport?.brought_by_name,
    data?.transport?.name,
    data?.transport?.driver_name,
    data?.transport?.driverName,
    data?.transport?.assigned_driver_name,
    data?.transport?.brought_by
  );
}

function pickExplicitBaseTransporter(row) {
  const data = unwrapData(row);
  const role = safeString(pickFirst(
    row?.transport_role,
    row?.driver_role,
    data?.transport_role,
    data?.driver_role,
    data?.created_by_role
  )).toUpperCase();
  const explicitRef = pickFirst(
    row?.transport_pin,
    row?.driver_pin,
    row?.transport_id,
    data?.transport_pin,
    data?.driver_pin,
    data?.transport_id,
    data?.transport_user_id,
    data?.assigned_driver_id
  );
  const explicitName = pickFirstVisiblePerson(
    row?.brought_by_name,
    row?.transport_name,
    row?.driver_name,
    row?.transporter_name,
    data?.brought_by_name,
    data?.transport_name,
    data?.driver_name,
    data?.transporter_name,
    data?.transport?.brought_by_name,
    data?.transport?.name,
    data?.transport?.driver_name
  );
  if (!explicitName) return '';
  if (explicitRef || ['TRANSPORT', 'DRIVER', 'SHOFER'].includes(role)) return explicitName;
  return '';
}`);

    source = replaceNamedFunction(source, 'function extractMeasurementChips(row)', `function extractMeasurementChips(row) {
  const chips = [];
  const groupSignatures = new Set();
  const pushValue = (value, qty = 1) => {
    const label = formatMeasureValue(value);
    if (!label) return;
    const count = Math.max(1, Math.min(Number(qty) || 1, 80));
    for (let index = 0; index < count; index += 1) chips.push(label);
  };
  const pushRowsOnce = (rows) => {
    if (!Array.isArray(rows) || !rows.length) return;
    const signature = JSON.stringify(rows.map((item) => item && typeof item === 'object'
      ? [formatMeasureValue(item?.m2 ?? item?.meter ?? item?.measurement ?? item?.value), Number(item?.qty ?? item?.pieces ?? item?.cope ?? 1) || 1]
      : [formatMeasureValue(item), 1]));
    if (groupSignatures.has(signature)) return;
    groupSignatures.add(signature);
    for (const item of rows) {
      if (item && typeof item === 'object') {
        pushValue(item?.m2 ?? item?.meter ?? item?.measurement ?? item?.value, item?.qty ?? item?.pieces ?? item?.cope ?? 1);
      } else {
        pushValue(item, 1);
      }
    }
  };

  try {
    const data = unwrapData(row);
    pushRowsOnce(data?.tepiha);
    pushRowsOnce(data?.tepihaRows);
    pushRowsOnce(data?.staza);
    pushRowsOnce(data?.stazaRows);
    pushRowsOnce(data?.m2_list);
    pushRowsOnce(data?.m2s);
    pushRowsOnce(data?.measurements);
    const stairsQty = Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0;
    const stairsPer = Number(data?.shkallore?.per ?? data?.stairsPer ?? 0) || 0;
    if (stairsQty > 0 && stairsPer > 0) pushValue(stairsPer, stairsQty);
  } catch {}

  return chips.filter(Boolean);
}`);

    source = replaceNamedFunction(source, 'function normalizeResult(row, options = {})', `function normalizeResult(row, options = {}) {
  const kind = getKind(row);
  const data = unwrapData(row);
  const rawCode = kind === 'TRANSPORT' ? pickTransportCode(row) : pickBaseCode(row);
  const code = kind === 'TRANSPORT'
    ? (normalizeTransportCodeStrict(rawCode) || normalizeCode(rawCode))
    : normalizeBaseCode(rawCode);
  const orderId = kind === 'BASE' ? pickOrderId(row) : '';
  const transporter = kind === 'TRANSPORT'
    ? resolveTransporterName(row, options?.userResolver)
    : pickExplicitBaseTransporter(row);
  const cleanTransporter = cleanVisiblePersonName(transporter);
  return {
    kind,
    id: row?.id ?? row?.local_oid ?? row?.transport_id ?? null,
    orderId: kind === 'BASE' ? (orderId || null) : null,
    localOid: pickFirst(row?.local_oid, data?.local_oid) || null,
    clientId: row?.client_id ?? row?.clientId ?? data?.client_id ?? data?.clientId ?? null,
    code,
    clientCode: kind === 'BASE' ? code : null,
    status: pickStatus(row),
    name: pickName(row),
    phone: pickPhone(row),
    address: pickAddress(row),
    pieces: computePieces(row),
    createdBy: pickCreatedBy(row),
    transporter: cleanTransporter,
    broughtBy: kind === 'TRANSPORT' ? (cleanTransporter || 'PA EMËR NË CACHE') : '',
    measurements: extractMeasurementChips(row),
    updatedAt: pickFirst(row?.updated_at, data?.updated_at, row?.ready_at, data?.ready_at, row?.delivered_at, data?.delivered_at, row?.created_at, data?.created_at),
    createdAt: pickFirst(row?.created_at, data?.created_at),
    deliveredAt: pickFirst(row?.delivered_at, data?.delivered_at),
    pickedUpAt: pickFirst(row?.picked_up_at, data?.picked_up_at),
    homeSearchSource: pickFirst(row?._homeSearchSource, row?._snapshot ? 'snapshot:' + row._snapshot : '', row?._table),
    sourceRank: computeHomeSearchSourceRank(row),
    classificationVersion: '${MARKER}',
  };
}

export function classifyHomeSearchRow(row) {
  return getKind(row);
}

export function normalizeHomeSearchRow(row, options = {}) {
  return normalizeResult(row, options);
}`);

    fs.writeFileSync(SEARCH_PATH, source, 'utf8');
  }
}

function patchHomeCard() {
  let source = fs.readFileSync(HOME_PATH, 'utf8');
  source = source
    .replace('<span>SJELLË NGA:</span>', '<span>REGJISTRUAR NGA:</span>')
    .replace('<span>PRU NGA:</span>', '<span>TRANSPORTI:</span>');
  if (!source.includes('REGJISTRUAR NGA:')) throw new Error('HOME_BASE_CREATOR_LABEL_MISSING');
  if (!source.includes('TRANSPORTI:')) throw new Error('HOME_BASE_TRANSPORT_LABEL_MISSING');
  fs.writeFileSync(HOME_PATH, source, 'utf8');
}

function patchArkaVersionOwner() {
  let installer = fs.readFileSync(ARKA_INSTALLER_PATH, 'utf8');
  installer = installer
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);
  fs.writeFileSync(ARKA_INSTALLER_PATH, installer, 'utf8');

  let verify = fs.readFileSync(ARKA_VERIFY_PATH, 'utf8');
  verify = verify.replace(/v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2(?:-home-search-base-role-v1)?/g, CACHE_VERSION);
  fs.writeFileSync(ARKA_VERIFY_PATH, verify, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const installerCommand = 'node tools/apply-home-search-base-role-boundary-v1.mjs';
  const finalArkaCommand = 'node tools/apply-arka-daily-close-v2.mjs';
  const pre = String(scripts.prebuild || '').split('&&').map((item) => item.trim()).filter(Boolean)
    .filter((item) => item !== installerCommand && item !== finalArkaCommand);
  pre.push(installerCommand, finalArkaCommand);
  scripts.prebuild = pre.join(' && ');
  scripts['test:home-search-base-role-boundary-v1'] = 'node tools/verify-home-search-base-role-boundary-v1.mjs';
  const testCommand = 'npm run test:home-search-base-role-boundary-v1';
  let build = String(scripts.build || '');
  if (!build.includes(testCommand)) {
    const anchor = ' && npm run test:arka-daily-close-v2';
    if (!build.includes(anchor)) throw new Error('ARKA_TEST_BUILD_ANCHOR_MISSING');
    build = build.replace(anchor, ' && ' + testCommand + anchor);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

patchSearchRuntime();
patchHomeCard();
patchArkaVersionOwner();
patchPackage();
console.log('PASS home search BASE/Transport role boundary V1 installed');
