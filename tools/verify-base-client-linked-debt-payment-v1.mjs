import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  allocateBaseClientLinkedDebt,
  buildBaseClientDebtSnapshotToken,
  buildBaseClientLinkedDebtPlan,
  resolveBaseVisitMoney,
  serializeBaseClientDebtSnapshot,
} from '../lib/baseClientLinkedDebt.js';
import { buildPastrimiPaymentDecision, PASTRIMI_PAYMENT_PURPOSE } from '../lib/pastrimiPaymentPurpose.js';
import {
  authorizeCommittedBaseBatchRetry,
  isExactCommittedBaseBatchRetry,
  safeError,
} from '../api/arka/transaction.js';

const clientId = 'b91e5f02-205f-4f85-b38c-22c2238367c1';
const otherClientId = '22222222-2222-4222-8222-222222222222';

const paidJuly = resolveBaseVisitMoney({
  id: 2437,
  price_total: 25.87,
  paid: 0,
  paid_cash: 0,
  data: {
    clientPaid: 25.87,
    debt: 0,
    pay: { euro: 25.87, paid: 25.87, arkaRecordedPaid: 25.87, debt: 0 },
  },
});
assert.deepEqual(
  { total: paidJuly.total, paid: paidJuly.paid, debt: paidJuly.debt },
  { total: 25.87, paid: 25.87, debt: 0 },
  'zero top-level shadows must not recreate the paid July debt',
);

const current = {
  id: '3163', source: 'BASE', clientId, status: 'pastrim', createdAt: '2026-08-29T07:55:51.704Z',
  total: 3.77, paid: 0, debt: 3.77, code: '382',
};
const plan = buildBaseClientLinkedDebtPlan({
  currentOrderId: '3163',
  currentClientId: clientId,
  profileClientId: clientId,
  currentVisit: current,
  visits: [
    current,
    { id: '3128', source: 'BASE', clientId, status: 'dorzim', createdAt: '2026-08-25T16:24:15.546Z', total: 5.85, paid: 0, debt: 5.85, code: '382' },
    { id: '2437', source: 'BASE', clientId, status: 'dorzim', createdAt: '2026-07-04T14:47:45.778Z', total: 25.87, paid: 25.87, debt: 0, code: '382' },
    { id: '9999', source: 'BASE', clientId: otherClientId, status: 'dorzim', createdAt: '2026-08-20T10:00:00Z', total: 9.62, paid: 0, debt: 9.62, code: '382' },
    { id: '8888', source: 'TRANSPORT', clientId, status: 'dorzim', createdAt: '2026-08-21T10:00:00Z', total: 5, paid: 0, debt: 5, code: 'T382' },
  ],
});

assert.equal(plan.ok, true);
assert.equal(plan.total, 9.62, '3.77 + 5.85 must equal exactly 9.62 in cents');
assert.deepEqual(plan.items.map((item) => item.orderId), ['3128', '3163'], 'only canonical unpaid BASE visits enter the plan, FIFO');
assert.deepEqual(serializeBaseClientDebtSnapshot(plan.items), [
  { orderId: '3128', debt: 5.85 },
  { orderId: '3163', debt: 3.77 },
]);
assert.equal(
  buildBaseClientDebtSnapshotToken(plan.items),
  buildBaseClientDebtSnapshotToken([...plan.items].reverse()),
  'idempotency snapshot token is canonical and deterministic',
);

const partial = allocateBaseClientLinkedDebt(plan.items, 6);
assert.deepEqual(partial.allocations.map(({ orderId, amount, debtAfter }) => ({ orderId, amount, debtAfter })), [
  { orderId: '3128', amount: 5.85, debtAfter: 0 },
  { orderId: '3163', amount: 0.15, debtAfter: 3.62 },
], 'partial payment must close the oldest visit first');

const shortPickup = buildPastrimiPaymentDecision({ due: plan.total, cashGiven: 9.61, purpose: PASTRIMI_PAYMENT_PURPOSE.PICKUP_NOW });
const fullPickup = buildPastrimiPaymentDecision({ due: plan.total, cashGiven: 9.62, purpose: PASTRIMI_PAYMENT_PURPOSE.PICKUP_NOW });
assert.equal(shortPickup.error, 'PICKUP_REQUIRES_FULL_PAYMENT');
assert.equal(fullPickup.ok, true);
assert.equal(fullPickup.remaining, 0);

const identityConflict = buildBaseClientLinkedDebtPlan({
  currentOrderId: '3163', currentClientId: clientId, profileClientId: otherClientId, currentVisit: current, visits: [current],
});
assert.equal(identityConflict.ok, false, 'profile/client identity mismatch must fail closed');

const paidCurrent = { ...current, paid: 3.77, debt: 0 };
const historicalOnly = buildBaseClientLinkedDebtPlan({
  currentOrderId: '3163',
  currentClientId: clientId,
  profileClientId: clientId,
  currentVisit: paidCurrent,
  visits: [
    paidCurrent,
    { id: '3128', source: 'BASE', clientId, status: 'dorzim', createdAt: '2026-08-25T16:24:15.546Z', total: 5.85, paid: 0, debt: 5.85, code: '382' },
  ],
});
assert.equal(historicalOnly.ok, true, 'a paid current anchor may carry one older canonical debt');
assert.equal(historicalOnly.current.debt, 0);
assert.equal(historicalOnly.total, 5.85);
assert.equal(historicalOnly.linked, true);
assert.deepEqual(serializeBaseClientDebtSnapshot(historicalOnly.items), [{ orderId: '3128', debt: 5.85 }]);
assert.deepEqual(allocateBaseClientLinkedDebt(historicalOnly.items, 1).allocations, [{
  orderId: '3128', amount: 1, amountCents: 100, debtBefore: 5.85, debtAfter: 4.85, current: false,
}], 'historical-only partial payment must not rewrite the paid anchor');

const nestedLegacy = resolveBaseVisitMoney({
  id: 7000,
  data: { data: { pay: { euro: 5.85, paid: 1, debt: 4.85 }, debt: 4.85 } },
});
assert.deepEqual(
  { total: nestedLegacy.total, paid: nestedLegacy.paid, debt: nestedLegacy.debt },
  { total: 5.85, paid: 1, debt: 4.85 },
  'nested legacy data must resolve the reduced balance on the next read',
);

const explicitDebtOnly = resolveBaseVisitMoney({ id: 7001, data: { debt: 5.85 } });
assert.equal(explicitDebtOnly.debt, 5.85);
assert.equal(allocateBaseClientLinkedDebt([{ orderId: '7001', debt: explicitDebtOnly.debt }], 1).allocations[0].debtAfter, 4.85);

assert.equal(
  safeError(new Error('BASE_CLIENT_PAYMENT_STALE_DEBT expected=[{"orderId":3128}] actual=[]')),
  'BASE_CLIENT_PAYMENT_STALE_DEBT',
  'HTTP error handling must preserve the leading terminal SQL domain code without leaking diagnostics',
);
assert.equal(
  safeError(new Error('database connection failed for private host')),
  'ARKA_TRANSACTION_FAILED',
  'arbitrary server diagnostics must remain private',
);

const retryBody = {
  action: 'BASE_ORDER_PAYMENT',
  actorPin: '5555',
  orderId: '3163',
  clientId,
  amount: 9.62,
  cashGiven: 9.62,
  changeAmount: 0,
  expectedDebt: 9.62,
  linkedDebts: [
    { orderId: '3128', debt: 5.85 },
    { orderId: '3163', debt: 3.77 },
  ],
  paymentOutcome: 'CLIENT_PICKED_UP_TO_DORZIM',
  statusOnFullPayment: 'dorzim',
  method: 'CASH',
  note: 'PAGESË NË PASTRIMI 9.62€',
  idempotencyKey: 'BASE_ORDER_PAYMENT:client:snapshot:9.62:5555:pickup',
};
const committedBatch = {
  id: '1b6afcaf-20ba-4d64-9e21-8f7cfed8fdaf',
  client_id: clientId,
  anchor_order_id: 3163,
  amount_given: '9.62',
  amount_applied: '9.62',
  change_amount: '0.00',
  expected_total_debt: '9.62',
  expected_order_debts: [
    { debt: 3.77, orderId: 3163 },
    { debt: 5.85, orderId: 3128 },
  ],
  payment_outcome: 'CLIENT_PICKED_UP_TO_DORZIM',
  status: 'CONFIRMED',
  created_by_pin: '5555',
  note: retryBody.note,
  idempotency_key: retryBody.idempotencyKey,
};
assert.equal(
  isExactCommittedBaseBatchRetry(retryBody, committedBatch),
  true,
  'an exact committed retry remains authorized after actor/session lifecycle changes',
);
for (const [label, mutatedBody] of [
  ['actor pin', { ...retryBody, actorPin: '7777' }],
  ['amount', { ...retryBody, amount: 9.61 }],
  ['client', { ...retryBody, clientId: otherClientId }],
  ['snapshot', { ...retryBody, linkedDebts: [{ orderId: '3163', debt: 9.62 }] }],
  ['outcome', { ...retryBody, paymentOutcome: 'PREPAY_STAYS_PASTRIMI', statusOnFullPayment: 'pastrim' }],
  ['idempotency', { ...retryBody, idempotencyKey: `${retryBody.idempotencyKey}:changed` }],
  ['note', { ...retryBody, note: `${retryBody.note} changed` }],
]) {
  assert.equal(
    isExactCommittedBaseBatchRetry(mutatedBody, committedBatch),
    false,
    `committed retry must fail closed when ${label} changes`,
  );
}
assert.equal(
  isExactCommittedBaseBatchRetry(retryBody, { ...committedBatch, status: 'VOIDED' }),
  false,
  'only a confirmed batch may use the lifecycle retry exception',
);
const retryLookupTrace = [];
const retrySupabase = {
  from(table) {
    retryLookupTrace.push(['from', table]);
    return {
      select(columns) {
        retryLookupTrace.push(['select', columns]);
        return this;
      },
      eq(column, value) {
        retryLookupTrace.push(['eq', column, value]);
        return this;
      },
      async maybeSingle() {
        retryLookupTrace.push(['maybeSingle']);
        return { data: committedBatch, error: null };
      },
    };
  },
};
const retryAuthorization = await authorizeCommittedBaseBatchRetry(
  retrySupabase,
  retryBody,
  { deviceApproved: true },
);
assert.equal(retryAuthorization?.batchId, committedBatch.id);
assert.equal(retryAuthorization?.actor?.pin, committedBatch.created_by_pin);
assert.deepEqual(
  retryLookupTrace.filter(([kind]) => kind === 'from' || kind === 'eq'),
  [
    ['from', 'base_payment_batches'],
    ['eq', 'idempotency_key', retryBody.idempotencyKey],
  ],
  'lifecycle exception must resolve one existing batch by the exact idempotency key',
);
assert.equal(
  await authorizeCommittedBaseBatchRetry(retrySupabase, retryBody, { deviceApproved: false }),
  null,
  'an unapproved device must never reach the committed retry lookup',
);
const explicitDebtOnlyApplied = 1;
const explicitDebtOnlyEffectiveTotal = Number(Math.max(
  explicitDebtOnly.total,
  explicitDebtOnly.paid + explicitDebtOnly.debt,
).toFixed(2));
const explicitDebtOnlyOptimisticDebt = Number((explicitDebtOnly.debt - explicitDebtOnlyApplied).toFixed(2));
assert.equal(explicitDebtOnlyEffectiveTotal, 5.85, 'explicit-debt-only optimistic rows need an effective total');
assert.equal(explicitDebtOnlyOptimisticDebt, 4.85, 'partial optimistic payment must subtract from current debt, not zero total');

const page = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const profileServer = fs.readFileSync('lib/clientProfileServer.js', 'utf8');
const payService = fs.readFileSync('components/payments/payService.js', 'utf8');
const engine = fs.readFileSync('lib/arka/arkaEngine.js', 'utf8');
const arkaApi = fs.readFileSync('api/arka/transaction.js', 'utf8');
const sql = fs.readFileSync('supabase/migrations/20260830064833_base_client_linked_debt_payment_v1.sql', 'utf8');

assert.ok(profileServer.includes('resolveBaseVisitMoney') && profileServer.includes('clientId: rowClientId(row)'), 'client profile uses robust money and exposes canonical client ID');
assert.ok(page.includes('loadBaseClientLinkedDebtContext') && page.includes('requireFresh: true') && page.includes('linkedDue') && page.includes('debtItems'), 'Pastrimi opens a fresh linked debt preview');
assert.ok(page.includes('NUK U LEXUA BORXHI LIVE I KLIENTIT') && page.includes('return;'), 'canonical linked payment fails closed when live debt cannot be read');
assert.ok(page.includes("if (!dbRow?.id) throw new Error('ORDER_NOT_FOUND')") && page.includes("throw new Error('CANONICAL_CLIENT_ID_REQUIRED')"), 'payment snapshot requires a fresh DB anchor and canonical client ID');
assert.ok(page.includes('linkedDebts: debtSnapshot') && page.includes('allocateBaseClientLinkedDebt'), 'durable payment intent contains the complete allocation snapshot');
assert.ok(page.includes('queueOnNetworkFailure: false') && page.includes('paymentAllocations.length !== debtSnapshot.length'), 'delay pickup waits for one fully verified client batch');
assert.ok(!page.includes('PASTRIMI_EDIT_PAY') && page.includes('RUAJ, PASTAJ PAGUAJ NGA LISTA'), 'edit mode cannot bypass the canonical list payment route');
assert.ok(page.includes('isTerminalBaseClientPaymentError') && page.includes('base_client_payment_terminal_reconcile'), 'stale client snapshots restore the optimistic row and force a live refresh');
assert.ok(page.includes("durableQueueOpId = String(await enqueuePastrimiPaymentIntent(paymentIntent) || '').trim()") && page.includes('await deleteOp(durableQueueOpId).catch(() => {})'), 'terminal linked-debt errors remove the exact queued retry');
assert.ok(page.includes('currentDebtBefore - currentApplied') && page.includes('effectiveCurrentTotal'), 'legacy explicit-debt-only rows retain their optimistic remaining debt');
assert.ok(page.includes('EXPECTED_ORDER_(?:DEBTS_REQUIRED') && page.includes('PAYMENT_OUTCOME_(?:REQUIRED') && page.includes('STATUS_MISMATCH') && page.includes('ATOMIC_PAYMENT_VERIFY_FAILED'), 'terminal linked-debt domain codes are classified for reconciliation');
assert.ok(page.includes("(payRes?.pending && (!payRes?.payment?.id || !payRes?.order?.id))"), 'verified server payments are reconciled instead of misclassified as offline');
assert.ok(payService.includes('linked_debts: linkedDebts') && engine.includes('record_base_client_cash_payment_atomic_v1'), 'client settlement reaches the atomic server RPC');
assert.ok(engine.includes('const useClientSettlement = linkedDebts.length > 0 && Boolean(canonicalClientId)'), 'even a single canonical debt snapshot uses client-wide stale protection');
assert.ok(engine.includes('countDistinctHandoffClients') && engine.includes('BASE_CLIENT_BATCH_VOID_REQUIRED'), 'one client batch counts once in handoff and blocks single-allocation voids');
assert.ok(engine.includes('readCommittedBaseBatchRetryActor'), 'committed retries survive later staff lifecycle changes');
assert.ok(arkaApi.includes(".from('base_payment_batches')") && arkaApi.includes('isExactCommittedBaseBatchRetry'), 'API lifecycle retry bypass is limited to an exact existing batch');
assert.ok(/order by created_at, id\s+for update/.test(sql), 'sibling order locks are deterministic');
assert.ok(sql.includes('BASE_CLIENT_PAYMENT_STALE_DEBT') && sql.includes('v_actual_snapshot is distinct from v_expected_snapshot'), 'RPC validates the exact stale-balance snapshot');
assert.ok(sql.includes("else v_order.status") && sql.includes('v_order.id = p_anchor_order_id'), 'only the anchor lifecycle may change');
assert.ok(sql.includes('BASE_CLIENT_PAYMENT_ALLOCATION_SUM_MISMATCH') && sql.includes('BASE_CLIENT_PAYMENT_ARKA_SUM_MISMATCH'), 'allocation, ARKA and tender totals are asserted');
assert.ok(sql.includes('BASE_CLIENT_PAYMENT_ARKA_INVARIANT_FAILED') && sql.includes("p.idempotency_key is distinct from concat('BASE_CLIENT_PAYMENT:'"), 'fresh and duplicate batches revalidate every ARKA allocation link');
assert.ok(sql.includes("v_data := (v_data - 'data') || (v_data->'data')") && sql.includes('v_next_debt := round(greatest(0, v_debt - v_allocate), 2)'), 'nested and explicit-debt-only legacy balances stay reduced');
assert.ok(sql.includes('or o.id = p_anchor_order_id') && sql.includes('ANCHOR_LIFECYCLE_STALE'), 'paid anchors are returned and transition safely on pickup');
assert.ok(sql.includes('from public, anon, authenticated') && sql.includes('to service_role'), 'RPC is service-role-only');
assert.ok(sql.includes("set search_path = ''"), 'security definer has an empty search_path');

console.log('PASS: canonical BASE client debt links 3.77€ + 5.85€ into one atomic 9.62€ settlement.');
