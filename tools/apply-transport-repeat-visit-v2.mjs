import fs from 'node:fs';

const BOARD_PATH = 'app/transport/board/page.jsx';
const DISPATCH_PATH = 'app/dispatch/page.jsx';
const INBOX_PATH = 'app/transport/board/modules/inbox.jsx';
const PRANIMI_PATH = 'app/transport/pranimi/page.jsx';
const PACKAGE_PATH = 'package.json';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const MARKER = 'TRANSPORT_REPEAT_VISIT_V2';
const INSTALLER = 'node tools/apply-transport-repeat-visit-v2.mjs';
const TEST_COMMAND = 'npm run test:transport-repeat-visit-v2';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2';

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

function replaceUnique(source, needle, replacement, label) {
  if (source.includes(replacement)) return source;
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(needle, replacement);
}

function insertAfterLine(source, needle, lineToInsert, label) {
  if (source.includes(lineToInsert.trim())) return source;
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(needle, `${needle}\n${lineToInsert}`);
}

function patchBoard() {
  let source = fs.readFileSync(BOARD_PATH, 'utf8');
  const replacement = `function transportBoardVisitIdentity(row = {}) {
  // ${MARKER}:BOARD — T-code belongs to the client; visit/order id belongs to the job.
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
  if (!source.includes(`${MARKER}:BOARD`)) throw new Error('BOARD_MARKER_MISSING');
  if (source.includes('const dbByCode = new Map();')) throw new Error('CODE_ONLY_RECONCILIATION_REMAINS');
  fs.writeFileSync(BOARD_PATH, source, 'utf8');
}

function patchDispatch() {
  let source = fs.readFileSync(DISPATCH_PATH, 'utf8');

  if (!source.includes(`${MARKER}:DISPATCH`)) {
    const helpers = `// ${MARKER}:DISPATCH — every repeat visit carries its own pickup plan.
function normalizeDispatchPickupM2(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > 80) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parseDispatchPickupMeasurements(value = '') {
  const text = String(value || '')
    .replace(/(?:\\+|00)?\\d[\\d\\s().-]{6,}\\d/g, ' ')
    .replace(/\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b/g, ' ')
    .replace(/\\b\\d{1,2}:\\d{2}\\b/g, ' ');
  const out = [];
  const re = /(?:^|[^\\d])(\\d{1,2}(?:[.,]\\d{1,2}))(?=$|[^\\d])/g;
  let hit;
  while ((hit = re.exec(text))) {
    const n = normalizeDispatchPickupM2(hit[1]);
    if (n > 0) out.push(n);
  }
  return out;
}

function dispatchPickupPieceHint(value = '') {
  const hit = String(value || '').match(/\\b(\\d{1,2})\\s*(?:cop[eë]|copa|tepih(?:a|ë|at)?|qilim(?:a|ë|at)?)\\b/i);
  return hit?.[1] ? Math.max(0, Number(hit[1]) || 0) : 0;
}

function buildDispatchPickupPlan({ measurementsText = '', noteText = '', piecesHint = 0 } = {}) {
  const explicit = String(measurementsText || '').trim();
  const note = String(noteText || '').trim();
  const noteHasCarpetWords = /\\b(?:cop[eë]|copa|tepih(?:a|ë|at)?|qilim(?:a|ë|at)?)\\b/i.test(note);
  const sourceText = explicit || (noteHasCarpetWords ? note : '');
  const hintedPieces = Math.max(0, Number(piecesHint || 0) || 0, dispatchPickupPieceHint(explicit), dispatchPickupPieceHint(note));
  const tokens = parseDispatchPickupMeasurements(sourceText);
  const measurements = hintedPieces > 0 ? tokens.slice(0, hintedPieces) : tokens;
  const pieces = Math.max(hintedPieces, measurements.length);
  const items = measurements.map((m2, index) => ({ id: 'planned_' + (index + 1), type: 'tepih', qty: 1, m2, planned: true, source: 'DISPATCH' }));
  const m2Total = Math.round((measurements.reduce((sum, n) => sum + n, 0) + Number.EPSILON) * 100) / 100;
  return { version: 'DISPATCH_PICKUP_PLAN_V2', pieces, measurements_m2: measurements, m2_total: m2Total, items, source_text: sourceText };
}

function formatDispatchPickupPlanForInput(row = {}) {
  const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const plan = data?.pickup_plan && typeof data.pickup_plan === 'object' ? data.pickup_plan : {};
  const values = Array.isArray(plan?.measurements_m2)
    ? plan.measurements_m2
    : Array.isArray(data?.planned_tepiha) ? data.planned_tepiha.map((item) => item?.m2) : [];
  return values.map(normalizeDispatchPickupM2).filter((n) => n > 0).join(', ');
}`;
    source = insertAfterNamedFunction(source, 'extractPastePieces', helpers);
  }

  source = insertAfterLine(source, '  const [note, setNote] = useState("");', '  const [pickupMeasurements, setPickupMeasurements] = useState("");', 'create pickup state');
  source = insertAfterLine(source, '  const [editNote, setEditNote] = useState("");', '  const [editPickupMeasurements, setEditPickupMeasurements] = useState("");', 'edit pickup state');
  source = insertAfterLine(source, '      const cleanNote = s(note);', '      const pickupPlan = buildDispatchPickupPlan({ measurementsText: pickupMeasurements, noteText: cleanNote, piecesHint: smartPasteResult?.pieces || 0 });', 'build pickup plan');

  source = insertAfterLine(source, '          note: cleanNote,', `          pickup_plan: pickupPlan,
          planned_tepiha: pickupPlan.items,
          planned_pieces: pickupPlan.pieces,
          planned_m2_total: pickupPlan.m2_total,
          pickup_measurements_text: String(pickupMeasurements || '').trim(),`, 'persist pickup plan');

  source = insertAfterLine(source, '      setNote("");', '      setPickupMeasurements("");', 'reset pickup plan');
  source = insertAfterLine(source, '    setEditNote(s(row?.data?.note || ""));', '    setEditPickupMeasurements(formatDispatchPickupPlanForInput(row));', 'preload pickup plan');
  source = insertAfterLine(source, '      const pickedDriverPin = s(pickedDriver?.pin || pickedDriver?.user_pin);', '      const nextPickupPlan = buildDispatchPickupPlan({ measurementsText: editPickupMeasurements, noteText: s(editNote), piecesHint: selectedRow?.data?.pickup_plan?.pieces || selectedRow?.data?.planned_pieces || 0 });', 'build edited pickup plan');

  const editNoteLine = '        note: s(editNote),';
  const editNoteIndex = source.indexOf(editNoteLine);
  if (editNoteIndex < 0) throw new Error('edit note payload line missing');
  const editPlanText = '        pickup_plan: nextPickupPlan,';
  if (!source.includes(editPlanText)) {
    source = source.replace(editNoteLine, `${editNoteLine}
        pickup_plan: nextPickupPlan,
        planned_tepiha: nextPickupPlan.items,
        planned_pieces: nextPickupPlan.pieces,
        planned_m2_total: nextPickupPlan.m2_total,
        pickup_measurements_text: String(editPickupMeasurements || '').trim(),`);
  }

  const createTextarea = '          <textarea style={ui.textarea} value={note} onChange={(e) => setNote(e.target.value)} placeholder="OPSIONALE" />';
  if (!source.includes('value={pickupMeasurements}')) {
    source = replaceUnique(source, createTextarea, `${createTextarea}
        </div>

        <div style={ui.field}>
          <div style={ui.label}>TEPIHAT PËR MARRJE / m²</div>
          <input style={ui.input} value={pickupMeasurements} onChange={(e) => setPickupMeasurements(e.target.value)} placeholder="p.sh. 5.8, 5.8" inputMode="decimal" />
          <div style={ui.sectionHintCompact}>Një vlerë për secilin tepih. P.sh. 2 tepiha: 5.8, 5.8.</div>`, 'create pickup field');
  }

  const editTextarea = '                <textarea style={ui.textarea} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="OPSIONALE" />';
  if (!source.includes('value={editPickupMeasurements}')) {
    source = replaceUnique(source, editTextarea, `${editTextarea}
              </div>
              <div style={ui.field}>
                <div style={ui.label}>TEPIHAT PËR MARRJE / m²</div>
                <input style={ui.input} value={editPickupMeasurements} onChange={(e) => setEditPickupMeasurements(e.target.value)} placeholder="p.sh. 5.8, 5.8" inputMode="decimal" />`, 'edit pickup field');
  }

  if (!source.includes(`${MARKER}:DISPATCH`)) throw new Error('DISPATCH_MARKER_MISSING');
  if (!source.includes('pickup_plan: pickupPlan')) throw new Error('PICKUP_PLAN_PAYLOAD_MISSING');
  fs.writeFileSync(DISPATCH_PATH, source, 'utf8');
}

function patchInbox() {
  let source = fs.readFileSync(INBOX_PATH, 'utf8');
  const replacement = `function orderPickupPlan(order) {
  // ${MARKER}:INBOX — planned dimensions belong to this exact visit.
  const data = order?.data && typeof order.data === 'object' && !Array.isArray(order.data) ? order.data : {};
  const plan = data?.pickup_plan && typeof data.pickup_plan === 'object' ? data.pickup_plan : {};
  const plannedRows = Array.isArray(plan?.items) ? plan.items : (Array.isArray(data?.planned_tepiha) ? data.planned_tepiha : []);
  const measurements = Array.isArray(plan?.measurements_m2)
    ? plan.measurements_m2.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : plannedRows.map((item) => Number(item?.m2 ?? item?.area ?? item?.sqm ?? 0)).filter((n) => Number.isFinite(n) && n > 0);
  const pieces = Math.max(0, Number(plan?.pieces ?? data?.planned_pieces ?? plannedRows.length ?? 0) || 0, measurements.length);
  const explicitTotal = Number(plan?.m2_total ?? data?.planned_m2_total ?? 0);
  const m2Total = Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : measurements.reduce((sum, n) => sum + n, 0);
  return { pieces, measurements, m2Total };
}

function orderPickupM2(order) {
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  const direct = Number(data?.m2_total ?? data?.total_m2 ?? data?.m2 ?? data?.pay?.m2 ?? order?.m2_total ?? order?.m2 ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const actualRows = [...(Array.isArray(data?.tepiha) ? data.tepiha : []), ...(Array.isArray(data?.staza) ? data.staza : [])];
  const actual = actualRows.reduce((sum, item) => {
    const qty = Number(item?.qty ?? item?.pieces ?? 1) || 1;
    const area = Number(item?.m2 ?? item?.area ?? item?.sqm ?? 0) || 0;
    return sum + (area > 0 ? area * qty : 0);
  }, 0);
  return actual > 0 ? actual : orderPickupPlan(order).m2Total;
}

function orderPickupMeasurementsLabel(order) {
  const values = orderPickupPlan(order).measurements;
  if (!values.length) return '';
  return values.map((n) => Number(n).toFixed(Number(n) % 1 === 0 ? 0 : 1)).join(' + ') + ' m²';
}

function orderPieces(order) {
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  const explicit = Number(order?.pieces ?? order?.total_pieces ?? data?.totals?.pieces ?? data?.totals?.cope ?? data?.pieces ?? data?.cope ?? 0) || 0;
  if (explicit > 0) return explicit;
  const actual = sumQtyRows(data?.tepiha || data?.tepihaRows) + sumQtyRows(data?.staza || data?.stazaRows) + (Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0);
  return actual > 0 ? actual : orderPickupPlan(order).pieces;
}`;
  source = replaceNamedFunction(source, 'orderPieces', replacement);

  source = insertAfterLine(source, '            const pieces = orderPieces(order);', `            const m2Total = orderPickupM2(order);
            const pickupPlanLabel = orderPickupMeasurementsLabel(order);`, 'inbox visit metrics');

  const dateBadgeClose = '                      ) : null}';
  const footerNeedle = `                      <div style={cardFooterStyle}>
                        <span style={{ color: 'rgba(255,255,255,0.70)', fontSize: 12, fontWeight: 900 }}>{pieces} copë • {total} €</span>`;
  if (!source.includes('TEPIHAT: {pickupPlanLabel}')) {
    source = replaceUnique(source, footerNeedle, `                      {pickupPlanLabel ? (
                        <div style={{ color:'#fde68a', fontSize:11.5, fontWeight:950 }}>TEPIHAT: {pickupPlanLabel}</div>
                      ) : null}

                      <div style={cardFooterStyle}>
                        <span style={{ color: 'rgba(255,255,255,0.70)', fontSize: 12, fontWeight: 900 }}>{pieces} copë{m2Total > 0 ? ' • ' + Number(m2Total).toFixed(1) + ' m²' : ''}{total > 0 ? ' • ' + Number(total).toFixed(2) + ' €' : ''}</span>`, 'inbox visit display');
  }

  if (!source.includes(`${MARKER}:INBOX`)) throw new Error('INBOX_MARKER_MISSING');
  fs.writeFileSync(INBOX_PATH, source, 'utf8');
}

function patchPranimi() {
  let source = fs.readFileSync(PRANIMI_PATH, 'utf8');
  const oldLine = '                try { setTepihaRows((d.tepiha||[]).map((r,i)=>({...r, id:`t${i}`}))); } catch{}';
  const replacement = `                try {
                  // ${MARKER}:PRANIMI — prefill this visit's Dispatch plan; actual rows win if they already exist.
                  const plannedRows = Array.isArray(d?.pickup_plan?.items)
                    ? d.pickup_plan.items
                    : (Array.isArray(d?.planned_tepiha) ? d.planned_tepiha : []);
                  const sourceRows = Array.isArray(d?.tepiha) && d.tepiha.length ? d.tepiha : plannedRows;
                  setTepihaRows(sourceRows.map((r,i)=>({...r, planned: false, id:'t' + i})));
                } catch{}`;
  if (!source.includes(`${MARKER}:PRANIMI`)) {
    source = replaceUnique(source, oldLine, replacement, 'pranimi visit prefill');
  }
  if (!source.includes(`${MARKER}:PRANIMI`)) throw new Error('PRANIMI_MARKER_MISSING');
  fs.writeFileSync(PRANIMI_PATH, source, 'utf8');
}

function patchVersionOwners() {
  let gati = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  gati = gati
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);

  const decl = "  const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';";
  if (!gati.includes("const repeatVisitV2Installer = 'node tools/apply-transport-repeat-visit-v2.mjs';")) {
    gati = replaceUnique(gati, decl, `${decl}\n  const repeatVisitV2Installer = 'node tools/apply-transport-repeat-visit-v2.mjs';`, 'gati v2 declaration');
  }
  gati = gati.replace(
    '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller);',
    '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitV2Installer);'
  );
  gati = gati.replace(
    'pre.push(arkaInstaller, unifiedInstaller, installer);',
    'pre.push(arkaInstaller, unifiedInstaller, repeatVisitV2Installer, installer);'
  );
  // If an earlier repeat-visit experiment is present, remove it from the final owner order.
  gati = gati.replace(/\s*const repeatVisitInstaller = 'node tools\/apply-transport-repeat-visit-v1\.mjs';\n/g, '\n');
  gati = gati.replace(/ && item !== repeatVisitInstaller/g, '');
  gati = gati.replace(/, repeatVisitInstaller/g, '');
  fs.writeFileSync(GATI_INSTALLER_PATH, gati, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const gatiInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
  const oldV1 = 'node tools/apply-transport-repeat-visit-v1.mjs';
  const pre = String(scripts.prebuild || '')
    .split('&&').map((item) => item.trim()).filter(Boolean)
    .filter((item) => item !== INSTALLER && item !== oldV1);
  const gatiIndex = pre.lastIndexOf(gatiInstaller);
  if (gatiIndex >= 0) pre.splice(gatiIndex, 0, INSTALLER);
  else pre.push(INSTALLER);
  scripts.prebuild = pre.join(' && ');
  scripts['test:transport-repeat-visit-v2'] = 'node tools/verify-transport-repeat-visit-v2.mjs';
  let build = String(scripts.build || '');
  build = build.replace(/\s*&&\s*npm run test:transport-repeat-visit-v1/g, '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  delete scripts['test:transport-repeat-visit-v1'];
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

patchBoard();
patchDispatch();
patchInbox();
patchPranimi();
patchVersionOwners();
patchPackage();
console.log('PASS transport repeat visit V2 patch applied');
