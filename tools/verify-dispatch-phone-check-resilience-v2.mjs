import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const dispatch = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
const gatiOwner = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const vite = fs.readFileSync('vite.config.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const prebuildParts = String(pkg.scripts?.prebuild || '').split('&&').map((part) => part.trim()).filter(Boolean);
const buildParts = String(pkg.scripts?.build || '').split('&&').map((part) => part.trim()).filter(Boolean);
const installer = 'node tools/apply-dispatch-phone-check-resilience-v2.mjs';
const finalOwner = 'node tools/apply-gati-rack-save-v1.mjs';

check(dispatch.includes('DISPATCH_PHONE_CHECK_RESILIENCE_V2'), 'resilience marker missing');
check(dispatch.includes('function isTransientDispatchPhoneCheckError'), 'transient classifier missing');
check(dispatch.includes("code === 'DISPATCH_PHONE_CHECK_NETWORK_FAILED'"), 'network failure is not classified');
check(dispatch.includes("code === 'DISPATCH_PHONE_CHECK_TIMEOUT'"), 'timeout is not classified');
check(dispatch.includes('const phoneCheckDegraded = isTransientDispatchPhoneCheckError(phoneCheckError);'), 'degraded state missing');
check(dispatch.includes('&& (!phoneCheckError || phoneCheckDegraded);'), 'create button is still hard-blocked by a transient phone check');
check(!dispatch.includes('&& !phoneCheckError;'), 'strict phone-check gate remains');
check(dispatch.includes('let submitPhoneCheckDegraded = false;'), 'send-time degraded state missing');
check(dispatch.includes('if (!isTransientDispatchPhoneCheckError(submitPhoneCheckError)) throw phoneError;'), 'hard phone-check errors are not kept fail-closed');
check(dispatch.includes('const verifiedPhoneClient = submitPhoneCheckDegraded'), 'degraded send does not re-enable direct DB lookup');
check(dispatch.includes('clientLink.phoneLookupDegraded = true;'), 'degraded audit marker missing');
check(dispatch.includes('SERVERI E VERIFIKON NË RUAJTJE'), 'friendly degraded warning missing');
check(dispatch.includes('I NJËJTI TENTIM NUK E DYFISHON POROSINË'), 'final network retry guidance missing');
check(dispatch.includes('const createResult = await insertTransportOrder'), 'atomic create path missing');
check(dispatch.includes('const deduplicatedActive = createResult?.deduplicatedActive === true;'), 'active-order server dedupe handling missing');

// Nested legacy release installers may rewrite the future owner source after it
// has already generated this build. The built Vite cache identity is authoritative.
check(vite.includes('dispatch-phone-check-resilience-v2'), 'built PWA identity lacks resilience tag');
check(gatiOwner.includes('sw-navigation-diag.js?v=3514'), 'service-worker generation was not bumped');

const installerIndex = prebuildParts.indexOf(installer);
const ownerIndex = prebuildParts.lastIndexOf(finalOwner);
check(installerIndex >= 0, 'installer missing from prebuild');
check(ownerIndex < 0 || installerIndex < ownerIndex, 'installer must run before the compatible final version owner');
check(String(pkg.scripts?.['test:dispatch-phone-check-resilience-v2'] || '').includes('verify-dispatch-phone-check-resilience-v2.mjs'), 'test script missing');
check(buildParts.includes('npm run test:dispatch-phone-check-resilience-v2'), 'verifier missing from build');

if (failures.length) {
  console.error(`FAIL Dispatch phone-check resilience V2: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS Dispatch phone-check resilience V2: transient iPhone/PWA pre-check failures warn instead of blocking, while server create remains atomic and deduplicated.');
