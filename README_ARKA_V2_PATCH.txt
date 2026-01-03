# TEPIHA — ARKA V2 Patch (CASH ONLY)

This patch adds a brand-new ARKA system from zero (DB + libs), without changing existing UI/modules.

## Files added
- `supabase/arka_v2.sql`  → run this in Supabase SQL editor
- `lib/workersDb.v2.js`   → PIN verify helper
- `lib/arkaDb.v2.js`      → ARKA v2 data-layer (RPC-based)

## Install (2 steps)
1) Supabase:
   - Open SQL editor
   - Paste & run `supabase/arka_v2.sql`

2) Project:
   - Copy `lib/arkaDb.v2.js` and `lib/workersDb.v2.js` into your project `lib/`

## What you get now (ready to wire into UI later)
- Cycles: OPEN → HANDED → RECEIVED with guard:
  - cannot OPEN new cycle if any HANDED exists unreceived
- Buckets: REGISTER / COMPANY_SAFE / PERSONAL (source-only)
- Expenses button can call: `v2_addExpense({ payFromBucket: 'REGISTER' | 'COMPANY_SAFE', ... })`
- Payroll cash-out: salary/advance/bonus paid from REGISTER or COMPANY_SAFE
- Full audit trail: `cash_ledger` (who/when/why)

## PIN
- Worker PINs are bcrypt-hashed in DB using pgcrypto.
- Verify via: `workers_v2_verify_pin(pin)` (used by `v2_verifyPin`)

UI wiring is the next step (separate patch) to keep your current UI untouched.
