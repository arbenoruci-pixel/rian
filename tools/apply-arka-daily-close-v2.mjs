import fs from 'node:fs';

const PAGE_PATH = 'app/arka/page.jsx';
const DAILY_PAGE_PATH = 'app/arka/ditore/page.jsx';
const PACKAGE_PATH = 'package.json';
const VITE_PATH = 'vite.config.js';
const EPOCH_PATH = 'lib/appEpoch.js';
const INDEX_PATH = 'index.html';
const MARKER = 'ARKA_DAILY_CLOSE_V2_ONE_WAY';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1';
const LEGACY_RUNTIME_VERSION = '2.0.115-query-authority-transport-guard-v4';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1-home-search-localoid-dedupe-v1';

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
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
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

function replaceNamedFunction(source, signature, replacement, searchStart = 0) {
  const start = source.indexOf(signature, searchStart);
  if (start < 0) throw new Error(`FUNCTION_NOT_FOUND:${signature}`);
  const paramsStart = source.indexOf('(', start);
  const paramsEnd = scanBalanced(source, paramsStart, '(', ')', `${signature}_PARAMS`);
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart] || '')) bodyStart += 1;
  const bodyEnd = scanBalanced(source, bodyStart, '{', '}', `${signature}_BODY`);
  return `${source.slice(0, start)}${replacement}${source.slice(bodyEnd + 1)}`;
}

function patchMainPage() {
  let source = fs.readFileSync(PAGE_PATH, 'utf8');

  const needsOneWayPatch = !source.includes(MARKER) || source.includes('await acceptDispatchHandoff({');
  if (needsOneWayPatch) {
    const pendingStart = source.indexOf('function PendingHandoffRow(');
    if (pendingStart < 0) throw new Error('PENDING_HANDOFF_COMPONENT_MISSING');
    const handleSignature = source.indexOf('async function handleAccept()', pendingStart) >= 0
      ? 'async function handleAccept()'
      : 'function handleAccept()';
    source = replaceNamedFunction(source, handleSignature, `function handleAccept() {
      // ${MARKER}: individual acceptance is disabled; Dispatch closes all confirmed cash in one wizard.
      if (typeof window !== 'undefined') window.location.assign('/arka/ditore');
    }`, pendingStart);

    source = replaceNamedFunction(source, 'function acceptWorkerCashFromCard(item)', `function acceptWorkerCashFromCard() {
      // ${MARKER}: every manager entry point uses the same daily close route.
      if (typeof window !== 'undefined') window.location.assign('/arka/ditore');
    }`);

    source = replaceNamedFunction(source, 'async function confirmCashAcceptReview()', `async function confirmCashAcceptReview() {
      // ${MARKER}: legacy review modal cannot post to the budget.
      setCashAcceptReview(null);
      if (typeof window !== 'undefined') window.location.assign('/arka/ditore');
    }`);
  }

  if (!source.includes("supabase.rpc('create_arka_advance_atomic_v2'")) {
    source = replaceNamedFunction(source, 'async function insertWorkerAdvance({ worker, amount, note })', `async function insertWorkerAdvance({ worker, amount, note }) {
    // ${MARKER}: an advance is created together with its immediate audited budget OUT.
    const workerPin = String(worker?.pin || actor?.pin || '').trim();
    const workerName = String(worker?.name || actor?.name || workerPin).trim();
    if (!workerPin) throw new Error('MUNGON PIN-I I PUNËTORIT.');
    const amountValue = +n(amount).toFixed(2);
    if (!(amountValue > 0)) throw new Error('SHUMA E AVANSIT DUHET MBI 0€.');
    const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : String(Date.now()) + '_' + Math.random().toString(36).slice(2);
    const { data, error: rpcError } = await supabase.rpc('create_arka_advance_atomic_v2', {
      p_actor_pin: String(actor?.pin || '').trim(),
      p_actor_name: String(actor?.name || actor?.pin || '').trim(),
      p_worker_pin: workerPin,
      p_worker_name: workerName,
      p_amount: amountValue,
      p_note: String(note || 'AVANS').trim() || 'AVANS',
      p_idempotency_key: 'ARKA_ADVANCE_V2:' + workerPin + ':' + nonce,
    });
    if (rpcError) throw rpcError;
    if (data?.ok !== true) throw new Error(data?.message || 'AVANSI NUK U POSTUA NË BUXHET.');
    return data?.advance || null;
  }`);
  }

  source = source
    .replace("{busy === 'accept' ? '...' : 'PRANO CASH'}", "{busy === 'accept' ? '...' : 'HAP MBYLLJEN DITORE'}")
    .replace("{pendingCount ? 'PRANO CASH (' + pendingCount + ')' : 'PRANO CASH'}", "{pendingCount ? 'MBYLL DITËN (' + pendingCount + ')' : 'MBYLL DITËN'}")
    .replace('HAPE PAMJEN DITORE', 'HAPE MBYLLJEN DITORE')
    .replace('Shifrat llogariten direkt nga DB dhe ruhen si snapshot vetem per lexim offline. Qasja eshte vetem DISPATCH.', 'Dorëzimet hyjnë në buxhet vetëm nga wizard-i ditor. Numërimi fizik, daljet dhe diferenca ruhen me audit.');

  if (!source.includes(MARKER)) throw new Error('MAIN_ONE_WAY_MARKER_MISSING');
  if (source.includes('await acceptDispatchHandoff({')) throw new Error('DIRECT_ACCEPT_CALL_REMAINS');
  if (!source.includes("supabase.rpc('create_arka_advance_atomic_v2'")) throw new Error('CANONICAL_ADVANCE_RPC_MISSING');
  fs.writeFileSync(PAGE_PATH, source, 'utf8');
}

function patchDailyRoute() {
  const canonical = `'use client';\n\nimport ArkaDailyCloseWizard from '@/components/ArkaDailyCloseWizard.jsx';\n\nexport default function ArkaDitorePage() {\n  return <ArkaDailyCloseWizard />;\n}\n`;
  fs.writeFileSync(DAILY_PAGE_PATH, canonical, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const installer = 'node tools/apply-arka-daily-close-v2.mjs';
  const pre = String(scripts.prebuild || '').split('&&').map((part) => part.trim()).filter(Boolean).filter((part) => part !== installer);
  pre.push(installer);
  scripts.prebuild = pre.join(' && ');
  scripts['test:arka-daily-close-v2'] = 'node tools/verify-arka-daily-close-v2.mjs';
  const testCommand = 'npm run test:arka-daily-close-v2';
  let build = String(scripts.build || '');
  if (!build.includes(testCommand)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${testCommand} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

function patchBuildIdentity() {
  let vite = fs.readFileSync(VITE_PATH, 'utf8');
  vite = vite.replace(/sw-navigation-diag\.js\?v=\d+/g, 'sw-navigation-diag.js?v=3510');
  vite = vite.replace(/tepiha-vite-business-routes-[^']+/g, `tepiha-vite-business-routes-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-static-assets-[^']+/g, `tepiha-vite-static-assets-${CACHE_VERSION}`);
  vite = vite.replace(/tepiha-vite-media-[^']+/g, `tepiha-vite-media-${CACHE_VERSION}`);
  fs.writeFileSync(VITE_PATH, vite, 'utf8');

  let epoch = fs.readFileSync(EPOCH_PATH, 'utf8');
  epoch = epoch.replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${LEGACY_RUNTIME_VERSION}';`);
  if (/export const ARKA_DAILY_CLOSE_BUILD = '[^']+';/.test(epoch)) {
    epoch = epoch.replace(/export const ARKA_DAILY_CLOSE_BUILD = '[^']+';/, `export const ARKA_DAILY_CLOSE_BUILD = '${APP_VERSION}';`);
  } else {
    epoch = epoch.replace(
      `export const APP_VERSION = '${LEGACY_RUNTIME_VERSION}';`,
      `export const APP_VERSION = '${LEGACY_RUNTIME_VERSION}';\nexport const ARKA_DAILY_CLOSE_BUILD = '${APP_VERSION}';`,
    );
  }
  fs.writeFileSync(EPOCH_PATH, epoch, 'utf8');

  let index = fs.readFileSync(INDEX_PATH, 'utf8');
  index = index.replace(/(<meta name="tepiha-build-id" content=")[^"]+(" \/>)/, `$1${APP_VERSION}$2`);
  index = index.replace(/window\.__TEPIHA_BUILD_ID = '[^']+';/, `window.__TEPIHA_BUILD_ID = '${APP_VERSION}';`);
  fs.writeFileSync(INDEX_PATH, index, 'utf8');
}

patchMainPage();
patchDailyRoute();
patchPackage();
patchBuildIdentity();
console.log('PASS ARKA daily close V2 one-way installer');
