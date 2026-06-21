# PRANIMI code reservation V37

## Problem found

A worker could open **PRANIMI** and remain without a numeric code because several independent paths were controlling the same reservation lifecycle:

- login warm-up and PRANIMI used different local epoch keys;
- `lib/codeLease.js` contained a second allocator separate from `lib/baseCodes.js`;
- older session shapes could expose a UUID/user ID where a worker PIN was required;
- mount, `pageshow`, visibility, online and manual retry events could start parallel reservations;
- an empty DB pool was not replenished consistently across all RPC signatures;
- a timed-out mutating RPC could be retried through another transport/signature;
- old PWA bundles could still call the legacy API path.

## Fix

- One canonical allocator: `lib/baseCodes.js`.
- `lib/codeLease.js` is now a compatibility re-export only.
- Canonical numeric worker PIN resolution in `lib/pinIdentity.js` and session migration in `lib/sessionStore.js`.
- Both historical epoch keys are read/migrated together before pool access.
- One in-flight reservation per worker PIN + `local_oid`.
- Foreground gets one code immediately; pool refill continues in the background.
- Canonical server endpoint `/api/base-codes/reserve` and legacy alias `/api/pranimi/reserve-code` use the same server allocator.
- Atomic DB allocator SQL auto-mints and claims codes with an advisory lock and `FOR UPDATE SKIP LOCKED`.
- Ambiguous timeout/network results do not trigger a second mutating allocation path.
- Explicit `count=0` remains a no-op.
- Owner-aware hold/release logic cannot fall through and overwrite another worker's reservation.
- PWA/app epoch bumped to `RESET-2026-06-20-PRANIMI-CODE-RESERVATION-V37`.

## Database migration

Run once in Supabase SQL Editor:

`supabase/sql/base_codes_reservation_hardening_20260620.sql`

The migration is idempotent and supports both `users` and `tepiha_users` worker tables.

## Verification completed

- `node tools/verify-pranimi-code-reservation.mjs`
- `node tools/verify-pranimi-final-lifecycle.mjs`
- `npm run cycles:strict`
- `npm run build`

All completed successfully. Build warnings are existing chunk/dynamic-import warnings; there were no build errors.
