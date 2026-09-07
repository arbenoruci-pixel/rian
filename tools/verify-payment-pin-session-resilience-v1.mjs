import fs from 'node:fs';

const source = fs.readFileSync('lib/paymentPin.js', 'utf8');
const session = fs.readFileSync('lib/sessionStore.js', 'utf8');
const aliases = fs.readFileSync('lib/staffIdentityAliases.js', 'utf8');

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

check(source.includes("persistMainSession, readBestActor"), 'payment PIN recovery must persist a repaired main session');
check(source.includes('PAYMENT_PIN_VERIFY_TIMEOUT_MS'), 'PIN verification must have a bounded timeout');
check(source.includes('AbortController'), 'PIN validation fetch must be abortable');
check(source.includes("'PIN_VERIFY_TIMEOUT'"), 'timeout must be distinguishable from invalid PIN');
check(source.includes("'PIN_VERIFY_NETWORK_FAILED'"), 'network failure must be distinguishable from invalid PIN');
check(source.includes('validatePinOnlineWithRetry'), 'missing-session PIN recovery needs one bounded retry');
check(source.includes("source: 'PAYMENT_PIN_SESSION_RECOVERY_V1'"), 'successful recovery must repair canonical session state');
check(source.includes('actorMatchesEnteredPin(actor, pin)'), 'base-terminal transient fallback must require exact current-session PIN');
check(source.includes('validation.transient && actorMatchesEnteredPin(actor, pin)'), 'base-terminal network fallback is not fail-closed to the current actor');
check(source.includes('if (fallbackValidation.transient) showPinNetworkError'), 'worker recovery must show a network-specific error');
check(!source.includes("const res = await fetch('/api/auth/validate-pin', {\n    method: 'POST',\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify({ pin }),\n  });"), 'unbounded legacy validate-pin fetch remains');

check(session.includes('purgeAllSessionsIfRetiredCopyExists'), 'retired-session protection must remain enabled');
check(aliases.includes("'5555': Object.freeze"), 'retired staff PIN denylist must remain intact');
check(aliases.includes("reason: 'RETIRED_PIN_RELOGIN_REQUIRED'"), 'retired credential must still force re-authentication');

if (failures.length) {
  console.error(`FAIL payment PIN session resilience V1: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS payment PIN session resilience V1: bounded PIN verification, safe current-session fallback, and canonical worker-session recovery are present.');
