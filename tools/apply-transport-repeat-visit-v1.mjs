import fs from 'node:fs';

const BOARD_PATH = 'app/transport/board/page.jsx';
const DISPATCH_PATH = 'app/dispatch/page.jsx';
const INBOX_PATH = 'app/transport/board/modules/inbox.jsx';
const PRANIMI_PATH = 'app/transport/pranimi/page.jsx';
const PACKAGE_PATH = 'package.json';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const MARKER = 'TRANSPORT_REPEAT_VISIT_V1';
const INSTALLER = 'node tools/apply-transport-repeat-visit-v1.mjs';
const TEST_COMMAND = 'npm run test:transport-repeat-visit-v1';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v1';

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

function functionRange(source, name) {
  const match = new RegExp('(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) throw new Error(`FUNCTION_NOT_FOUND:${name}`);
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanBalanced(source, paramsStart, '(', ')', `${name}_PARAMS`);
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart] || '')) bodyStart += 1;
  const bodyEnd = scanBalanced(source, bodyStart, '{', '}', `${name}_BODY`);
  return { start: match.index, end: bodyEnd + 1 };
}

function replaceNamedFunction(source, name, replacement) {
  const range = functionRange(source, name);
  return source.slice(0, range.start) + replacement + source.slice(range.end);
}

function insertAfterNamedFunction(source, name, addition) {
  const range = functionRange(source, name);
  return source.slice(0, range.end) + '\n\n' + addition + source.slice(range.end);
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

function replaceLineContaining(source, needle, replacement, label) {
  const idx = source.indexOf(needle);
  if (idx < 0) {
    if (source.includes(replacement.trim())) return source;
    throw new Error(`${label}: line missing`);
  }
  const start = source.lastIndexOf('\n', idx) + 1;
  const endRaw = source.indexOf('\n', idx);
  const end = endRaw < 0 ? source.length : endRaw;
  return source.slice(0, start) + replacement + source.slice(end);
}

function patchBoardIdentity() {
  let source = fs.readFileSync(BOARD_PATH, 'utf8');
  const replacement = String.raw`function transportBoardVisitIdentity(row = {}) {
  // TRANSPORT_REPEAT_VISIT_V1:BOARD_IDENTITY — a permanent T-code identifies the client,
  // not a visit. Every transport order/visit must therefore be reconciled by order id.
  const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const id = String(row?.id || data?.order_id || data?.public_order_id || '').trim();
  if (id) return 'id:' + id;
  const code = getTransportDisplayCode(row);
  const visit = Number(row?.visit_nr ?? data?.visit_nr ?? row?.visit_no ?? data?.visit_no ?? 0) || 0;
  if (code && visit > 0) return 'code:' + code + ':visit:' + visit;
  const stamp = String(row?.created_at || data?.created_at || row?.updated_at || data?.updated_at || '').trim();
  if (code && stamp) return 'code:' + code + ':at:' + stamp;
  return code ? 'code:' + code : '';
}

function pruneTransportBoardCacheRows(rows = [], authoritativeRows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const dbByVisit = new Map();
  const statusRank = (status = '') => {
    const st = normalizeTransportLifecycleStatus(status);
    if (isTransportInactiveStatus(st)) return 90;
    if (TRANSPORT_BOARD_READY_STATUSES.has(st) || TRANSPORT_BOARD_DEPO_STATUSES.has(st) || TRANSPORT_BOARD_DELIVERY_STATUSES.has(st)) return 50;
    if (isTransportBaseOnlyStatus(st)) return 40;
    if (isTransportToBaseStatus(st)) return 30;
    if (isTransportPrePickupStatus(st)) return 20;
    return 0;
  };
  (Array.isArray(authoritativeRows) ? authoritativeRows : []).forEach((row) => {
    const identity = transportBoardVisitIdentity(row);
    if (!identity) return;
    const st = normalizeTransportLifecycleStatus(row?.status || row?.data?.status || '');
    const prev = dbByVisit.get(identity) || '';
    if (!prev || statusRank(st) >= statusRank(prev)) dbByVisit.set(identity, st);
  });
  return list.filter((row) => {
    const ownStatus = getTransportRowStatus(row);
    const identity = transportBoardVisitIdentity(row);
    const dbStatus = identity ? dbByVisit.get(identity) : '';
    if (dbStatus && dbStatus !== ownStatus) {
      if (isTransportBaseOnlyStatus(dbStatus) || TRANSPORT_BOARD_READY_STATUSES.has(dbStatus) || isTransportInactiveStatus(dbStatus)) return false;
    }
    if (isTransportDoneStatus(ownStatus)) return true;
    return isTransportBoardVisibleStatus(ownStatus);
  });
}`;
  source = replaceNamedFunction(source, 'pruneTransportBoardCacheRows', replacement);
  if (!source.includes(`${MARKER}:BOARD_IDENTITY`)) throw new Error('BOARD_REPEAT_VISIT_MARKER_MISSING');
  fs.writeFileSync(BOARD_PATH, source, 'utf8');
}

function patchDispatchPickupPlan() {
  let source = fs.readFileSync(DISPATCH_PATH, 'utf8');

  if (!source.includes(`${MARKER}:DISPATCH_PLAN`)) {
    const helpers = String.raw`// TRANSPORT_REPEAT_VISIT_V1:DISPATCH_PLAN
function normalizeDispatchPlannedM2(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 80) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parseDispatchPlannedM2Tokens(value = '') {
  let text = s(value);
  if (!text) return [];
  text = text
    .replace(/(?:\+|00)?\d[\d\s().-]{6,}\d/g, ' ')
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');
  const out = [];
  const re = /(?:^|[^\d])(\d{1,2}(?:[.,]\d{1,2}))(?=$|[^\d])/g;
  let hit;
  while ((hit = re.exec(text))) {
    const n = normalizeDispatchPlannedM2(hit[1]);
    if (n > 0) out.push(n);
  }
  return out;
}

function dispatchPickupPieceCount(value = '') {
  const hit = s(value).match(/\b(\d{1,2})\s*(?:cop[eë]|copa|tepih(?:a|ë|at)?|qilim(?:a|ë|at)?)\b/i);
  return hit?.[1] ? Math.max(0, Number(hit[1]) || 0) : 0;
}

function buildDispatchPickupPlan({ measurementsText = '', noteText = '', piecesHint = 0 } = {}) {
  const explicit = s(measurementsText);
  const note = s(noteText);
  const noteHasCarpetWords = /\b(?:cop[eë]|copa|tepih(?:a|ë|at)?|qilim(?:a|ë|at)?)\b/i.test(note);
  const sourceText = explicit || (noteHasCarpetWords ? note : '');
  const hintedPieces = Math.max(
    0,
    Number(piecesHint || 0) || 0,
    dispatchPickupPieceCount(explicit),
    dispatchPickupPieceCount(note)
  );
  const tokens = parseDispatchPlannedM2Tokens(sourceText);
  const measurements = hintedPieces > 0 ? tokens.slice(0, hintedPieces) : tokens;
  const pieces = Math.max(hintedPieces, measurements.length);
  const items = measurements.map((m2, index) => ({
    id: 'planned_' + (index + 1),
    type: 'tepih',
    qty: 1,
    m2,
    planned: true,
    source: 'DISPATCH',
  }));
  const m2Total = Math.round((measurements.reduce((sum, value) => sum + value, 0) + Number.EPSILON) * 100) / 100;
  return {
    version: 'DISPATCH_PICKUP_PLAN_V1',
    pieces,
    measurements_m2: measurements,
    m2_total: m2Total,
    items,
    source_text: sourceText,
  };
}

function formatDispatchPickupPlanForInput(row = {}) {
  const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const plan = data?.pickup_plan && typeof data.pickup_plan === 'object' ? data.pickup_plan : {};
  const measurements = Array.isArray(plan?.measurements_m2)
    ? plan.measurements_m2
    : Array.isArray(data?.planned_tepiha)
      ? data.planned_tepiha.map((item) => item?.m2)
      : [];
  return measurements.map((value) => normalizeDispatchPlannedM2(value)).filter((value) => value > 0).join(', ');
}`;
    source = insertAfterNamedFunction(source, 'extractPastePieces', helpers);
  }

  source = replaceOnce(
    source,
    '  const [note, setNote] = useState("");',
    '  const [note, setNote] = useState("");\n  const [pickupMeasurements, setPickupMeasurements] = useState("");',
    'dispatch pickup state',
  );
  source = replaceOnce(
    source,
    '  const [editNote, setEditNote] = useState("");',
    '  const [editNote, setEditNote] = useState("");\n  const [editPickupMeasurements, setEditPickupMeasurements] = useState("");',
    'dispatch edit pickup state',
  );

  source = replaceOnce(
    source,
    '      const cleanNote = s(note);',
    "      const cleanNote = s(note);\n      const pickupPlan = buildDispatchPickupPlan({ measurementsText: pickupMeasurements, noteText: cleanNote, piecesHint: smartPasteResult?.pieces || 0 });",
    'dispatch build pickup plan',
  );

  source = replaceOnce(
    source,
    '          note: cleanNote,\n          created_by: "DISPATCH",',
    '          note: cleanNote,\n          pickup_plan: pickupPlan,\n          planned_tepiha: pickupPlan.items,\n          planned_pieces: pickupPlan.pieces,\n          planned_m2_total: pickupPlan.m2_total,\n          pickup_measurements_text: s(pickupMeasurements),\n          created_by: "DISPATCH",',
    'dispatch pickup payload',
  );

  source = replaceOnce(
    source,
    '      setNote("");\n      setCrmQuery("");',
    '      setNote("");\n      setPickupMeasurements("");\n      setCrmQuery("");',
    'dispatch pickup reset',
  );

  source = replaceOnce(
    source,
    '    setEditNote(s(row?.data?.note || ""));\n    setSmartMessageLabel("COPY PËR KLIENT");',
    '    setEditNote(s(row?.data?.note || ""));\n    setEditPickupMeasurements(formatDispatchPickupPlanForInput(row));\n    setSmartMessageLabel("COPY PËR KLIENT");',
    'dispatch pickup edit preload',
  );

  source = replaceOnce(
    source,
    '      const pickedDriverPin = s(pickedDriver?.pin || pickedDriver?.user_pin);\n      const nextData = {\n        ...(selectedRow.data || {}),\n        note: s(editNote),',
    "      const pickedDriverPin = s(pickedDriver?.pin || pickedDriver?.user_pin);\n      const nextPickupPlan = buildDispatchPickupPlan({ measurementsText: editPickupMeasurements, noteText: s(editNote), piecesHint: selectedRow?.data?.pickup_plan?.pieces || selectedRow?.data?.planned_pieces || 0 });\n      const nextData = {\n        ...(selectedRow.data || {}),\n        note: s(editNote),\n        pickup_plan: nextPickupPlan,\n        planned_tepiha: nextPickupPlan.items,\n        planned_pieces: nextPickupPlan.pieces,\n        planned_m2_total: nextPickupPlan.m2_total,\n        pickup_measurements_text: s(editPickupMeasurements),",
    'dispatch pickup edit save',
  );

  source = replaceOnce(
    source,
    `        <div style={ui.field}>\n          <div style={ui.label}>SHËNIM</div>\n          <textarea style={ui.textarea} value={note} onChange={(e) => setNote(e.target.value)} placeholder="OPSIONALE" />\n        </div>\n\n        <div style={ui.field}>\n          <div style={ui.label}>PLANIFIKIMI</div>`,
    `        <div style={ui.field}>\n          <div style={ui.label}>SHËNIM</div>\n          <textarea style={ui.textarea} value={note} onChange={(e) => setNote(e.target.value)} placeholder="OPSIONALE" />\n        </div>\n\n        <div style={ui.field}>\n          <div style={ui.label}>TEPIHAT PËR MARRJE / m²</div>\n          <input style={ui.input} value={pickupMeasurements} onChange={(e) => setPickupMeasurements(e.target.value)} placeholder="p.sh. 5.8, 5.8" inputMode="decimal" />\n          <div style={ui.sectionHintCompact}>Një vlerë për secilin tepih. P.sh. 2 tepiha: 5.8, 5.8.</div>\n        </div>\n\n        <div style={ui.field}>\n          <div style={ui.label}>PLANIFIKIMI</div>`,
    'dispatch pickup create field',
  );

  source = replaceOnce(
    source,
    `              <div style={ui.field}>\n                <div style={ui.label}>SHËNIM</div>\n                <textarea style={ui.textarea} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="OPSIONALE" />\n              </div>\n            </div>`,
    `              <div style={ui.field}>\n                <div style={ui.label}>SHËNIM</div>\n                <textarea style={ui.textarea} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="OPSIONALE" />\n              </div>\n              <div style={ui.field}>\n                <div style={ui.label}>TEPIHAT PËR MARRJE / m²</div>\n                <input style={ui.input} value={editPickupMeasurements} onChange={(e) => setEditPickupMeasurements(e.target.value)} placeholder="p.sh. 5.8, 5.8" inputMode="decimal" />\n              </div>\n            </div>`,
    'dispatch pickup edit field',
  );

  if (!source.includes(`${MARKER}:DISPATCH_PLAN`)) throw new Error('DISPATCH_PLAN_MARKER_MISSING');
  if (!source.includes('pickup_plan: pickupPlan')) throw new Error('DISPATCH_PLAN_PAYLOAD_MISSING');
  fs.writeFileSync(DISPATCH_PATH, source, 'utf8');
}

function patchInbox() {
  let source = fs.readFileSync(INBOX_PATH, 'utf8');
  const replacement = String.raw`function orderPickupPlan(order) {
  // TRANSPORT_REPEAT_VISIT_V1:INBOX_PLAN
  const data = order?.data && typeof order.data === 'object' && !Array.isArray(order.data) ? order.data : {};
  const rawPlan = data?.pickup_plan && typeof data.pickup_plan === 'object' ? data.pickup_plan : {};
  const plannedRows = Array.isArray(rawPlan?.items)
    ? rawPlan.items
    : Array.isArray(data?.planned_tepiha)
      ? data.planned_tepiha
      : [];
  const measurements = Array.isArray(rawPlan?.measurements_m2)
    ? rawPlan.measurements_m2.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
    : plannedRows.map((item) => Number(item?.m2 ?? item?.area ?? item?.sqm ?? 0)).filter((value) => Number.isFinite(value) && value > 0);
  const pieces = Math.max(0, Number(rawPlan?.pieces ?? data?.planned_pieces ?? plannedRows.length ?? 0) || 0, measurements.length);
  const m2TotalRaw = Number(rawPlan?.m2_total ?? data?.planned_m2_total ?? 0);
  const m2Total = Number.isFinite(m2TotalRaw) && m2TotalRaw > 0
    ? m2TotalRaw
    : measurements.reduce((sum, value) => sum + value, 0);
  return { pieces, measurements, m2Total, items: plannedRows };
}

function orderPickupM2(order) {
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  const direct = Number(data?.m2_total ?? data?.total_m2 ?? data?.m2 ?? data?.pay?.m2 ?? order?.m2_total ?? order?.m2 ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const actualRows = [
    ...(Array.isArray(data?.tepiha) ? data.tepiha : []),
    ...(Array.isArray(data?.staza) ? data.staza : []),
  ];
  const actual = actualRows.reduce((sum, item) => {
    const qty = Number(item?.qty ?? item?.pieces ?? 1) || 1;
    const area = Number(item?.m2 ?? item?.area ?? item?.sqm ?? 0) || 0;
    return sum + (area > 0 ? area * qty : 0);
  }, 0);
  if (actual > 0) return actual;
  return orderPickupPlan(order).m2Total;
}

function orderPickupMeasurementsLabel(order) {
  const plan = orderPickupPlan(order);
  if (!plan.measurements.length) return '';
  return plan.measurements.map((value) => Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)).join(' + ') + ' m²';
}

function orderPieces(order) {
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  const explicit = Number(
    order?.pieces ??
    order?.total_pieces ??
    data?.totals?.pieces ??
    data?.totals?.cope ??
    data?.pieces ??
    data?.cope ??
    0
  ) || 0;
  if (explicit > 0) return explicit;
  const actual = sumQtyRows(data?.tepiha || data?.tepihaRows) +
    sumQtyRows(data?.staza || data?.stazaRows) +
    (Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0);
  if (actual > 0) return actual;
  return orderPickupPlan(order).pieces;
}`;
  source = replaceNamedFunction(source, 'orderPieces', replacement);

  source = replaceOnce(
    source,
    '            const pieces = orderPieces(order);\n            const address = cleanAddress(orderAddress(order));',
    '            const pieces = orderPieces(order);\n            const m2Total = orderPickupM2(order);\n            const pickupPlanLabel = orderPickupMeasurementsLabel(order);\n            const address = cleanAddress(orderAddress(order));',
    'inbox pickup metrics',
  );

  source = replaceOnce(
    source,
    `                      {dateBadge ? (\n                        <span style={dateBadgeStyle}>{dateBadge}</span>\n                      ) : null}\n\n                      <div style={cardFooterStyle}>\n                        <span style={{ color: 'rgba(255,255,255,0.70)', fontSize: 12, fontWeight: 900 }}>{pieces} copë • {total} €</span>`,
    `                      {dateBadge ? (\n                        <span style={dateBadgeStyle}>{dateBadge}</span>\n                      ) : null}\n\n                      {pickupPlanLabel ? (\n                        <div style={{ color:'#fde68a', fontSize:11.5, fontWeight:950 }}>TEPIHAT: {pickupPlanLabel}</div>\n                      ) : null}\n\n                      <div style={cardFooterStyle}>\n                        <span style={{ color: 'rgba(255,255,255,0.70)', fontSize: 12, fontWeight: 900 }}>{pieces} copë{m2Total > 0 ? ' • ' + Number(m2Total).toFixed(1) + ' m²' : ''}{total > 0 ? ' • ' + Number(total).toFixed(2) + ' €' : ''}</span>`,
    'inbox pickup plan display',
  );

  if (!source.includes(`${MARKER}:INBOX_PLAN`)) throw new Error('INBOX_PLAN_MARKER_MISSING');
  fs.writeFileSync(INBOX_PATH, source, 'utf8');
}

function patchPranimiPrefill() {
  let source = fs.readFileSync(PRANIMI_PATH, 'utf8');
  if (!source.includes(`${MARKER}:PRANIMI_PREFILL`)) {
    source = replaceLineContaining(
      source,
      'try { setTepihaRows((d.tepiha||[]).map',
      `                try {\n                  // ${MARKER}:PRANIMI_PREFILL — Dispatch plan is visit-specific and only pre-fills when actual pickup rows do not exist.\n                  const plannedRows = Array.isArray(d?.pickup_plan?.items)\n                    ? d.pickup_plan.items\n                    : (Array.isArray(d?.planned_tepiha) ? d.planned_tepiha : []);\n                  const sourceRows = Array.isArray(d?.tepiha) && d.tepiha.length ? d.tepiha : plannedRows;\n                  setTepihaRows(sourceRows.map((r,i)=>({...r, planned: false, id:'t' + i})));\n                } catch{}`,
      'pranimi planned pickup prefill',
    );
  }
  if (!source.includes(`${MARKER}:PRANIMI_PREFILL`)) throw new Error('PRANIMI_PREFILL_MARKER_MISSING');
  fs.writeFileSync(PRANIMI_PATH, source, 'utf8');
}

function patchFinalVersionOwner() {
  let gati = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  gati = gati
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);

  if (!gati.includes("const repeatVisitInstaller = 'node tools/apply-transport-repeat-visit-v1.mjs';")) {
    gati = replaceOnce(
      gati,
      "  const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';",
      "  const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';\n  const repeatVisitInstaller = 'node tools/apply-transport-repeat-visit-v1.mjs';",
      'gati repeat visit declaration',
    );
    gati = replaceOnce(
      gati,
      '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller);\n  pre.push(arkaInstaller, unifiedInstaller, installer);',
      '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitInstaller);\n  pre.push(arkaInstaller, unifiedInstaller, repeatVisitInstaller, installer);',
      'gati repeat visit final order',
    );
  }
  fs.writeFileSync(GATI_INSTALLER_PATH, gati, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const gatiInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
  const pre = String(scripts.prebuild || '')
    .split('&&')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== INSTALLER);
  const gatiIndex = pre.lastIndexOf(gatiInstaller);
  if (gatiIndex >= 0) pre.splice(gatiIndex, 0, INSTALLER);
  else pre.push(INSTALLER);
  scripts.prebuild = pre.join(' && ');
  scripts['test:transport-repeat-visit-v1'] = 'node tools/verify-transport-repeat-visit-v1.mjs';
  let build = String(scripts.build || '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

patchBoardIdentity();
patchDispatchPickupPlan();
patchInbox();
patchPranimiPrefill();
patchFinalVersionOwner();
patchPackage();
console.log('PASS transport repeat visit V1: permanent client T-code no longer suppresses a new visit; Dispatch pickup measurements persist and prefill the driver flow.');
