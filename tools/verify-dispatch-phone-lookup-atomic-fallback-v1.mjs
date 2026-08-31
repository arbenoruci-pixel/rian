import fs from 'node:fs';

const dispatch = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
const db = fs.readFileSync('lib/transport/transportDb.js', 'utf8');
const failures = [];
const check = (ok, label) => { if (!ok) failures.push(label); };

const dispatchStart = dispatch.indexOf('async function prepareDispatchTransportClientLink');
const dispatchEnd = dispatch.indexOf('\n\nfunction dispatchSafePhoneMatch', dispatchStart);
const dispatchBlock = dispatchStart >= 0 && dispatchEnd > dispatchStart ? dispatch.slice(dispatchStart, dispatchEnd) : '';

const insertStart = db.indexOf('export async function insertTransportOrder');
const insertEnd = db.indexOf('\n\nexport function saveOfflineTransportOrder', insertStart);
const insertBlock = insertStart >= 0 && insertEnd > insertStart ? db.slice(insertStart, insertEnd) : '';

check(dispatchBlock.includes('DISPATCH_PHONE_LOOKUP_ATOMIC_FALLBACK_V1'), 'dispatch fallback marker');
check(dispatchBlock.includes('cachedExactClient'), 'exact cached phone fallback');
check(dispatchBlock.includes('phoneLookupDegraded'), 'dispatch degraded audit flag');
check(!dispatchBlock.includes('throw new Error(`NUK U VERIFIKUA KLIENTI ME TELEFON'), 'dispatch no longer hard-fails before atomic RPC');
check(dispatch.includes('dispatch_phone_lookup_degraded'), 'dispatch payload audit marker');
check(!dispatchBlock.includes('reserveTransportCode'), 'Dispatch new-client pre-reservation removed');
check(dispatchBlock.includes('atomicDbTcodeAllocation'), 'Dispatch marks DB-atomic T-code allocation');
check(dispatch.includes('releaseTransportCodeIfUnused'), 'Dispatch cleanup preserved');

check(insertBlock.includes('DISPATCH_PHONE_LOOKUP_ATOMIC_FALLBACK_V1'), 'transport insert fallback marker');
check(insertBlock.includes("createdByRole === 'DISPATCH'"), 'fallback limited to Dispatch');
check(insertBlock.includes('if (!allowAtomicDispatchFallback)'), 'non-Dispatch strict lookup preserved');
check(insertBlock.includes('TRANSPORT_CLIENT_FINAL_LOOKUP_FAILED'), 'strict error preserved for other callers');
check(insertBlock.includes("supabase.rpc('create_transport_order'"), 'atomic create RPC preserved');
check(insertBlock.includes('assertAtomicTransportOrder'), 'post-create identity verification preserved');
check(insertBlock.includes('needsCodeReconcile'), 'permanent code reconciliation present');
check(insertBlock.includes('code_n: Number(dbPermanentTcode'), 'code_n canonicalization present');
check(insertBlock.includes('data: canonicalData'), 'JSON code aliases canonicalized');
check(insertBlock.includes('releaseTransportCodeIfUnused(requestedCode'), 'superseded code release preserved');
check(insertBlock.includes('transport_phone_lookup_degraded'), 'DB row audit marker present');

if (failures.length) {
  console.error(`FAIL: ${failures.length} Dispatch phone fallback check(s) failed.`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}
console.log('PASS: Dispatch survives transient phone lookup failure through the existing atomic DB create path, while non-Dispatch callers stay strict.');
