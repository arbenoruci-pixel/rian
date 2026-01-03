# TEPIHA — ARKA Patch (Same Names)

Qëllimi: me mos i dyfishu file-t (emrat e njejt si ma herët).

## Files in this patch
- `supabase/arka.sql`      (run in Supabase SQL editor)
- `lib/arkaDb.js`          (same name; backward compatible wrapper; includes ARKA v2 APIs)
- `lib/usersDb.js`         (same name; adds verifyPin + findUserByPin alias)

## Install
1) Supabase → run `supabase/arka.sql`
2) Copy files into your project (overwrite same paths):
   - `lib/arkaDb.js`
   - `lib/usersDb.js`

## Notes
- UI nuk preket. Module tjera nuk preken.
- Pas instalimit, UI mundet gradualisht me u lidh te funksionet:
  - getActiveCycle / openCycle / closeCycle / receiveFromDispatch
  - addExpense (pyet REGISTER vs COMPANY_SAFE)
  - payrollCashOut / payrollAdjustment

## Hotfix included
- Added missing compatibility function: dbHasPendingHandedToday() (UI guard)
