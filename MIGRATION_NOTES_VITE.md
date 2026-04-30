# TEPIHA — Vite Conversion Notes

This package converts the app away from Next.js App Router and into a Vite + React Router application while preserving the existing `app/`, `components/`, and `lib/` code as much as possible.

## What changed
- Replaced Next.js routing with React Router.
- Added shims for:
  - `next/link`
  - `next/navigation`
  - `next/dynamic`
  - `next/script`
- Added `src/AppRoot.jsx` as the new root shell.
- Added a Node API compatibility server under `server/index.mjs`.
- Kept existing business logic and page files in place.

## Run
1. `npm install`
2. `npm run dev`
   - Vite UI: `http://localhost:5173`
   - API server: `http://localhost:8787`

## Production
- Build frontend with `npm run build`
- Run API/static server with `npm run server`

## Important
This conversion focuses on getting the operational app out of Next.js and into a Vite structure with minimal rewrite of the existing business logic.

### Ported API endpoints
- `POST /api/auth/login`
- `POST /api/auth/validate-pin`
- `GET /api/version`
- `POST /api/runtime-incident`
- `POST /api/public-booking`
- `GET /api/transport/fletore`

### Backup endpoints
These currently return `BACKUP_ENDPOINT_PENDING_PORT` and need a second pass if you want the old backup/restore screens fully working under the new server.

## Reason for this approach
The project had grown into a very large client-heavy offline/PWA app, and the Next.js App Router layer was adding chunk/hydration/resume risk, especially on iPhone standalone/PWA usage.


## Vercel-ready patch
- Added `vercel.json` with `framework: "vite"`, `buildCommand`, `outputDirectory`, and SPA rewrite for deep links.
- Added root `api/` Vercel functions for the currently used endpoints: version, auth/login, auth/validate-pin, runtime-incident, public-booking, transport/fletore, and backup placeholders.
- This avoids the old Next.js framework detection path and gives Vercel real `/api/*` functions outside `app/api/`.
