import fs from 'node:fs';

const TAG = 'dispatch-boss-fixed-phone-v2';
const MARKER = 'DISPATCH_BOSS_FIXED_PHONE_V2';

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_MISSING`);
  return source.replace(from, to);
}

function appendTag(value) {
  const text = String(value || '').trim();
  return text.includes(TAG) ? text : `${text}-${TAG}`;
}

// Run the established Boss patch first. This remains idempotent inside one build.
await import('./apply-dispatch-boss-controls-v1.mjs');

{
  const path = 'lib/transport/dispatchOrderServer.js';
  let source = fs.readFileSync(path, 'utf8');
  if (!source.includes(MARKER)) {
    source = replaceRequired(
      source,
      "  const permanentTcode = normalizeTransportTCodeServer(currentClient.tcode || '');\n  if (!permanentTcode) fail('DISPATCH_CLIENT_TCODE_MISSING', 409);",
      "  const permanentTcode = normalizeTransportTCodeServer(currentClient.tcode || '');\n  if (!permanentTcode) fail('DISPATCH_CLIENT_TCODE_MISSING', 409);\n  // DISPATCH_BOSS_FIXED_PHONE_V2: client phone is the permanent identity key.\n  const currentPhoneKey = normalizeTransportPhoneKeyServer(currentClient.phone_digits || currentClient.phone || '');\n  if (!isValidTransportPhoneServer(currentPhoneKey)) fail('DISPATCH_CLIENT_PHONE_INVALID', 409);\n  if (phoneKey !== currentPhoneKey) fail('DISPATCH_PHONE_CHANGE_NOT_ALLOWED', 409);",
      'SERVER_FIXED_PHONE_GUARD',
    );
    source = replaceRequired(
      source,
      "        fields: ['name', 'phone', 'address'],",
      "        fields: ['name', 'address'],\n        phone_locked: true,\n        policy: '${MARKER}',",
      'SERVER_AUDIT_FIELDS',
    );
    fs.writeFileSync(path, source, 'utf8');
  }
}

{
  const path = 'app/dispatch/page.jsx';
  let source = fs.readFileSync(path, 'utf8');
  if (!source.includes(MARKER)) {
    source = replaceRequired(
      source,
      '              <div style={ui.sectionHint}>Ky Dispatch ka të drejta operative admin. T-code mbetet permanent. Emri, telefoni dhe adresa ruhen në klient dhe në këtë vizitë.</div>',
      `              <div style={ui.sectionHint}>Ky Dispatch ka të drejta operative admin. T-code dhe numri i telefonit mbesin të njëjtë. Mundesh me ndërru emrin dhe adresën.</div>`,
      'PAGE_HINT',
    );
    source = replaceRequired(
      source,
      '                  <div style={ui.label}>TELEFONI</div>\n                  <input style={ui.input} value={editClientPhone} onChange={(e) => setEditClientPhone(e.target.value)} inputMode="tel" placeholder="+383..." />',
      `                  <div style={ui.label}>TELEFONI — MBETET I NJËJTË</div>\n                  <input style={{ ...ui.input, opacity: 0.72 }} value={editClientPhone} readOnly aria-readonly="true" inputMode="tel" />\n                  <div style={ui.sectionHint}>${MARKER}: numri është identiteti i klientit dhe nuk ndryshohet prej këtij editimi.</div>`,
      'PAGE_PHONE_LOCK',
    );
    fs.writeFileSync(path, source, 'utf8');
  }
}

{
  const pkgPath = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = appendTag(pkg.version);
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  let epoch = fs.readFileSync('lib/appEpoch.js', 'utf8');
  epoch = epoch.replace(/(export const APP_VERSION = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  epoch = epoch.replace(/(export const GATI_RACK_SAVE_BUILD = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  fs.writeFileSync('lib/appEpoch.js', epoch, 'utf8');

  let index = fs.readFileSync('index.html', 'utf8');
  index = index.replace(/(<meta name="tepiha-build-id" content=")([^"]+)(" \/>)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  index = index.replace(/(window\.__TEPIHA_BUILD_ID = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  fs.writeFileSync('index.html', index, 'utf8');

  let sw = fs.readFileSync('public/sw.js', 'utf8');
  sw = sw.replace(/(const APP_VERSION = ')([^']+)(';)/, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  fs.writeFileSync('public/sw.js', sw, 'utf8');

  let vite = fs.readFileSync('vite.config.js', 'utf8');
  vite = vite.replace(/(cacheName:\s*'tepiha-vite-(?:business-routes|static-assets|media)-)([^']+)(')/g, (_all, before, value, after) => `${before}${appendTag(value)}${after}`);
  fs.writeFileSync('vite.config.js', vite, 'utf8');
}

const server = fs.readFileSync('lib/transport/dispatchOrderServer.js', 'utf8');
const page = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
if (!server.includes('DISPATCH_PHONE_CHANGE_NOT_ALLOWED')) throw new Error('FIXED_PHONE_SERVER_GUARD_MISSING');
if (!page.includes('TELEFONI — MBETET I NJËJTË')) throw new Error('FIXED_PHONE_UI_LOCK_MISSING');
console.log('PASS Dispatch Boss fixed-phone V2: name/address editable; phone and permanent T-code remain unchanged.');
