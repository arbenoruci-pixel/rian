import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const page = read('app/pranimi/page.jsx');
const home = read('app/page.jsx');
const globalSearch = read('components/GlobalHomeSearch.jsx');
const baza = read('app/baza/page.jsx');

assert.match(page, /const PRANIMI_ENTRY_MODE_NEW = 'NEW_CLIENT_MODE'/);
assert.match(page, /function readPranimiEntryIntent\(\)/);
assert.match(page, /return \{ \.\.\.fallback, source: params\.get\('fresh'\) \? 'fresh_new_entry' : 'plain_new_entry' \}/);
assert.match(page, /existingRequested = params\.get\('existingClient'\) === '1'/);
assert.match(page, /entryIntent\?\.mode === PRANIMI_ENTRY_MODE_RESUME \? readCurrentSessionLocal\(\) : null/);
assert.doesNotMatch(page, /const currentSession = forceResetOnShow \? null : readCurrentSessionLocal\(\)/);
assert.match(page, /A normal PRANIMI entry is always a clean new-client form/);
assert.match(page, /const explicitExisting = entryIntent\?\.mode === PRANIMI_ENTRY_MODE_EXISTING/);
assert.match(page, /const nextNamePrefill = explicitExisting \? explicitName : ''/);
assert.match(page, /setSelectedClient\(null\);[\s\S]{0,500}setClientMatchDecision\(\{ matchKey: '', mode: '', candidate: null \}\)/);
assert.match(page, /clearPranimiEntryHandoff\(\);[\s\S]{0,200}cleanPranimiEntryUrl\(\)/);
assert.match(page, /beginPranimiClientContext\(PRANIMI_ENTRY_MODE_DRAFT, 'load_incomplete_draft'\)/);
assert.match(page, /existing_client_verify_ignored_stale_context/);
assert.match(page, /selected_client_search_verify_ignored_stale_context/);
assert.match(page, /client_card_closed_restore_temp_code/);
assert.match(page, /selected_client_phone_changed_restore_temp_code/);
assert.match(page, /restoreActiveDraftAssignedCode/);

assert.match(home, /href="\/pranimi\?fresh=1"/);
assert.match(home, /tepiha_pranimi_reset_on_show_v1/);
assert.match(home, /params\.set\('existingClient', '1'\)/);
assert.match(home, /params\.set\('clientId', String\(handoff\.clientId\)\)/);
assert.match(globalSearch, /params\.set\('existingClient', '1'\)/);
assert.match(globalSearch, /params\.set\('clientId', String\(handoff\.clientId\)\)/);
assert.match(baza, /href="\/pranimi\?fresh=1"/);
assert.match(baza, /tepiha_pranimi_reset_on_show_v1/);

console.log('PRANIMI explicit NEW_CLIENT_MODE V473 checks: PASS');
