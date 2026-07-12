import {
  extractOfflineQueuedWarningIdentity,
  findMatchingQueuedBaseInsert,
  inspectOfflineQueuedSuccess,
} from '../lib/offlineQueuedOrderUiGuard.js';

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

const localOid = '0dd40fe8-ac59-4f7d-b43e-cd9a372dfd15';
const saveAttemptId = 'bdb66559-ac48-4a7a-8bc0-38b16b3ac306';
const outboxOpId = 'op_queued_453';

const modalText = `
KJO ORDER ËSHTË VETËM LOKALE
NUK KA HYRË ENDE NË DB
LAJMËRO ADMININ
LOCAL / NOT SYNCED

RUAJTUR LOKALISHT — DO SINKRONIZOHET KUR TË KETË INTERNET
Kodi: 453 • Status: LOCAL / NOT SYNCED

PROBLEM ME ORDER — NUK KA HYRË NË DB
Kodi: 453
Klienti: usa test beni aldi
Telefoni: +38354546168
Copë: 1
M2: 1.8
Shuma: 2.34 €
Status: LOCAL / NOT SYNCED
Local OID: ${localOid}
Save Attempt ID: ${saveAttemptId}
Outbox OP ID: —
Worker PIN: 4563
Device ID: 911b8367-6435-4aa1-b2bb-d6cbb4488b00
Error: —
Online/offline: OFFLINE
Final code reason: OFFLINE_VERIFIED_ASSIGNMENT_PROOF
DB verify state: LOCAL / NOT SYNCED
`;

const snapshot = [{
  id: outboxOpId,
  op_id: outboxOpId,
  kind: 'insert_order',
  status: 'pending',
  table: 'orders',
  uniqueValue: localOid,
  payload: {
    table: 'orders',
    local_oid: localOid,
    code: 453,
    client_name: 'usa test beni aldi',
    data: {
      local_oid: localOid,
      save_attempt_id: saveAttemptId,
      outbox_op_id: outboxOpId,
      code: 453,
      pranimi_code_lifecycle: {
        local_oid: localOid,
        save_attempt_id: saveAttemptId,
        outbox_op_id: outboxOpId,
        final_code_reason: 'OFFLINE_VERIFIED_ASSIGNMENT_PROOF',
      },
      sync_safety: {
        local_oid: localOid,
        save_attempt_id: saveAttemptId,
        outbox_op_id: outboxOpId,
      },
    },
  },
}];

const identity = extractOfflineQueuedWarningIdentity(modalText);
check(identity.local_oid === localOid, 'Local OID should be extracted exactly');
check(identity.save_attempt_id === saveAttemptId, 'Save Attempt ID should be extracted exactly');
check(identity.code === '453', 'Code should be extracted exactly');

const queued = findMatchingQueuedBaseInsert(snapshot, identity);
check(queued?.op_id === outboxOpId, 'Matching pending Base insert should be found');

const accepted = inspectOfflineQueuedSuccess({ modalText, snapshot });
check(accepted.ok === true, 'Normal offline bank save with matching outbox must be treated as queued success');
check(accepted?.queued?.op_id === outboxOpId, 'Queued success must preserve the exact outbox OP ID');

const noOutbox = inspectOfflineQueuedSuccess({ modalText, snapshot: [] });
check(noOutbox.ok === false && noOutbox.reason === 'MATCHING_OUTBOX_INSERT_MISSING', 'Modal must stay blocking when no matching outbox insert exists');

const wrongOidSnapshot = JSON.parse(JSON.stringify(snapshot));
wrongOidSnapshot[0].payload.local_oid = 'another-local-oid';
wrongOidSnapshot[0].payload.data.local_oid = 'another-local-oid';
wrongOidSnapshot[0].payload.data.pranimi_code_lifecycle.local_oid = 'another-local-oid';
wrongOidSnapshot[0].payload.data.sync_safety.local_oid = 'another-local-oid';
wrongOidSnapshot[0].uniqueValue = 'another-local-oid';
check(inspectOfflineQueuedSuccess({ modalText, snapshot: wrongOidSnapshot }).ok === false, 'A different local_oid must never auto-continue');

const mismatchModal = `${modalText}\nDB VERIFY MISMATCH\nPROBLEM ME KODIN`;
const mismatch = inspectOfflineQueuedSuccess({ modalText: mismatchModal, snapshot });
check(mismatch.ok === false && mismatch.reason === 'REAL_ERROR_MODAL', 'Real DB/code errors must remain blocking');

const clientFailureModal = `${modalText}\nKLIENTI NUK U VERIFIKUA NË DB`;
check(inspectOfflineQueuedSuccess({ modalText: clientFailureModal, snapshot }).ok === false, 'Client verification failures must remain blocking');

const doneSnapshot = JSON.parse(JSON.stringify(snapshot));
doneSnapshot[0].status = 'done';
check(inspectOfflineQueuedSuccess({ modalText, snapshot: doneSnapshot }).ok === false, 'A terminal outbox item must not be treated as pending queued success');

if (failures.length) {
  console.error(`FAIL: ${failures.length} offline queued success UI check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: 10 offline queued success UI checks passed.');
