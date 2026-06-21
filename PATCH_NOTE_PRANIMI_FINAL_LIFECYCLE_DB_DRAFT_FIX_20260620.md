# PRANIMI Final Lifecycle / DB_DRAFT Regression Fix — 2026-06-20

## Root cause found
Final PRANIMI saves could inherit DB draft metadata from autosave rows. This allowed completed orders to keep values such as `source: DB_DRAFT`, `pranimi_db_draft: true`, `is_pranimi_incomplete_draft: true`, `draft_lifecycle.db_draft_status: incomplete`, or `pranimi_code_lifecycle.db_verify_state: DB_VERIFY_PENDING/DB_DRAFT` even after the order was saved or moved to `pastrim/gati/dorzim`.

The DB cleanup confirmed the pattern:
- 10 real stuck orders were recovered to `pastrim`.
- 124 valid orders only needed metadata cleanup.
- empty / duplicate drafts were archived or reviewed.
- final global check returned `GLOBAL_BAD_DRAFT_FLAGS_LEFT = 0` and `REAL_STUCK_PRANIM_INCOMPLETE_LEFT = 0`.

## Code fix
Added one shared lifecycle normalizer:
- `lib/pranimiOrderLifecycle.js`

It enforces final order metadata:
- `data.status` and `data.state` match the real top-level status.
- `source` becomes `DB_FINAL` or a final/pending variant.
- `pranimi_db_draft` and `is_pranimi_incomplete_draft` become `false`.
- `draft_lifecycle.db_draft_status` becomes `finalized`.
- `pranimi_code_lifecycle.db_verify_state` becomes `DB_VERIFIED` when the DB write succeeds.
- archived duplicates are not treated as active drafts.

## Files changed
- `app/pranimi/page.jsx`
- `lib/pranimiOrderLifecycle.js`
- `lib/pranimiDraftDb.js`
- `lib/ordersService.js`
- `lib/ordersDb.js`
- `lib/syncEngine.js`
- `tools/verify-pranimi-final-lifecycle.mjs`

## Protected flows
- Direct `VAZHDO` save
- Edit save from PRANIMI
- Autosave race after finalization
- DB draft API upsert
- Offline / outbox insert sync
- Existing remote/order verification path
- Local mirror refresh filters for archived rows

## Validation
- `node tools/verify-pranimi-final-lifecycle.mjs` passed.
- `npm run build` passed.
- `npm run cycles:strict` passed.
