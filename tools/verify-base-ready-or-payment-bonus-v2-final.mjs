import fs from 'node:fs';

const engine = fs.readFileSync('lib/arka/arkaEngine.js', 'utf8');
const payService = fs.readFileSync('components/payments/payService.js', 'utf8');
const liveCard = fs.readFileSync('components/ReadyBonusLiveCard.jsx', 'utf8');
const bonusPage = fs.readFileSync('app/arka/bonuset/page.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(engine.includes('BASE_READY_OR_PAYMENT_BONUS_V2_FINAL:ENGINE'), 'Payment bonus engine marker missing');
check(engine.includes("sb.rpc('award_base_ready_bonus_from_payment_v2'"), 'Verified BASE payment does not call the DB award function');
check(engine.includes('p_payment_id: normalizeDbId(verifiedPayment?.id)'), 'Verified payment ID is not bound to the award');
check(engine.includes('p_actor_pin: actor.pin'), 'Payment actor PIN is not bound to the award');
check(engine.includes('readyBonusAwarded'), 'Payment result does not expose awarded bonus state');
check(engine.includes('readyBonusAlreadyApplied'), 'One-bonus-per-order result state missing');
check(engine.includes('Payment remains authoritative'), 'Payment safety fallback missing');

check(payService.includes('BASE_READY_OR_PAYMENT_BONUS_V2_FINAL:PAY_SERVICE'), 'Payment service marker missing');
check(payService.includes('describeBasePaymentReadyBonus'), 'Payment bonus message helper missing');
check(payService.includes("new CustomEvent('arka:ready-bonus-payment'"), 'Live payment bonus event missing');
check(payService.includes('bonusMessage:'), 'Payment result bonus message missing');

check(liveCard.includes('GATI ose PAGESË E PLOTË brenda 48 orëve'), 'Live card still describes GATI-only policy');
check(bonusPage.includes('GATI ose PAGESË E PLOTË'), 'Bonus page still describes GATI-only qualification');
check(bonusPage.includes('veprimit të parë kualifikues'), 'First qualifying action ownership text missing');
check(bonusPage.includes('pagesën e plotë'), 'Full-payment qualification explanation missing');

// Policy model: one order has one unique bonus; the first verified qualifying
// event wins. A partial payment cannot claim the completion bonus.
function qualification({ hours, fullPayment, existingBonus, event }) {
  if (existingBonus) return 'ALREADY_APPLIED';
  if (hours < 0 || hours > 48) return 'OVER_48_HOURS';
  if (event === 'PAYMENT' && !fullPayment) return 'PARTIAL_PAYMENT';
  return event === 'PAYMENT' ? 'PAYMENT' : 'GATI';
}

check(qualification({ hours: 12, fullPayment: true, existingBonus: false, event: 'PAYMENT' }) === 'PAYMENT', 'Full payment inside 48h must qualify');
check(qualification({ hours: 12, fullPayment: false, existingBonus: false, event: 'PAYMENT' }) === 'PARTIAL_PAYMENT', 'Partial payment must not claim completion bonus');
check(qualification({ hours: 48, fullPayment: true, existingBonus: false, event: 'PAYMENT' }) === 'PAYMENT', 'Exactly 48h payment must qualify');
check(qualification({ hours: 48.01, fullPayment: true, existingBonus: false, event: 'PAYMENT' }) === 'OVER_48_HOURS', 'Payment after 48h must not qualify');
check(qualification({ hours: 20, fullPayment: true, existingBonus: true, event: 'PAYMENT' }) === 'ALREADY_APPLIED', 'Existing GATI bonus must prevent a second payment bonus');
check(qualification({ hours: 20, fullPayment: true, existingBonus: true, event: 'GATI' }) === 'ALREADY_APPLIED', 'Existing payment bonus must prevent a second GATI bonus');

if (failures.length) {
  console.error(`FAIL: ${failures.length} ready-or-payment bonus check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: ready-or-payment 48h bonus v2 final checks passed.');
