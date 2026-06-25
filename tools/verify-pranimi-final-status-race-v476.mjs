import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const page = read('app/pranimi/page.jsx');
const ordersService = read('lib/ordersService.js');
const draftDb = read('lib/pranimiDraftDb.js');

assert.match(ordersService, /PRANIMI_FINAL_ORDER_DRAFT_DOWNGRADE_BLOCKED/);
assert.match(ordersService, /isPranimiFinalOrderRow\(current \|\| \{\}\) && incomingDraftWrite/);
assert.match(ordersService, /isPranimiDraftFlaggedData\(out\.data\)/);

assert.match(draftDb, /DRAFT_COMPARE_AND_SWAP_TIMESTAMP_MISSING/);
assert.match(draftDb, /\.eq\('updated_at', expectedUpdatedAt\)/);
assert.match(draftDb, /FINAL_ORDER_WON_DRAFT_SAVE_RACE/);
assert.match(draftDb, /FINAL_ORDER_WON_DRAFT_INSERT_RACE/);

assert.match(page, /const finalSaveInFlightRef = useRef\(false\)/);
assert.match(page, /isDraftSuppressed\(draftId\) \|\| savingContinue \|\| finalSaveInFlightRef\.current/);
assert.match(page, /safeDirectPranimiDraftWrite/);
assert.match(page, /DIRECT_DRAFT_COMPARE_AND_SWAP_LOST/);
assert.match(page, /Never use an[\s\S]*unconditional upsert on local_oid/);
assert.doesNotMatch(
  page.match(/async function upsertDraftDb[\s\S]*?\n}\n\nfunction orderRowToPranimiDbDraftSummary/)?.[0] || '',
  /upsertOrderRecord\(\s*['"]orders['"]/,
);
assert.match(page, /status: finalLinkStatus,[\s\S]{0,300}data: payload\.data/);
assert.match(page, /ensureFinalOrderStatusBeforeCodeConsume/);
assert.match(page, /final_status_race_guard_verified/);
assert.match(page, /final_status_not_confirmed_code_consume_blocked/);

const guardCall = page.indexOf('const finalStatusGuard = await ensureFinalOrderStatusBeforeCodeConsume');
const consumeCall = page.indexOf('codeLifecycleResult = await finalizeCodeLifecycleForVerifiedOrder', guardCall);
assert.ok(guardCall > 0 && consumeCall > guardCall, 'final status must be verified before code consume');

console.log('PRANIMI V476 final-status race guards: PASS');
