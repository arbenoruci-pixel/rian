# Security Advisor: public internal tables

The live review on 2026-11-01 (America/Chicago) identified seven
`rls_disabled_in_public` findings: `transport_keep_one`, `app_meta`,
`transport_client_debts`, `app_runtime_switches`, `system_counters`,
`tepiha_counters`, and `base_code_pool`. All seven had RLS disabled, no
policies, and broad table grants for `anon` and `authenticated`.
This is the current finding set; the October 27 email does not establish
which individual table(s) were in that historical scan.

`base_bonus_extensions` already had RLS enabled and only postgres/service_role
table grants, matching the repository migration
`20261028035849_bujar_bonus_evidence_24h.sql`. Its live migration history uses
version `20261028042209` with the same descriptive name. Existing allocator
migrations reference the older code/debt tables without resolving their RLS.

## Change

- Enable RLS and revoke table and column privileges from PUBLIC, anon and
  authenticated on the seven affected tables. Preserve service_role access.
- Retain only column SELECT on `app_meta(key, db_epoch)`, restricted to
  `key = 'global'`. This preserves Pranimi's non-sensitive cache epoch read.
- Replace browser `base_code_pool` reads in Pranimi/Pastrimi with the
  read-only `/api/base-code-status` endpoint. It requires an approved device,
  active base/dispatch/admin user, matching actor ID and same-origin JSON.
  Return only code, status and lease expiry, with a maximum of 160 codes.
  Transport actors cannot read the base allocator through this endpoint.
- Keep allocator RPCs, business data, payments and existing service_role
  grants unchanged. No default privileges or broad allow-all policies added.

## Release and verification

The first migration hardens the six independent tables. Deploy the API/client
changes before applying the second migration for `base_code_pool`. Existing open
tabs should reload to receive the new reader. Run `npm run build`, which
includes the fixture authorization suite and existing module regressions.
The first migration was applied through Supabase with live history version
`20261102051116` (`restrict_public_internal_tables`); do not reapply it.
Apply only `20261102051029_restrict_base_code_pool_after_reader.sql` after
the approved production release. Do not push the entire migration directory
because historical live version IDs differ.
Run `supabase/sql/verify_public_internal_rls_readonly.sql` and Security Advisor
after application. The read-only production verifier changes no business rows.

Tests cover real SQL role denial for anon/authenticated (including column ACLs,
INSERT/UPDATE/DELETE/TRUNCATE), the single allowed epoch row/columns, retained
service access, approved PUNTOR/DISPATCH/ADMIN reads, denied TRANSPORT/unknown/
inactive/unapproved sessions, actor mismatch, malformed/bulk input, CSRF and
private caching. All write tests use synthetic local PGlite fixtures.

The initial Advisor also reported seven SECURITY DEFINER views and existing
function/search-path warnings. These are separate from the seven table RLS
findings; resolving this migration does not certify the entire project secure.
Existing permissive policies and public privileged RPCs need a separate,
application-wide authorization review. This scoped change does not expand them.

The draft branch disables automatic Vercel deployment. Production publication
requires explicit approval after automatic review rejected the direct main push.

## Verified live state after the first migration

The production read-only role checks passed for all six hardened tables.
The public/private database function-definition checksum was identical before
and after. Security Advisor at 2026-11-02 05:11:39 UTC (November 1 in Chicago)
reported one remaining `rls_disabled_in_public` finding: `base_code_pool`.
Its final migration is intentionally pending the compatible API/client release.
The full local build and existing regression suite passed, followed by all
11 security test groups against the final two-stage migration.
No authenticated production UI workflow was exercised and no real business
rows were created, changed or deleted during testing.
