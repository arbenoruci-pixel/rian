import assert from 'node:assert/strict';
import {
  buildPranimiFinalOrderData,
  normalizePranimiFinalOrderRow,
  isPranimiDbDraftRow,
  isPranimiFinalOrderRow,
  isPranimiArchivedOrder,
} from '../lib/pranimiOrderLifecycle.js';

const staleDraftData = {
  status: 'incomplete',
  state: null,
  source: 'DB_DRAFT',
  pranimi_draft_source: 'DB DRAFT / SYNCED',
  pranimi_db_draft: true,
  is_pranimi_incomplete_draft: true,
  local_sync_status: 'DB_VERIFY_PENDING',
  local_oid: 'abc-123',
  draft_lifecycle: { db_draft: true, db_draft_status: 'incomplete' },
  pranimi_code_lifecycle: { db_draft: true, db_draft_status: 'incomplete', db_verify_state: 'DB_DRAFT', save_attempt_id: 'save-1' },
};

const finalData = buildPranimiFinalOrderData(staleDraftData, {
  status: 'pastrim',
  localOid: 'abc-123',
  verifyState: 'DB_VERIFIED',
  source: 'DB_FINAL',
});
assert.equal(finalData.status, 'pastrim');
assert.equal(finalData.state, 'pastrim');
assert.equal(finalData.source, 'DB_FINAL');
assert.equal(finalData.pranimi_db_draft, false);
assert.equal(finalData.is_pranimi_incomplete_draft, false);
assert.equal(finalData.local_sync_status, 'DB_VERIFIED');
assert.equal(finalData.draft_lifecycle.db_draft_status, 'finalized');
assert.equal(finalData.pranimi_code_lifecycle.db_verify_state, 'DB_VERIFIED');
assert.equal(finalData.pranimi_code_lifecycle.db_draft, false);

const finalRow = normalizePranimiFinalOrderRow({ status: 'pastrim', local_oid: 'abc-123', data: staleDraftData }, { status: 'pastrim', verifyState: 'DB_VERIFIED' });
assert.equal(finalRow.data.source, 'DB_FINAL');
assert.equal(finalRow.data.pranimi_db_draft, false);
assert.equal(isPranimiFinalOrderRow(finalRow), true);
assert.equal(isPranimiDbDraftRow(finalRow), false);

const archivedRow = { status: 'pranim', data: { status: 'archived_duplicate', source: 'DB_ARCHIVED', pranimi_db_draft: false, is_pranimi_incomplete_draft: false } };
assert.equal(isPranimiArchivedOrder(archivedRow), true);
assert.equal(isPranimiDbDraftRow(archivedRow), false);

const draftRow = { status: 'pranim', data: { status: 'incomplete', source: 'DB_DRAFT', pranimi_db_draft: true, is_pranimi_incomplete_draft: true } };
assert.equal(isPranimiDbDraftRow(draftRow), true);

console.log('OK pranimi final lifecycle regression');
