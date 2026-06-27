import fs from 'node:fs';
import assert from 'node:assert/strict';

const page = fs.readFileSync('app/pranimi/page.jsx', 'utf8');
const globalSearch = fs.readFileSync('components/GlobalHomeSearch.jsx', 'utf8');
const homePage = fs.readFileSync('app/page.jsx', 'utf8');

assert.match(page, /async function resolveExplicitExistingClientHandoff/);
assert.match(page, /explicit_existing_client_session_started_locked_code/);
assert.match(page, /EXPLICIT_EXISTING_CLIENT_FROM_SEARCH_LOCKED_BEFORE_FORM/);
assert.match(page, /EXISTING_CLIENT_HANDOFF_NOT_VERIFIED/);
assert.match(page, /setSelectedClient\(lockedDecisionCandidate\)/);
assert.match(page, /mode: 'use_existing'/);
assert.match(page, /lockedExistingId && lockedExistingCode/);

assert.match(globalSearch, /clientId: result\?\.clientId \|\| null/);
assert.doesNotMatch(globalSearch, /clientId: result\?\.clientId \|\| result\?\.id/);
assert.match(globalSearch, /lastOrderId: result\?\.orderId \|\| result\?\.id \|\| null/);

assert.match(homePage, /clientId: result\?\.clientId \|\| null/);
assert.doesNotMatch(homePage, /clientId: result\?\.clientId \|\| result\?\.id/);
assert.match(homePage, /lastOrderId: result\?\.orderId \|\| result\?\.id \|\| null/);

console.log('verify-pranimi-existing-client-handoff-v477: PASS');
