import fs from 'node:fs';
import { isPranimiDraftFlaggedData } from '../lib/pranimiOrderLifecycle.js';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const gati = fs.readFileSync('app/gati/page.jsx', 'utf8');
const lifecycle = fs.readFileSync('lib/pranimiOrderLifecycle.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const epoch = fs.readFileSync('lib/appEpoch.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const arkaInstaller = fs.readFileSync('tools/apply-arka-daily-close-v2.mjs', 'utf8');
const arkaVerify = fs.readFileSync('tools/verify-arka-daily-close-v2.mjs', 'utf8');

const staleFinalizedFixture = {
  status: 'gati',
  state: 'gati',
  source: 'DB_FINAL',
  pranimi_draft_source: 'FINAL / CLEANED',
  pranimi_db_draft: false,
  is_pranimi_incomplete_draft: false,
  local_sync_status: 'DB_VERIFIED',
  pranimi_code_lifecycle: {
    db_draft: false,
    db_draft_status: 'finalized',
    db_verify_state: 'DB_VERIFIED',
  },
  draft_lifecycle: {
    db_draft: true,
    db_draft_status: 'finalized',
  },
};

const realDraftFixture = {
  status: 'pranim',
  state: 'pranim',
  source: 'DB_DRAFT',
  pranimi_db_draft: true,
  draft_lifecycle: {
    db_draft: true,
    db_draft_status: 'incomplete',
  },
};

check(isPranimiDraftFlaggedData(staleFinalizedFixture) === false, 'stale finalized draft flag still blocks a valid GATI write');
check(isPranimiDraftFlaggedData(realDraftFixture) === true, 'real draft is no longer protected');

check(gati.includes('GATI_RACK_SAVE_V1'), 'GATI rack-save marker missing');
check(gati.includes("supabase.rpc('save_base_order_rack_location_v1'"), 'canonical rack-save RPC missing');
check(gati.includes('RACK_SAVE_DB_VERIFICATION_FAILED'), 'DB round-trip verification missing');
check(gati.includes("queueOp('patch_order_data'"), 'offline durable queue fallback missing');
check(gati.includes('draft_lifecycle: cleanDraftLifecycle'), 'offline stale lifecycle cleanup missing');
check(gati.includes("setPlaceErr('Nuk u ruajt në databazë. '"), 'visible rack-save error missing');
check(gati.includes('closePlaceCard();'), 'successful rack save does not close the modal');
check(lifecycle.includes('staleFinalizedFlag'), 'stale finalized lifecycle guard missing');
check(lifecycle.includes('isPranimiFinalOrderStatus(operationalStatus)'), 'final operational status is not part of lifecycle decision');

const prebuild = String(pkg.scripts?.prebuild || '');
check(prebuild.trim().endsWith('node tools/apply-gati-rack-save-v1.mjs'), 'GATI rack installer is not last in prebuild');
check(String(pkg.scripts?.build || '').includes('npm run test:gati-rack-save-v1'), 'GATI rack verifier is absent from full build');
check(String(pkg.scripts?.['test:gati-rack-save-v1'] || '').includes('verify-gati-rack-save-v1.mjs'), 'GATI rack test script missing');
check(String(pkg.version || '').includes('gati-rack-save-v1-pastrimi-payment-touch-v3'), 'package build version missing GATI rack/payment-touch suffix');
check(vite.includes('gati-rack-save-v1'), 'PWA cache generation was not bumped');
check(/sw-navigation-diag\.js\?v=351[2-9]/.test(vite), 'service-worker import generation was not bumped');
check(epoch.includes('GATI_RACK_SAVE_BUILD'), 'runtime rack build marker missing');
check(index.includes('gati-rack-save-v1'), 'HTML build id missing rack-save suffix');
check(arkaInstaller.includes('gati-rack-save-v1'), 'final ARKA installer can overwrite rack build version');
check(arkaVerify.includes('gati-rack-save-v1'), 'ARKA verifier does not accept rack build cache generation');

if (failures.length) {
  console.error(`FAIL GATI rack save V1: ${failures.length} check(s)`);
  failures.forEach((failure, indexValue) => console.error(`${indexValue + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS GATI rack save V1: finalized historical rows remain writable, true drafts stay blocked, rack writes use one verified RPC, offline payloads are clean, and the PWA build is bumped.');
