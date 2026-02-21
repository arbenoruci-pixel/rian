TEPIHA — ARKA PATCH (ONLY)
Changes included:
1) lib/arkaDb.js
   - dbOpenDay uses Supabase RPC arka_open_day (OPEN/NOOP/REOPEN) to avoid duplicate day_key
   - dbCloseDay uses Supabase RPC arka_close_day (audit)
2) app/arka/cash/page.jsx
   - Passes day_key (YYYY-MM-DD) to dbOpenDay
3) supabase/arka_open_reopen_rpc.sql
   - Run this in Supabase SQL Editor to create RPC + policies.
Notes:
- This patch does NOT touch PRANIMI/PASTRIMI/GATI.
- After running SQL, deploy/upload patch and test:
  OPEN -> CLOSE -> OPEN again (should REOPEN, no duplicate error).
