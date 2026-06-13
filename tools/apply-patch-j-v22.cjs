#!/usr/bin/env node
const fs = require('fs');

const VERSION = '2.0.27-vite-pastrimi-preload-nonfatal-v22';
const EPOCH = 'RESET-2026-04-26-VITE-PASTRIMI-PRELOAD-NONFATAL-V22';
const OLD_VERSION_RE = /2\.0\.26-vite-static-runtime-v21/g;
const OLD_EPOCH_RE = /RESET-2026-04-26-VITE-STATIC-RUNTIME-V21/g;

function exists(file) { return fs.existsSync(file); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, text) { fs.writeFileSync(file, text, 'utf8'); }

function replaceAll(file, pairs) {
  if (!exists(file)) return false;
  let s = read(file);
  const before = s;
  for (const [from, to] of pairs) s = s.replace(from, to);
  if (s !== before) write(file, s);
  return s !== before;
}

function patchPackageJson() {
  const file = 'package.json';
  if (!exists(file)) return false;
  const json = JSON.parse(read(file));
  json.version = VERSION;
  write(file, `${JSON.stringify(json, null, 2)}\n`);
  return true;
}

function patchAppEpoch() {
  const file = 'lib/appEpoch.js';
  if (!exists(file)) return false;
  write(file, `export const APP_DATA_EPOCH = '${EPOCH}';\n\nexport const APP_VERSION = '${VERSION}';\n`);
  return true;
}

function patchIndexHtml() {
  const file = 'index.html';
  return replaceAll(file, [
    [OLD_VERSION_RE, VERSION],
    [OLD_EPOCH_RE, EPOCH],
    [/index-html-vite-static-runtime-v21/g, 'index-html-vite-pastrimi-preload-nonfatal-v22'],
    [/pwa-boot-rescue-vite-static-runtime-v21/g, 'pwa-boot-rescue-vite-pastrimi-preload-nonfatal-v22'],
    [/PWA RESCUE V17/g, 'PWA RESCUE V17 • PRELOAD NONFATAL V22'],
  ]);
}

function neutralizeFatalCacheHeal() {
  const file = 'app/pastrimi/page.jsx';
  if (!exists(file)) return false;
  let s = read(file);
  if (!/function\s+triggerFatalCacheHeal\s*\(/.test(s)) return false;

  const replacement = `function triggerFatalCacheHeal(reason) {\n  try { console.warn('[PASTRIMI] triggerFatalCacheHeal neutralized diagnostic-only', reason || 'unknown'); } catch {}\n  try {\n    if (typeof window !== 'undefined') {\n      window.__TEPIHA_PASTRIMI_FATAL_CACHE_HEAL_NEUTRALIZED__ = {\n        at: new Date().toISOString(),\n        reason: String(reason || 'unknown'),\n        scope: 'diagnostic_only_no_delete_no_reload_no_sw_unreg',\n      };\n    }\n  } catch {}\n  return false;\n}`;

  const before = s;
  s = s.replace(/function\s+triggerFatalCacheHeal\s*\([^)]*\)\s*\{[\s\S]*?\n\}/, replacement);
  if (s !== before) write(file, s);

  const dangerous = [
    /triggerFatalCacheHeal[\s\S]{0,900}localStorage\.removeItem\(['"]tepiha_local_orders_v1['"]\)/,
    /triggerFatalCacheHeal[\s\S]{0,900}localStorage\.removeItem\(['"]tepiha_offline_queue_v1['"]\)/,
    /triggerFatalCacheHeal[\s\S]{0,900}indexedDB\.deleteDatabase\(/,
    /triggerFatalCacheHeal[\s\S]{0,900}serviceWorker[\s\S]{0,160}unregister\(/,
    /triggerFatalCacheHeal[\s\S]{0,900}window\.location\.(?:reload|replace)\(/,
  ];
  const after = read(file);
  for (const rx of dangerous) {
    if (rx.test(after)) {
      throw new Error(`Dangerous cache-heal behavior still detected near triggerFatalCacheHeal in ${file}: ${rx}`);
    }
  }
  return s !== before;
}

function main() {
  const changed = [];
  if (patchPackageJson()) changed.push('package.json version');
  if (patchAppEpoch()) changed.push('lib/appEpoch.js epoch/version');
  if (patchIndexHtml()) changed.push('index.html build markers');
  if (neutralizeFatalCacheHeal()) changed.push('app/pastrimi/page.jsx triggerFatalCacheHeal neutralized');

  console.log('[PATCH J V22] Applied safely.');
  console.log('[PATCH J V22] Changed:', changed.length ? changed.join(', ') : 'nothing extra needed');
  console.log('[PATCH J V22] Scope: diagnostics/runtime only; no DB/orders/outbox/payment/status changes.');
}

main();
