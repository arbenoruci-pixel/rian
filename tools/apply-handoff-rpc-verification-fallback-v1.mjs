import fs from 'node:fs';

const path = 'lib/corporateFinance.js';
const marker = 'HANDOFF_RPC_VERIFICATION_FALLBACK_V1';
let source = fs.readFileSync(path, 'utf8');

if (source.includes(marker)) {
  console.log('[handoff-rpc-verification-fallback-v1] already installed');
  process.exit(0);
}

const oldBlock = `  const items = Array.isArray(handoff?.cash_handoff_items) ? handoff.cash_handoff_items : [];
  if (!items.length) throw new Error('HANDOFF_ITEMS_EMPTY_AFTER_RPC');`;

const newBlock = `  let items = Array.isArray(handoff?.cash_handoff_items) ? handoff.cash_handoff_items : [];

  // ${marker}
  if (!items.length) {
    const proof = result?.verification || {};
    const proofRows = Array.isArray(proof?.paymentStatuses) ? proof.paymentStatuses : [];
    const proofIds = new Set(
      proofRows
        .map((row) => normalizePendingPaymentId(row?.id || row?.pending_payment_id))
        .filter(Boolean)
        .map(String)
    );
    const proofCount = Number(proof?.itemCount || 0);
    const proofSum = n(proof?.itemSum);
    const proofAmount = n(proof?.handoffAmount ?? handoff?.amount);
    const proofValid = expectedIds.length > 0
      && proofCount === expectedIds.length
      && expectedIds.every((id) => proofIds.has(String(id)))
      && approxEqual(proofSum, proofAmount);

    if (!proofValid) throw new Error('HANDOFF_ITEMS_EMPTY_AFTER_RPC');

    items = expectedIds.map((id, index) => ({
      pending_payment_id: id,
      amount: index === 0 ? proofSum : 0,
      __rpc_verified_only: true,
    }));
  }`;

if (!source.includes(oldBlock)) throw new Error('HANDOFF_EMPTY_BLOCK_NOT_FOUND');
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(path, source, 'utf8');
console.log('[handoff-rpc-verification-fallback-v1] installed');
