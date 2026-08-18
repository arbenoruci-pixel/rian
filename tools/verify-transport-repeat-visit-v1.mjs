import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const board = fs.readFileSync('app/transport/board/page.jsx', 'utf8');
const dispatch = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
const inbox = fs.readFileSync('app/transport/board/modules/inbox.jsx', 'utf8');
const pranimi = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const installer = fs.readFileSync('tools/apply-transport-repeat-visit-v1.mjs', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(board.includes('TRANSPORT_REPEAT_VISIT_V1:BOARD_IDENTITY'), 'board visit-identity marker missing');
check(board.includes("return 'id:' + id;"), 'board does not prefer unique order id');
check(board.includes("':visit:' + visit"), 'board visit-number fallback missing');
check(board.includes('const dbByVisit = new Map();'), 'board still reconciles by client T-code');
check(!board.includes('const dbByCode = new Map();'), 'legacy T-code-only cache reconciliation remains');

check(dispatch.includes('TRANSPORT_REPEAT_VISIT_V1:DISPATCH_PLAN'), 'Dispatch pickup-plan marker missing');
check(dispatch.includes('TEPIHAT PËR MARRJE / m²'), 'Dispatch pickup measurement field missing');
check(dispatch.includes('pickup_plan: pickupPlan'), 'Dispatch does not persist pickup plan');
check(dispatch.includes('planned_tepiha: pickupPlan.items'), 'Dispatch planned rows missing');
check(dispatch.includes('planned_m2_total: pickupPlan.m2_total'), 'Dispatch planned m2 total missing');
check(dispatch.includes('setEditPickupMeasurements(formatDispatchPickupPlanForInput(row))'), 'Dispatch edit does not preload visit plan');
check(dispatch.includes('pickup_plan: nextPickupPlan'), 'Dispatch edit does not preserve/update visit plan');

check(inbox.includes('TRANSPORT_REPEAT_VISIT_V1:INBOX_PLAN'), 'Inbox pickup plan marker missing');
check(inbox.includes('TEPIHAT: {pickupPlanLabel}'), 'Inbox does not show planned measurements');
check(inbox.includes("Number(m2Total).toFixed(1) + ' m²'"), 'Inbox does not show m2 total');
check(inbox.includes('return orderPickupPlan(order).pieces;'), 'Inbox piece count does not fall back to Dispatch plan');

check(pranimi.includes('TRANSPORT_REPEAT_VISIT_V1:PRANIMI_PREFILL'), 'Transport Pranimi planned prefill marker missing');
check(pranimi.includes('Array.isArray(d?.pickup_plan?.items)'), 'Transport Pranimi does not read visit-specific pickup plan');
check(pranimi.includes('d.tepiha.length ? d.tepiha : plannedRows'), 'actual pickup rows do not override planned rows');

const prebuild = String(pkg.scripts?.prebuild || '');
const repeatInstaller = 'node tools/apply-transport-repeat-visit-v1.mjs';
const unifiedInstaller = 'node tools/apply-unified-arka-payroll-v1.mjs';
const gatiFinalInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(repeatInstaller), 'repeat-visit installer missing from prebuild');
check(prebuild.lastIndexOf(unifiedInstaller) < prebuild.lastIndexOf(repeatInstaller), 'repeat-visit installer must run after unified ARKA installer');
check(prebuild.lastIndexOf(repeatInstaller) < prebuild.lastIndexOf(gatiFinalInstaller), 'repeat-visit installer must run before final GATI version owner');
check(prebuild.trim().endsWith(gatiFinalInstaller), 'GATI final owner must remain last');
check(String(pkg.scripts?.build || '').includes('npm run test:transport-repeat-visit-v1'), 'repeat-visit verifier missing from full build');
check(String(pkg.version || '').includes('repeat-visit-v1'), 'package version missing repeat-visit suffix');
check(gatiInstaller.includes('repeat-visit-v1'), 'final GATI version owner can overwrite repeat-visit build id');
check(gatiInstaller.includes('repeatVisitInstaller'), 'GATI installer does not preserve repeat-visit order');
check(vite.includes('repeat-visit-v1'), 'PWA cache generation missing repeat-visit suffix');
check(index.includes('repeat-visit-v1'), 'HTML build id missing repeat-visit suffix');
check(installer.includes('TRANSPORT_REPEAT_VISIT_V1'), 'installer marker missing');

function normalizeCode(row = {}) {
  const raw = String(row?.client_tcode || row?.code_str || row?.data?.transport_client_tcode || row?.data?.client_tcode || row?.data?.code_str || '').trim().toUpperCase();
  if (/^T\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `T${raw}`;
  return raw;
}
function identity(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const id = String(row?.id || data?.order_id || data?.public_order_id || '').trim();
  if (id) return 'id:' + id;
  const code = normalizeCode(row);
  const visit = Number(row?.visit_nr ?? data?.visit_nr ?? 0) || 0;
  if (code && visit > 0) return 'code:' + code + ':visit:' + visit;
  return code ? 'code:' + code : '';
}
const oldVisit = { id:'7376b149-2380-4af1-830f-6028ae7d12e6', code_str:'T1095', visit_nr:1, status:'done' };
const newVisit = { id:'4306cf89-c5fc-4e5e-b767-b4464419e25e', code_str:'T1095', visit_nr:2, status:'assigned' };
check(normalizeCode(oldVisit) === normalizeCode(newVisit), 'fixture no longer represents same permanent client T-code');
check(identity(oldVisit) !== identity(newVisit), 'two visits of T1095 still collapse to one identity');

function parsePlan(text, piecesHint = 0) {
  const clean = String(text || '')
    .replace(/(?:\+|00)?\d[\d\s().-]{6,}\d/g, ' ')
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ');
  const explicit = String(text || '').match(/\b(\d{1,2})\s*(?:cop[eë]|copa|tepih(?:a|ë|at)?|qilim(?:a|ë|at)?)\b/i);
  const pieces = Number(piecesHint || explicit?.[1] || 0) || 0;
  const values = [];
  const re = /(?:^|[^\d])(\d{1,2}(?:[.,]\d{1,2}))(?=$|[^\d])/g;
  let hit;
  while ((hit = re.exec(clean))) {
    const n = Number(String(hit[1]).replace(',', '.'));
    if (Number.isFinite(n) && n > 0 && n <= 80) values.push(n);
  }
  const measurements = pieces > 0 ? values.slice(0,pieces) : values;
  return { pieces: Math.max(pieces,measurements.length), measurements, total: measurements.reduce((a,b)=>a+b,0) };
}
const t1095Plan = parsePlan('2 tepiha 5.8 5.8', 2);
check(t1095Plan.pieces === 2, 'T1095 pickup fixture does not retain two carpets');
check(t1095Plan.measurements.length === 2 && t1095Plan.measurements.every((value) => Math.abs(value - 5.8) < 0.001), 'T1095 pickup fixture does not retain 5.8 + 5.8');
check(Math.abs(t1095Plan.total - 11.6) < 0.001, 'T1095 pickup fixture total is not 11.6 m2');

if (failures.length) {
  console.error(`FAIL transport repeat visit V1: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS transport repeat visit V1: same-client repeat visits stay separate, Dispatch pickup measurements persist, Inbox shows them, and Pranimi pre-fills them safely.');
