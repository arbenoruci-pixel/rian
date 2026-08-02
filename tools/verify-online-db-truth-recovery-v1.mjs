import fs from 'node:fs';

const source = fs.readFileSync('lib/onlineDbTruthRecovery.js', 'utf8');
const authoritativeSnapshotV2 = source.includes('AUTHORITATIVE_OFFLINE_LISTS_V2:RECOVERY');
const safeSnapshotPolicy = authoritativeSnapshotV2
  ? (
      !source.includes("try { clearPageSnapshot('pastrimi'); } catch {}")
      && !source.includes("try { clearPageSnapshot('gati'); } catch {}")
      && source.includes("preserved: ['pastrimi', 'gati']")
    )
  : (
      source.includes("clearPageSnapshot('pastrimi')")
      && source.includes("clearPageSnapshot('gati')")
    );

const checks = [
  ['complete paginated DB scan', source.includes(".from('orders')") && source.includes('.range(from, to)')],
  ['pending outbox preserved', source.includes('hasPendingMatch(local, pendingTokens)') && source.includes('preservedPending.push(local)')],
  ['authoritative rows hydrate IndexedDB', source.includes('await saveOrderLocal({') && source.includes("table: 'orders'")],
  ['stale aliases removed only after DB scan', source.includes('dbMatch') && source.includes('deleteOrderLocal(localId)')],
  ['page snapshot policy is safe', safeSnapshotPolicy],
  ['cache rebuilt from DB plus pending', source.includes('rebuildBaseMasterCacheFromOrders(rebuiltRows)')],
  ['offline run skipped', source.includes("reason: 'OFFLINE'")],
  ['online/focus/pageshow listeners installed', source.includes("addEventListener('online'") && source.includes("addEventListener('focus'") && source.includes("addEventListener('pageshow'")],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) {
  console.error(`FAIL — ${failed.length} online DB truth recovery checks failed.`);
  process.exit(1);
}
console.log(`PASS — ${checks.length} online DB truth recovery safety checks passed.`);
