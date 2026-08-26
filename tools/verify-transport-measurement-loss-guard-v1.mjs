import assert from 'node:assert/strict';
import {
  countTransportMeasurementGroups,
  preserveTransportMeasurements,
} from '../lib/transport/measurementGuard.js';

const saved = {
  tepiha: [{ id: 'a', m2: 12.4 }, { id: 'b', m2: 20.3 }],
  staza: [{ id: 'c', m2: 0.8 }],
  shkallore: { qty: 2, per: 0.3 },
  pay: { m2: 34.1, euro: 61.38, paid: 0 },
};

assert.equal(countTransportMeasurementGroups(saved), 4);

const staleStatusWrite = preserveTransportMeasurements(saved, {
  status: 'cancelled',
  cancelled_at: '2026-08-26T10:00:00.000Z',
});
assert.equal(staleStatusWrite.protected, true);
assert.deepEqual(staleStatusWrite.data.tepiha, saved.tepiha);
assert.deepEqual(staleStatusWrite.data.staza, saved.staza);
assert.deepEqual(staleStatusWrite.data.shkallore, saved.shkallore);
assert.deepEqual(staleStatusWrite.data.pay, saved.pay);

const paymentWrite = preserveTransportMeasurements(saved, {
  status: 'done',
  pay: { paid: 61.38, debt: 0 },
});
assert.equal(paymentWrite.protected, true);
assert.equal(paymentWrite.data.pay.euro, 61.38);
assert.equal(paymentWrite.data.pay.paid, 61.38);
assert.equal(paymentWrite.data.pay.debt, 0);

const deliberateClear = preserveTransportMeasurements(saved, {
  tepiha: [],
  staza: [],
  measurement_clear_intent: true,
});
assert.equal(deliberateClear.protected, false);
assert.deepEqual(deliberateClear.data.tepiha, []);

const legitimateEdit = preserveTransportMeasurements(saved, {
  tepiha: [{ id: 'a', m2: 11.9 }],
  staza: [],
  pay: { m2: 11.9, euro: 21.42 },
});
assert.equal(legitimateEdit.protected, false);
assert.equal(legitimateEdit.data.tepiha[0].m2, 11.9);

console.log('PASS: Transport measurement loss guard V1 behavior tests.');
