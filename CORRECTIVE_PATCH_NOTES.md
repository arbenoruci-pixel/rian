Fixes included in this corrective no-root patch:
- Adds missing root /api functions required by the Vite deploy: auth/login, auth/validate-pin, runtime-incident, version, public-booking, transport/fletore, backup/*, cron/backup.
- Adds api/_helpers.js that earlier patches referenced but did not include.
- Fixes AuthGate so clear/logout/force query flags can bypass stale local sessions.
- Mounts SessionDock in AppRoot and fixes SessionDock so it can appear outside home routes.
- Expands login role options and admin compatibility for ADMIN_MASTER / OWNER / PRONAR / SUPERADMIN.
- Fixes SPA routing on Vercel for direct-open / refresh routes like /porosit.
- Fixes /admin/devices redirect and adds /arka/puntoret alias route.
- Updates local server/index.mjs so dev/server mode matches the deployed API behavior more closely.
