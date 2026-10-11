# Backup runtime and recorded order identity

Verified on 2026-10-11 against main `8166f9409c9b367ee9364ddb5a0b8ad65a436793`
and production deployment `dpl_EMarQ7EhqfhJ5s4t5omUNhNdnQjy`.

## Active runtime

- `vercel.json` explicitly selects Vite, `npm run build`, and `dist`. The
  production build log confirms Vite 5.4.21. The Vercel project metadata still
  labels the project `nextjs`; that label does not override the checked-in
  configuration used by this deployment.
- Vercel serves `api/backup/latest.js` and `api/backup/run.js`. The Express
  server imports and mounts these same handlers in `server/index.mjs`.
- Fletore calls these endpoints. Both use `api/backup/_shared.js` for live
  payload creation. Snapshot reads return the stored payload without enrichment.
- The active email cron is `api/cron/backup.js`; its separate Fletore report
  preserves unresolved source identity and labels candidate clients separately.
  Its mocked HTML/attachment regression remains part of `test:fletore-linking`.
- The daily transport report also uses the visit's recorded or embedded contact
  fields. It no longer substitutes a master code/phone candidate when top-level
  contact fields are empty; unknown contacts stay unknown.

## Removed legacy entry points

`app/api/backup/latest/route.js` and `app/api/backup/run/route.js` were dormant
Next App Router remnants. They independently joined by client code and could
replace a visit's identity. Neither is imported by the active server or UI.
They are removed instead of retaining a second payload implementation.

The current package has no Next dependency or Next build/start script. Switching
to Next would require deliberate dependency, build and routing changes. After
this removal, switching frameworks cannot reactivate these unsafe handlers.
If a Next runtime is introduced, implement and test adapters to the canonical
backup handlers; do not restore the old code from Git history. Other historical
Next endpoints are outside this cleanup and need review before a migration.

## Identity contract

Live JSON, raw downloads and newly created snapshots copy every original order
field without joining master identity into the row. This includes null/empty
names and phones, leading-zero codes, client IDs, visit numbers, timestamps,
embedded JSON, payment details and history. Valid client links also retain the
visit's recorded values when master contact information has changed.

Master clients remain a separate collection. Fletore still uses a valid
`client_id` for its current client display; unverified code/phone matches remain
review candidates. This change performs no merges, business-row writes,
migrations, restores, historical-snapshot rewrites or real backup runs.

## Regression verification

`npm run test:backup-identity` invokes the real Node handlers and Supabase query
builder with an in-memory HTTP transport. It covers ambiguous/equivalent codes,
duplicate and similar phones, missing/broken links, linked historical contact
data, null fields, embedded and string JSON, more than 1,000 clients and orders,
JSON/raw reads, manual/cron snapshot creation, access rejection and failed-read
handling, plus daily transport HTML/JSON with embedded or missing contacts.
Email delivery is captured in memory. Only synthetic snapshot inserts are accepted by the mock. It also
guards against reintroducing the removed Next entry points.

`npm run build` includes this regression, the existing Fletore/cron regressions,
the full application gates and the Vite production build.
