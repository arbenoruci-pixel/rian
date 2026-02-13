PATCH: ARKA carryover + optional transfer + no ghost payments.
Files:
- lib/arkaCashSync.js (accept payments ONLY when day is OPEN; no local ghost repeats)
- lib/arkaDb.js (dbOpenDay uses RPC arka_open_day; adds dbGetLastClosedDayTotals)
- app/arka/cash/page.jsx (suggest opening cash from last closed day; close modal optional transfer OUT)
NOTE: Requires RPC arka_open_day to exist in Supabase.
