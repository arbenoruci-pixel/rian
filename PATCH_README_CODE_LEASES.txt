TEPIHA — SERVER LEASE PATCH (BASE + TRANSPORT)

Why:
- iOS "split brain": Safari and Home Screen (PWA) often do NOT share localStorage/cookies.
- Local-only lease works per-container, but you can still burn codes / see different codes between Safari and PWA.
- This patch adds a SERVER-side lease so BOTH containers always reuse the same active code when online.
- Offline still uses the local pool as backup.

What changed (code):
- lib/baseCodes.js:
  - takeBaseCode() now prefers Supabase RPC get_or_reserve_base_code_lease() when online.
  - markBaseCodeUsedOrQueue() best-effort calls close_base_code_lease() after marking used.

- lib/transportCodes.js:
  - Added local lease (cookie + localStorage) to prevent "new code every refresh".
  - Added DB_EPOCH auto-heal (same as base).
  - When online, prefers Supabase RPC get_or_reserve_transport_code_lease().
  - After marking code used, best-effort calls close_transport_code_lease().

What you must do (Supabase):
1) Open Supabase SQL editor.
2) Run: SUPABASE_CODE_LEASES_PATCH.sql

Deploy:
- Replace the two JS files in your project, then redeploy.

Quick test:
- Open /pranimi in Safari -> note code.
- Open same /pranimi in PWA -> it should show the SAME code (when online).
- Do the same for /transport/pranimi -> same T-code.
- Turn off internet, create order using local pool -> should still work offline.
