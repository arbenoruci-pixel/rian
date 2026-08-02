import fs from 'node:fs';

const targetPath = 'lib/pranimiCodeAllocator.js';
const source = fs.readFileSync(targetPath, 'utf8');

const oldBlock = `    const proof = getAssignmentProof(id);
    if (proof?.offline_bank) {
      return { ok: false, code: candidate, retainBinding: true, offlineBank: true, reason: 'CONSUME_DEFERRED_TO_OUTBOX_SYNC' };
    }

    const result = await db.markUsed?.({ code: candidate, pin: realPin, oid: id, orderId: exactOrderId, clientPhone });`;

const newBlock = `    const proof = getAssignmentProof(id);

    // When the app is online, always let the official DB RPC verify and finalize
    // the exact code/PIN/draft/order tuple. The RPC is idempotent and also returns
    // success when the code was already burned by the server/outbox for the same
    // order. Keeping the old offline-bank early return here caused a real,
    // DB-verified order to remain stuck behind CODE LIFECYCLE NOT CONFIRMED.
    const result = await db.markUsed?.({ code: candidate, pin: realPin, oid: id, orderId: exactOrderId, clientPhone });`;

let next = source;
if (next.includes(oldBlock)) {
  next = next.replace(oldBlock, newBlock);
} else if (!next.includes('Keeping the old offline-bank early return here caused a real,')) {
  throw new Error('PRANIMI_OFFLINE_BANK_CONSUME_PATCH_ANCHOR_NOT_FOUND');
}

const successOld = `    return { ok: true, code: candidate, orderId: exactOrderId, result, awaitingAcknowledgement: true };`;
const successNew = `    return { ok: true, code: candidate, orderId: exactOrderId, result, offlineBank: proof?.offline_bank === true, awaitingAcknowledgement: true };`;

if (next.includes(successOld)) {
  next = next.replace(successOld, successNew);
} else if (!next.includes("offlineBank: proof?.offline_bank === true")) {
  throw new Error('PRANIMI_OFFLINE_BANK_CONSUME_SUCCESS_ANCHOR_NOT_FOUND');
}

if (next !== source) fs.writeFileSync(targetPath, next, 'utf8');

console.log(`[pranimi-offline-bank-consume-v1] ${next === source ? 'already installed' : 'installed'}`);
