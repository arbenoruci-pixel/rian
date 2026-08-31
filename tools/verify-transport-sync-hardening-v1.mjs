import assert from 'node:assert/strict';
import fs from 'node:fs';

import { sanitizeTransportOrderPayload } from '../lib/transport/sanitize.js';
import {
  classifyTransportSyncError,
  isTransportSyncNetworkError,
  makeTransportSyncError,
  selectTransportOrderPatchSource,
} from '../lib/transportCore/syncPolicy.js';

const identityAliases = {
  code_str: 'T999',
  code: 'T999',
  client_id: 'client-1',
  client_tcode: 'T999',
  transport_client_tcode: 'T999',
  code_n: 999,
  visit_nr: 9,
  order_code: 'T999',
  order_tcode: 'T999',
  official_order_code: 'T999',
  order_id: 'c6ae4990-c860-4e0f-99fd-47cd7ce52e46',
  public_order_id: 'c6ae4990-c860-4e0f-99fd-47cd7ce52e46',
  t_code: 'T999',
  tcode_lifecycle: 'PERMANENT_CLIENT_TCODE_V1',
};

const input = {
  id: 'c6ae4990-c860-4e0f-99fd-47cd7ce52e46',
  ...identityAliases,
  status: 'pickup',
  created_at: '2026-08-31T08:00:00.000Z',
  updated_at: '2026-08-31T09:00:00.000Z',
  ready_at: '2026-08-31T09:15:00.000Z',
  picked_up_at: '2026-08-31T09:20:00.000Z',
  delivered_at: '2026-08-31T09:25:00.000Z',
  data: {
    ...identityAliases,
    client: {
      id: 'client-1',
      name: 'Blerim',
      phone: '044000000',
      code: 'T999',
      tcode: 'T999',
      client_tcode: 'T999',
      transport_client_tcode: 'T999',
    },
    tepiha: [{ width: 1, length: 3.7, qty: 4 }],
    pay: { euro: 26.64 },
  },
};

const create = sanitizeTransportOrderPayload(input);
assert.equal(create.code_str, 'T999');
assert.equal(create.client_tcode, 'T999');
assert.equal(create.visit_nr, 9);
assert.equal(create.data.order_code, 'T999');
assert.equal(create.data.client.tcode, 'T999');

const patch = sanitizeTransportOrderPayload(input, { patch: true });
for (const key of ['id', 'client_id', 'code_str', 'client_tcode', 'code_n', 'visit_nr']) {
  assert.equal(Object.prototype.hasOwnProperty.call(patch, key), false, `PATCH leaked column ${key}`);
}
for (const key of Object.keys(identityAliases)) {
  assert.equal(Object.prototype.hasOwnProperty.call(patch.data, key), false, `PATCH leaked data.${key}`);
}
for (const key of ['code', 'tcode', 'client_tcode', 'transport_client_tcode']) {
  assert.equal(Object.prototype.hasOwnProperty.call(patch.data.client, key), false, `PATCH leaked data.client.${key}`);
}
assert.equal(Object.prototype.hasOwnProperty.call(patch.data.client, 'id'), false, 'PATCH leaked data.client.id');
assert.equal(patch.status, 'pickup');
assert.equal(patch.created_at, input.created_at);
assert.equal(patch.updated_at, input.updated_at);
assert.equal(patch.ready_at, input.ready_at);
assert.equal(patch.picked_up_at, input.picked_up_at);
assert.equal(patch.delivered_at, input.delivered_at);
assert.equal(patch.data.client.name, 'Blerim');
assert.deepEqual(patch.data.tepiha, input.data.tepiha);
assert.deepEqual(patch.data.pay, input.data.pay);

const currentOutbox = selectTransportOrderPatchSource({
  id: input.id,
  table: 'transport_orders',
  status: 'pickup',
  updated_at: input.updated_at,
  ready_at: input.ready_at,
  data: input.data,
});
assert.equal(currentOutbox.status, 'pickup');
assert.equal(currentOutbox.updated_at, input.updated_at);
assert.deepEqual(currentOutbox.data.tepiha, input.data.tepiha);

const legacyOutbox = selectTransportOrderPatchSource({
  id: input.id,
  table: 'transport_orders',
  data: {
    status: 'gati',
    updated_at: input.updated_at,
    data: { tepiha: input.data.tepiha },
  },
});
assert.equal(legacyOutbox.id, input.id);
assert.equal(legacyOutbox.status, 'gati');
assert.equal(legacyOutbox.updated_at, input.updated_at);
assert.deepEqual(legacyOutbox.data.tepiha, input.data.tepiha);

const notFound = makeTransportSyncError('missing', {
  code: 'TRANSPORT_ORDER_PATCH_TARGET_NOT_FOUND',
  status: 404,
});
assert.deepEqual(classifyTransportSyncError(notFound), {
  permanent: true,
  category: 'target_missing',
  reason: 'patch_target_not_found',
});
assert.equal(classifyTransportSyncError({ status: 422, message: 'bad payload' }).permanent, true);
assert.equal(classifyTransportSyncError({ status: 429, message: 'slow down' }).permanent, false);
assert.equal(classifyTransportSyncError({ status: 401, message: 'login required' }).permanent, false);
assert.equal(classifyTransportSyncError({ code: '42501', message: 'permission denied' }).category, 'authorization_denied');
assert.equal(isTransportSyncNetworkError(new Error('Failed to fetch')), true);

const syncEngine = fs.readFileSync('lib/transportCore/syncEngine.js', 'utf8');
const localDb = fs.readFileSync('lib/transportOrdersDb.js', 'utf8');
const offlineRoute = fs.readFileSync('app/api/offline-sync/route.js', 'utf8');

assert.match(syncEngine, /selectTransportOrderPatchSource\(payload\)/);
assert.match(syncEngine, /TRANSPORT_ORDER_PATCH_TARGET_NOT_FOUND/);
assert.match(syncEngine, /markOfflineCodeLeaseFinishedLocal/);
assert.match(syncEngine, /TRANSPORT_OFFLINE_LEASE_FINALIZATION_NOT_VERIFIED/);
assert.match(syncEngine, /TRANSPORT_CLIENT_PATCH_TARGET_NOT_FOUND/);
assert.doesNotMatch(syncEngine, /if \(!data\) return true/);
assert.match(syncEngine, /await pauseTransportOp[\s\S]{0,700}continue;/);
assert.match(localDb, /\.\.\.remotePatch[\s\S]{0,180}sync_state: 'pending'/);
assert.match(localDb, /TRANSPORT_ORDER_PATCH_TARGET_NOT_FOUND/);
assert.match(offlineRoute, /selectTransportOrderPatchSource\(body \|\| \{\}\)/);
assert.match(offlineRoute, /status: 404/);

console.log('PASS: Transport PATCH replay preserves lifecycle fields, strips stale JSON identities, retains rejected operations, and rejects zero-row updates.');
