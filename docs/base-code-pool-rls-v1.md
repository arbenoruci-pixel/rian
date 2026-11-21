# Base code pool access protection

## Scope

`public.base_code_pool` is the internal numeric-code reservation ledger. Before
this change its RLS setting was disabled and the `anon` and `authenticated`
roles had every table privilege, including `TRUNCATE`.

Pranimi's incomplete-draft guard and Pastrimi's repair diagnostic now read code
statuses through `POST /api/base-codes/status`. The server checks the existing
approved device, the linked active worker, and a base/admin role. A request may
inspect up to 160 explicitly named positive integer codes. List/diagnostic
responses contain only `code`, `status`, and `lease_expires_at`. When opening a
shared draft, Pranimi also supplies its exact code and draft-session identifier;
only a matching reserved row may return its original reservation owner and that
same identifier. This preserves the existing cross-worker draft lifecycle
without exposing owners during code enumeration. Responses are private and
never cached.

The SQL change enables RLS and removes **all direct table privileges** from
`PUBLIC`, `anon`, and `authenticated`. There is deliberately no browser-role
policy on this internal table. The existing server role and database-owned
allocator functions retain their access.

This is a targeted table-access fix. Existing PIN-gated allocator/offline RPC
signatures, their execute grants, login/device approvals, customer tables,
orders, payments, the code sequence, and saved offline work are unchanged.
The existing RPC authorization model is not a new device-bound security model;
hardening that separate API surface requires a coordinated client migration.

## Release order

1. Run the authorization/consumer regression tests and the full production build.
2. Rehearse the SQL change, allocator/offline compatibility and rollback inside
   the rollback-only subtransaction in
   `sql/base_code_pool_access_test_rollback_v1.sql`. It verifies full pool, lease,
   user, sequence and access-metadata restoration before returning its result.
   Keep its safety preconditions; never use a worker's real
   offline-code bank as a test fixture.
3. Publish the application update first. Verify the production deployment's
   exact commit and test both rejected anonymous requests and an approved
   worker's read-only status request.
4. Apply the table-access SQL only after the deployed application passes those
   checks. Verify RLS, all direct table privileges, the unchanged RPC contracts,
   and authorized status reads again.
5. Check runtime errors and the Supabase security advisor. The specific
   `rls_disabled_in_public` finding for this table must disappear.

## Installed phones and offline work

Older cached bundles query the table directly with the public API key. They
cannot use the new protected read until they load the updated app. Publish the
new bundle before changing database access and use the app's existing safe
service-worker update. After publication, close and reopen the app while online
to receive it. Keep localStorage, IndexedDB, offline drafts, outbox entries and
`APP_DATA_EPOCH` intact. Do not reinstall or clear website data.

If an old tab's status lookup is denied, Pranimi retains local/DB draft data;
remote storage-only drafts can be temporarily hidden until the app updates.
This does not delete them. Code reservation, verification and offline lease
consumption keep their existing RPC paths.

## Rollback

`sql/base_code_pool_access_rollback_v1.sql` restores the original RLS and
table-grant state. It does not
restore an old copy of any data, so orders and customers created after release
are retained. Rehearse it before release and keep it available with the apply
script `sql/base_code_pool_access_apply_v1.sql`. Run
`sql/base_code_pool_access_verify_v1.sql` to inspect the resulting permissions.

**Restore database access first if an application rollback is needed.** An old
bundle depends on the original direct read. The new bundle also works after
database access has been restored, so database rollback alone is the smallest
recovery step. It temporarily reopens the original direct-table exposure and
should be followed by a corrected release.

The pre-change production recovery point is:

- Repository commit: `8159aa183c955248c54fde551b349fa705a28db8`
- Vercel project: `prj_W5nwXeKHqk92Nt9IEWXkgaIjsEtF` (`rian`, team `tepiha`)
- Production deployment: `dpl_Gv1cK2LhVpAjBo55nxtR4tsvbrRH`
- Production domain: `https://tepiha.vercel.app`

After database rollback, use Vercel's rollback to that deployment if required,
then revert the application PR in Git to make the source match production.
Vercel rollback pauses automatic production-domain assignment; explicitly
promote the corrected production build when resuming releases. Never restore
the entire customer/order database for this permissions-only change.

## Verification boundaries

Authorization tests exercise actual route/server code with controlled database
responses. Consumer tests exercise the actual page functions for canonical
code states, meaningful drafts and lookup failures. The existing full build
also covers login/device approval, new/existing clients, code allocation,
payments, transport and offline workflows. Transactional hosted SQL checks
exercise PostgreSQL permissions and the deployed allocator functions.

Automated checks do not prove every installed phone has refreshed. A phone
still showing the old draft list should reopen the app online. Do not discard
its local work to resolve a stale bundle.

The pre-release hosted rehearsal passed all 24 functional checks. It confirmed
exact restoration of pool rows, offline leases, users, sequence state and access
metadata, and exercised the emergency permission rollback. The final local full
production build and both new access/consumer suites passed. The hosted test
deliberately avoids inserting a customer/order and leaves no business fixtures.
