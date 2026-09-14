# Kartela familjare — implementation and verification

Status: draft, no deployment and no production migration. Built against main `f4a7cdb`.

## User flow

Open the client card from Base or Transport. “Shto familjar / telefon” stores named family contacts. “Lidh / Merge kodin” searches an existing code, phone or name, shows the affected cards and asks for confirmation. Both permanent codes remain visible and searchable. “Shkëput” undoes a link; a linked subtree and its originally owned contacts stay together.

A single family can include Base and Transport clients. The combined card reads their exact visits and payments; it does not reassign financial rows. Every order keeps the person/phone submitted for that visit. Smart Message uses that exact visit contact and adds a signed family capability to its existing `/k/<exact order id>?src=...` URL, followed by an optional invitation. On the tracking page the customer can add names/phones. Existing tracking, GPS and depot-choice behavior remains available.

Invitation:

> Në këtë link mund t’i shtoni edhe emrat dhe telefonat e familjarëve që i sjellin tepihat, që t’i lidhim me kartelën tuaj dhe të shmangim ngatërrimet.

## Data and identity

- Additive `client_family_nodes`, `client_family_contacts`, `client_family_operations` tables; original client masters, codes, order foreign keys, statuses and payments are unchanged by merge/unmerge.
- Family membership is a tree. Root/revision checks prevent stale staff edits; a UUID receipt makes a lost-response retry idempotent. Mutations and new-master integrity checks share one advisory transaction lock.
- Phone normalization matches the existing browser helper for Kosovo, Albania, North Macedonia, Germany, Austria and Switzerland. The legacy global SQL normalizer is unchanged.
- A registered phone resolves an existing member in the requested module. Creating the first master in the other module links it to the explicit family; a second master in the same module is rejected. Names alone never establish membership.
- Base final admission preserves the selected member/old code and visit contact. It rejects an unrelated selected card and asks staff to register an unrecognized phone before replacing a linked family's master contact.
- Transport preserves its existing atomic allocator, order UUID/fingerprint retry rules and per-order phone. A guarded SQL patch inserts family resolution into the current allocator; changed upstream anchors cause the migration transaction to fail.
- Existing history limits still apply (160 visits in the displayed combined card). Legacy unlinked orders retain their existing exact-phone fallback. The family feature does not retroactively identify anonymous legacy orders.

## Access and rollout

Family tables, directory and data RPCs are service-role only with RLS enabled. The pure text phone normalizer is executable by browser roles solely to keep existing master writes compatible with the expression indexes; it reads no records. Staff use the existing approved-device API. The public link is HMAC-signed, expires after 30 days and is bound to the exact source/order/client. It permits contact append only. It does not disclose the family phone list, payment history, or permit merge/unmerge. Order reassignment invalidates the link; unlink follows the originally bound client.

`FAMILY_LINK_SECRET` is optional; otherwise signing derives a separate HMAC key from the existing service-role secret. No client secret is shipped. API responses are private/no-store, same-origin checked, with bounded request bodies and SQL contact/member limits. Multi-order bulk messages do not receive a family capability. If signing fails the original operational message remains usable.

Before the migration is installed, missing family RPCs disable family lookup/panels without breaking existing profile reads. Deploy the endpoint and UI together. The migration also installs expression indexes, so validate migration lock duration on staging before production.

The draft branch `feat/family-client-links` has Vercel automatic deployment disabled in `vercel.json`. See [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentenabled). Existing GitHub operational workflows target main or their own maintenance branches. This draft must not be merged/deployed until the remaining checks below pass.

## Automated verification

Run `npm ci`, then `npm run build`. The build includes the four family suites and existing regression gates. It finishes Vite production compilation and PWA generation.

| Suite | Evidence |
| --- | --- |
| `test:client-family-db-v1` | 40 scenarios on PGlite Postgres: merge/unlink, every alias, contacts, cross-module first master, original codes/orders/payments unchanged, atomic Transport create and UUID retry, stale simultaneous edits, actor/RLS checks, public append scope, rollback and normalization parity across 18 international formats, browser-role insert guard |
| `test:client-family-api-v1` | 22 scenarios through real server logic and SQL: protected API, exact-order token, tampering/wrong source/expiry, no public phone disclosure, combined history/debt/payments, exact-visit SMS contact, bulk/legacy compatibility and missing-migration fallback |
| `test:client-family-base-admission-v1` | 6 scenarios executing the production final admission function: family phone resolution, selected alias preservation, separate visit code, mismatched selected client, unregistered phone and no master overwrite |
| `test:client-family-ui-v1` | 12 React DOM → actual API → SQL interactions: Base/Transport merge, conflict correction, persisted reload, signed Smart Message, real tracking page customer form, invalid/old links, unmerge |

`npm run build` passed all current build gates. Three additional legacy test scripts outside the build gate fail identically on main `f4a7cdb` and on this branch: `test:transport-permanent-tcode` (12 old static assertions), `test:authoritative-offline-lists` (5 old snapshot-marker assertions), `test:base-ready-bonus` (5 old 48-hour bonus assertions). Their unchanged baseline failures are not a new feature regression. All other additional package test scripts passed.

## Still required before deployment

- Visual browser/mobile QA: local Chromium is blocked by the environment's socket policy; the connected browser cannot open localhost (`ERR_BLOCKED_BY_CLIENT`). DOM interaction tests passed, but they do not verify layout, touch scrolling, Safari behavior or installed PWA behavior.
- Run `node tools/serve-client-family-test.mjs` in an environment with a local browser; it binds only `127.0.0.1:4177`, uses synthetic data and the real family API/migration. `/` tests Base and `/test-transport` tests Transport. The real tracking page is used with a test-only order-read adapter. It never needs production credentials.
- On an isolated Supabase staging database, apply the migration against the actual schema, grants/triggers and current allocator. Verify two-device concurrency, rollback on changed anchors, index/lock duration and performance with representative data. PGlite checks actual PostgreSQL logic but does not reproduce hosted PostgREST, all production triggers or multi-connection lock scheduling.
- Verify approved Base/Transport/Dispatch devices, offline-to-online draft synchronization, double taps/lost replies, searches after merge/unmerge, and actual SMS/WhatsApp/Viber links on the business phones. No customer messages were sent during this work.

Do not drop the overlay tables as a rollback once contacts have been collected. Preserve their data and the master integrity guard. A temporary UI/API rollback needs to keep phone resolution working so family phones cannot create duplicates. Take a staging-verified backup and follow a reviewed rollout before touching production.
