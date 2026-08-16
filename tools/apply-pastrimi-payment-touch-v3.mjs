import fs from 'node:fs';

const PASTRIMI_PATH = 'app/pastrimi/page.jsx';
const POS_PATH = 'components/PosModal.jsx';
const PACKAGE_PATH = 'package.json';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const GATI_VERIFIER_PATH = 'tools/verify-gati-rack-save-v1.mjs';
const ARKA_INSTALLER_PATH = 'tools/apply-arka-daily-close-v2.mjs';
const ARKA_VERIFIER_PATH = 'tools/verify-arka-daily-close-v2.mjs';

const MARKER = 'PASTRIMI_PAYMENT_TOUCH_V3';
const POS_MARKER = 'POS_MODAL_TOUCH_CONFIRM_V3';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3';
const SW_IMPORT_VERSION = '3512';

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
      if (ch === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(`${label}_UNTERMINATED`);
}

function patchPosModal() {
  let source = fs.readFileSync(POS_PATH, 'utf8');

  if (!source.includes(POS_MARKER)) {
    source = source.replace(
      "import React, { useMemo } from 'react';",
      "import React, { useMemo, useRef } from 'react';",
    );

    const oldCalc = `  if (!open) return null;

  const totalN = Number(total || 0);
  const paidN = Number(alreadyPaid || 0);
  const dueNow = useMemo(() => Math.max(0, Number((totalN - paidN).toFixed(2))), [totalN, paidN]);
  const givenN = Number(amount || 0);
  const resto = useMemo(() => Math.max(0, Number((givenN - dueNow).toFixed(2))), [givenN, dueNow]);

  const canConfirm = dueNow <= 0
    ? !disabled
    : (allowPartial ? (givenN > 0 && !disabled) : (givenN >= dueNow && !disabled));`;

    const newCalc = `  // ${POS_MARKER}: iOS/PWA touch fallback plus duplicate-tap guard.
  const confirmGuardRef = useRef(0);
  const totalN = Number(total || 0);
  const paidN = Number(alreadyPaid || 0);
  const dueNow = useMemo(() => Math.max(0, Number((totalN - paidN).toFixed(2))), [totalN, paidN]);
  const givenN = Number(amount || 0);
  const resto = useMemo(() => Math.max(0, Number((givenN - dueNow).toFixed(2))), [givenN, dueNow]);

  const canConfirm = dueNow <= 0
    ? !disabled
    : (allowPartial ? (givenN > 0 && !disabled) : (givenN >= dueNow && !disabled));

  function fireConfirm(source = 'click') {
    if (!canConfirm) return;
    const now = Date.now();
    if (now - Number(confirmGuardRef.current || 0) < 700) return;
    confirmGuardRef.current = now;
    onConfirm?.({ source });
  }

  if (!open) return null;`;

    if (!source.includes(oldCalc)) throw new Error('POS_CONFIRM_CALC_ANCHOR_MISSING');
    source = source.replace(oldCalc, newCalc);

    const oldButton = `        <button
          type="button"
          className="posbtn posbtn--ok"
          onClick={() => onConfirm?.()}
          disabled={!canConfirm}
        >
          {confirmText}
        </button>`;

    const newButton = `        <button
          type="button"
          className="posbtn posbtn--ok"
          data-pos-confirm="1"
          onPointerUp={(event) => {
            const pointerType = String(event?.pointerType || '').toLowerCase();
            if (pointerType === 'touch' || pointerType === 'pen') fireConfirm('pointerup');
          }}
          onTouchEnd={() => fireConfirm('touchend')}
          onClick={() => fireConfirm('click')}
          disabled={!canConfirm}
          aria-busy={disabled}
        >
          {disabled ? 'DUKE RUAJTUR...' : confirmText}
        </button>`;

    if (!source.includes(oldButton)) throw new Error('POS_CONFIRM_BUTTON_ANCHOR_MISSING');
    source = source.replace(oldButton, newButton);

    const oldCss = `        .posbtn--ok {
          flex: 2;
          background: #10b981;
          color: #000;
          border-color: rgba(16,185,129,0.9);
        }`;

    const newCss = `        .posbtn--ok {
          flex: 2;
          background: #10b981;
          color: #000;
          border-color: rgba(16,185,129,0.9);
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        .posbtn:disabled {
          opacity: 0.62;
          cursor: wait;
          filter: saturate(0.45);
        }
        .posbtn--ok:disabled {
          background: #475569;
          color: #e2e8f0;
          border-color: rgba(148,163,184,0.45);
        }`;

    if (!source.includes(oldCss)) throw new Error('POS_CONFIRM_CSS_ANCHOR_MISSING');
    source = source.replace(oldCss, newCss);
  }

  if (!source.includes(POS_MARKER)) throw new Error('POS_TOUCH_MARKER_MISSING');
  if (!source.includes("onPointerUp={(event) =>")) throw new Error('POS_POINTER_FALLBACK_MISSING');
  if (!source.includes("onTouchEnd={() => fireConfirm('touchend')}")) throw new Error('POS_TOUCH_FALLBACK_MISSING');
  if (!source.includes("disabled ? 'DUKE RUAJTUR...' : confirmText")) throw new Error('POS_BUSY_TEXT_MISSING');
  fs.writeFileSync(POS_PATH, source, 'utf8');
}

function patchPastrimi() {
  let source = fs.readFileSync(PASTRIMI_PATH, 'utf8');

  if (!source.includes(MARKER)) {
    const openSignature = '  async function openRowPay(row) {';
    if (!source.includes(openSignature)) throw new Error('PASTRIMI_OPEN_ROW_PAY_MISSING');
    source = source.replace(
      openSignature,
      `  // ${MARKER}: every new payment sheet clears stale busy state.\n${openSignature}`,
    );
  }

  const openStart = source.indexOf('async function openRowPay(row)');
  if (openStart < 0) throw new Error('PASTRIMI_OPEN_ROW_PAY_NOT_FOUND');
  const setOrderAt = source.indexOf('      setRowPayOrder({', openStart);
  if (setOrderAt < 0) throw new Error('PASTRIMI_SET_ROW_PAY_ORDER_MISSING');
  const beforeSetOrder = source.slice(Math.max(openStart, setOrderAt - 160), setOrderAt);
  if (!beforeSetOrder.includes('setRowPayBusy(false);')) {
    source = source.slice(0, setOrderAt) + '      setRowPayBusy(false);\n' + source.slice(setOrderAt);
  }

  if (!source.includes('PASTRIMI_ROW_PAYMENT_TIMEOUT')) {
    const runStart = source.indexOf('    const runPaymentInBackground = async () => {', openStart);
    if (runStart < 0) throw new Error('PASTRIMI_BACKGROUND_PAYMENT_RUN_MISSING');
    const statementNeedle = 'const payRes = await recordOrderCashPayment(';
    const statementStart = source.indexOf(statementNeedle, runStart);
    if (statementStart < 0) throw new Error('PASTRIMI_BACKGROUND_PAYMENT_CALL_MISSING');
    const callNameStart = source.indexOf('recordOrderCashPayment', statementStart);
    const callOpen = source.indexOf('(', callNameStart);
    const callClose = scanBalanced(source, callOpen, '(', ')', 'PASTRIMI_BACKGROUND_PAYMENT_CALL');
    const lineStart = source.lastIndexOf('\n', statementStart) + 1;
    const indent = source.slice(lineStart, statementStart);
    const originalCall = source.slice(callNameStart, callClose + 1);
    const replacement = `const payRes = await withTimeout(\n${indent}  ${originalCall},\n${indent}  15000,\n${indent}  'PASTRIMI_ROW_PAYMENT_TIMEOUT'\n${indent})`;
    source = source.slice(0, statementStart) + replacement + source.slice(callClose + 1);
  }

  if (!source.includes(MARKER)) throw new Error('PASTRIMI_TOUCH_MARKER_MISSING');
  if (!source.includes('PASTRIMI_ROW_PAYMENT_TIMEOUT')) throw new Error('PASTRIMI_PAYMENT_TIMEOUT_MISSING');

  const verifyOpenStart = source.indexOf('async function openRowPay(row)');
  const verifySetOrderAt = source.indexOf('      setRowPayOrder({', verifyOpenStart);
  const verifyResetAt = source.lastIndexOf('setRowPayBusy(false);', verifySetOrderAt);
  if (verifyResetAt < verifyOpenStart || verifyResetAt > verifySetOrderAt) {
    throw new Error('PASTRIMI_STALE_BUSY_RESET_MISSING');
  }

  fs.writeFileSync(PASTRIMI_PATH, source, 'utf8');
}

function patchVersionOwners() {
  let gati = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  gati = gati
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`)
    .replace(/sw-navigation-diag\.js\?v=\d+/g, `sw-navigation-diag.js?v=${SW_IMPORT_VERSION}`)
    .replace(
      "arkaVerify = arkaVerify.replace(/v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2(?:-home-search-base-role-v1)?(?:-gati-rack-save-v1)?/g, CACHE_VERSION);",
      "arkaVerify = arkaVerify.replace(/v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2(?:-home-search-base-role-v1)?(?:-gati-rack-save-v1)?(?:-pastrimi-payment-touch-v3)?/g, CACHE_VERSION);",
    );
  fs.writeFileSync(GATI_INSTALLER_PATH, gati, 'utf8');

  let gatiVerifier = fs.readFileSync(GATI_VERIFIER_PATH, 'utf8');
  gatiVerifier = gatiVerifier
    .replace(/sw-navigation-diag\.js\?v=3511/g, `sw-navigation-diag.js?v=${SW_IMPORT_VERSION}`)
    .replace("check(String(pkg.version || '').includes('gati-rack-save-v1'), 'package build version missing GATI rack suffix');",
      "check(String(pkg.version || '').includes('gati-rack-save-v1-pastrimi-payment-touch-v3'), 'package build version missing GATI rack/payment-touch suffix');");
  fs.writeFileSync(GATI_VERIFIER_PATH, gatiVerifier, 'utf8');

  let arkaInstaller = fs.readFileSync(ARKA_INSTALLER_PATH, 'utf8');
  arkaInstaller = arkaInstaller
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);
  fs.writeFileSync(ARKA_INSTALLER_PATH, arkaInstaller, 'utf8');

  let arkaVerifier = fs.readFileSync(ARKA_VERIFIER_PATH, 'utf8');
  arkaVerifier = arkaVerifier
    .replace(/v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1(?:-pastrimi-payment-touch-v3)?/g, CACHE_VERSION)
    .replace(/sw-navigation-diag\.js\?v=3511/g, `sw-navigation-diag.js?v=${SW_IMPORT_VERSION}`);
  fs.writeFileSync(ARKA_VERIFIER_PATH, arkaVerifier, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const installer = 'node tools/apply-pastrimi-payment-touch-v3.mjs';
  const arkaInstaller = 'node tools/apply-arka-daily-close-v2.mjs';
  const gatiInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
  const pre = String(scripts.prebuild || '')
    .split('&&')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== installer && item !== arkaInstaller && item !== gatiInstaller);
  pre.push(installer, arkaInstaller, gatiInstaller);
  scripts.prebuild = pre.join(' && ');
  scripts['test:pastrimi-payment-touch-v3'] = 'node tools/verify-pastrimi-payment-touch-v3.mjs';

  const testCommand = 'npm run test:pastrimi-payment-touch-v3';
  let build = String(scripts.build || '');
  if (!build.includes(testCommand)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${testCommand} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

patchPosModal();
patchPastrimi();
patchVersionOwners();
patchPackage();
console.log('PASS Pastrimi payment touch V3: stale busy reset, iOS pointer/touch fallback, visible busy state, bounded payment wait and combined PWA version owner.');
