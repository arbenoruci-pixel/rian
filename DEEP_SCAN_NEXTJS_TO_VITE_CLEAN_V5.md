# Deep Scan — Next.js → Vite Cleanup V5

## Runtime verdict
The active runtime is Vite + React Router:

- `src/main.jsx`
- `src/AppRoot.jsx`
- `src/generated/routes.generated.jsx`
- `vite.config.js`
- `api/**` for Vercel serverless endpoints

The old Next App Router runtime files are not the runtime source of truth.

## What was cleaned in this patch

1. Active `next/link` imports were replaced with `@/lib/routerCompat.jsx`.
2. Active `next/navigation` imports were replaced with `@/lib/routerCompat.jsx`.
3. Active `next/dynamic` imports were replaced with `@/lib/dynamicCompat.jsx`.
4. Active `next/script` imports were replaced with `@/lib/scriptCompat.jsx`.
5. `vite.config.js` no longer aliases `next/link`, `next/navigation`, `next/dynamic`, or `next/script`.
6. `lib/apiService.js` no longer imports `next/server`; it now returns native `Response` objects.
7. Version markers were bumped:
   - `2.0.8-vite-next-clean-v5`
   - `RESET-2026-04-25-VITE-NEXT-CLEAN-V5`

## Dead Next.js remnants found
These are old Next App Router files. They are not imported by the Vite runtime and should be deleted when doing a repository cleanup:

- `app/api/**`
- `app/layout.jsx`
- `app/error.jsx`
- `app/loading.jsx`
- `app/admin/devices/page.jsx`
- `app/_redirect_to_arka.jsx`
- `app/arka/cash/page.jsx`
- `app/arka/corporate/page.jsx`
- `app/arka/shpenzime/page.jsx`
- `app/transport/arka/page.jsx`
- `src/shims/next-link.jsx`
- `src/shims/next-navigation.js`
- `src/shims/next-dynamic.jsx`
- `src/shims/next-script.jsx`
- `src/shims/next-server.d.ts`

A cleanup script is included at `tools/remove-nextjs-remnants.mjs` for deleting only these dead files/folders.

## Intentionally retained for now
Some `_next` text remains only in legacy-cleanup/diagnostic guards. This is useful while phones may still have old Next/PWA cache or old service workers:

- `src/main.jsx`
- `public/sw.js`
- chunk-diagnostic regexes in `index.html`, `lib/lazyImportRuntime.js`, `lib/globalErrors.js`

These are not active Next.js dependencies. They only help detect or clean stale old runtime artifacts.

## Not changed
This patch does not touch:

- DB
- Supabase schema
- orders
- outbox
- write flow
- business logic
