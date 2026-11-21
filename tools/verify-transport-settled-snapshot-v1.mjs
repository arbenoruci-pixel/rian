import assert from 'node:assert/strict';
import { preserveSettledTransportOrderPatch } from '../lib/transport/settledPaymentSnapshot.js';

const settled = {
  id: 'visit-t264',
  status: 'done',
  data: {
    status: 'done',
    state: 'done',
    paid_done: true,
    isPaid: true,
    paid: 5.76,
    clientPaid: 5.76,
    debt: 0,
    payment_state: 'PAID',
    delivery_payment_status: 'PAID',
    delivered_at: '2026-11-20T13:34:16.008Z',
    done_at: '2026-11-20T13:34:16.008Z',
    paid_at: '2026-11-20T13:34:16.008Z',
    pay: {
      euro: 5.76, paid: 5.76, arkaRecordedPaid: 5.76, debt: 0,
      m2: 3.2, rate: 1.8, last_paid_at: '2026-11-20T13:34:16.008Z',
    },
  },
};
const stale = {
  status: 'delivery',
  updated_at: '2026-11-20T13:34:18.487Z',
  data: {
    status: 'delivery', state: 'delivery', paid_done: false, clientPaid: 0,
    tepiha: [{ m2: 3.7, qty: 1 }],
    notes: 'fresh driver note',
    pay: { euro: 5.76, paid: 0, arkaRecordedPaid: 0, m2: 3.7, rate: 1.8 },
  },
};

const safe = preserveSettledTransportOrderPatch(settled, stale);
assert.equal(safe.status, 'done');
assert.equal(safe.data.status, 'done');
assert.equal(safe.data.state, 'done');
assert.equal(safe.data.paid_done, true);
assert.equal(safe.data.pay.paid, 5.76);
assert.equal(safe.data.pay.arkaRecordedPaid, 5.76);
assert.equal(safe.data.pay.euro, 5.76);
assert.equal(safe.data.clientPaid, 5.76);
assert.equal(safe.data.payment_state, 'PAID');
assert.equal(safe.data.delivered_at, settled.data.delivered_at);
assert.equal(safe.data.pay.m2, 3.7, 'keep independent measurement editing');
assert.deepEqual(safe.data.tepiha, stale.data.tepiha, 'keep unrelated fresh fields');
assert.equal(safe.data.notes, 'fresh driver note');
assert.equal(stale.status, 'delivery', 'input must remain immutable');
assert.equal(stale.data.pay.paid, 0, 'nested input must remain immutable');

assert.equal(
  preserveSettledTransportOrderPatch(settled, { status: 'delivery' }).status,
  'done',
  'status-only stale patch cannot reopen paid delivery'
);
const dataOnly = preserveSettledTransportOrderPatch(settled, {
  data: { notes: 'new note', pay: { paid: 0 }, status: 'delivery' },
});
assert.equal(dataOnly.data.pay.paid, 5.76);
assert.equal(dataOnly.data.notes, 'new note');
assert.equal(dataOnly.data.status, 'done');

const cancelled = { status: 'cancelled', data: stale.data };
assert.strictEqual(preserveSettledTransportOrderPatch(settled, cancelled), cancelled);
const override = { status: 'pickup', data: { manual_status_override: 'PAID_NOT_PICKED_UP' } };
assert.strictEqual(preserveSettledTransportOrderPatch(settled, override), override);

for (const status of ['new', 'delivery']) {
  const unpaid = { status, data: { paid_done: false, pay: { euro: 22.32, paid: 0 } } };
  assert.strictEqual(preserveSettledTransportOrderPatch(unpaid, stale), stale);
}
const missingLedger = { status: 'done', data: { paid_done: true, pay: { euro: 20, paid: 0 } } };
assert.strictEqual(preserveSettledTransportOrderPatch(missingLedger, stale), stale);

console.log('PASS: settled Transport payments survive stale status/data updates without affecting unpaid visits or explicit overrides.');
