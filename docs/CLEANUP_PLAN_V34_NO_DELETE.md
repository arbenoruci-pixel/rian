# PATCH V34 — CLEANUP PLAN ONLY / NO DELETE

## Purpose

This patch is intentionally documentation-only.

Production must remain on V32-DIAG:

- `2.0.39-vite-true-ui-ready-diag-v32`
- `RESET-2026-04-27-VITE-TRUE-UI-READY-DIAG-V32`
- `TRUE UI READY V32`

No runtime code should be changed in this patch.

## Hard Rules

- No file deletion
- No import changes
- No runtime behavior changes
- No readiness changes
- No Service Worker activation changes
- No DB / Supabase changes
- No orders payload changes
- No payments changes
- No ARKA calculation changes
- No outbox changes
- No IndexedDB changes
- No business localStorage changes
- No app/gati changes
- No app/pastrimi changes
- No app/pranimi changes
- No app/arka changes
- No app/transport changes

---

# 1. SAFE-REMOVE LATER

These items are only candidates for later removal after `rg` reference checks and build verification.

Do not remove them in V34.

## No-op components with zero imports

- `components/BootGuard.jsx`
- `components/CleanBootBridge.jsx`
- `components/DiagRecorder.jsx`
- `components/DiagRecorderV5.jsx`
- `components/DiagRuntime.jsx`
- `components/OfflineWarmRoutesLite.jsx`

## Backup / stale files with zero imports

- `components/RootResumeWatchdog.before_false_stall_fix.jsx`
- `components/PwaWarmup.jsx`
- `components/SyncBoot.jsx`
- `components/OfflineEngineRuntime.jsx`

## Old patch notes / scan docs

- `PATCH_NOTE_*.txt`
- `PATCH_NOTE_*.md`
- `DEEP_SCAN_*.md`
- Other old patch-note or scan-report documents that are not imported into runtime

## Old one-time tools

Old patch/migration scripts may be removed later only if they are confirmed to have no runtime imports and no package-script dependency.

Important exception:

- Keep `tools/viteCircularDependencyPlugin.mjs` if it is still referenced by `vite.config.js` or package scripts.

## Search route candidate

- `app/search/page.jsx`

Only remove later after confirming Home search does not depend on `/search`.

---

# 2. KEEP BUT QUARANTINE

These systems may look noisy, but they are part of current V32 diagnosis and must remain untouched for now.

- `index.html` watchdogs / blackbox / fail-open scripts
- `lib/bootLog.js`
- `lib/routeAlive.js`
- `RouteLifecycleProbe`
- `RouteRequestTracker`
- `RuntimeIncidentUploader`
- `ServiceWorkerRegister`
- Debug routes:
  - `/diag-raw`
  - `/diag-lite`
  - `/debug`
  - `/debug-lite`
  - `/debug/boot`
  - `/debug/sync`
- `public/sw.js`
- `public/sw-kill.js`

Notes:

- `public/sw-kill.js` must remain isolated/quarantined.
- Do not call SW kill logic from normal runtime.
- Do not clean index watchdogs until V32 has been stable for enough real iPhone/PWA sessions.

---

# 3. ABSOLUTE DO-NOT-TOUCH

Do not modify these during V34 or immediate cleanup.

- `src/main.jsx`
- `src/AppRoot.jsx` readiness chain
- `index.html` V32 blackbox/watchdog logic
- `lib/routeAlive.js`
- `lib/bootLog.js`
- `components/OfflineSyncRunner.jsx`
- `components/SyncStarter.jsx`
- `lib/syncBootstrap.js`
- Vite Service Worker behavior / VitePWA activation behavior
- `app/gati/page.jsx`
- `app/pastrimi/page.jsx`
- `app/pranimi/page.jsx`
- `app/arka/**`
- `app/transport/**`
- Orders
- Payments
- ARKA
- Outbox
- IndexedDB
- Business localStorage

---

# 4. Manual V32 Production Verification

Verify directly on iPhone/PWA through `/diag-raw`.

Expected:

- `visualIncidents` is visible
- `currentIncident = clean/null`
- `recentIncidents = []`
- `data-ui-ready = 1`
- `route-ui-alive` events are present
- Home Screen PWA opens without black screen

If all checks pass, Phase 2 cleanup can be planned separately.

---

# 5. Phase 2 Rule

Any later deletion must happen only after:

1. `rg` reference verification
2. build verification
3. confirmation that no runtime import path changes
4. confirmation that no readiness/SW/DB/business behavior is touched

Phase 2 must be small, reversible, and limited to confirmed non-runtime junk.
