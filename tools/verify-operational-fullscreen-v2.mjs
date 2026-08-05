import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

const appRoot = read('src/AppRoot.jsx');
const globals = read('app/globals.css');
const pkg = JSON.parse(read('package.json'));

const checks = [
  ['component marker', appRoot.includes('OPERATIONAL_FULLSCREEN_V2_COMPONENT')],
  ['route flag mounted', appRoot.includes('<OperationalFullscreenRouteFlag />')],
  ['route page marker', appRoot.includes('data-tepiha-route-page')],
  ['route layout marker', appRoot.includes('data-tepiha-route-layout')],
  ['route wide marker', appRoot.includes('data-tepiha-route-wide')],
  ['css marker', globals.includes('OPERATIONAL_FULLSCREEN_V2_CSS')],
  ['full width css', globals.includes('width: 100% !important')],
  ['safe left gutter', globals.includes('safe-area-inset-left')],
  ['safe right gutter', globals.includes('safe-area-inset-right')],
  ['arka shell reset', globals.includes('.arka-shell') && globals.includes('.arka-container')],
  ['prebuild installer', String(pkg?.scripts?.prebuild || '').includes('apply-operational-fullscreen-v2.mjs')],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

if (failed.length) {
  throw new Error(`OPERATIONAL_FULLSCREEN_V2_VERIFY_FAILED: ${failed.map(([name]) => name).join(', ')}`);
}

console.log(`OPERATIONAL_FULLSCREEN_V2_VERIFY_OK ${checks.length}`);
