# Fletore lifecycle and identity reporting

The daily backup classified every non-completed top-level status as an active
order. Draft persistence deliberately uses `pranim` at the top level, with its
actual state in JSON. Archived duplicates also retain that legacy top status.
Consequently incomplete and already archived rows appeared in active totals
and recurring missing-client alerts.

The report also substituted a phone/code fallback candidate's name and code
for the identity recorded on the order. A shared or reused number could make
an uncertain match look authoritative.

## Changes

- Reuse the admission lifecycle helpers to distinguish operational visits,
  incomplete drafts, and archived drafts.
- Keep drafts in a dedicated email and Fletore section. Keep archived IDs
  visible and retain both sets of source rows in the JSON attachment.
- Preserve the order's recorded code, name and phone in unresolved cards,
  warning rows and attachment entries. Candidate details are explicit metadata.
- Preserve raw unresolved orders in the active `/api/backup/latest?live=1`
  payload, so code fallback enrichment cannot erase their recorded identity
  before Fletore receives them. Valid `client_id` enrichment stays available.
- Leave final ready/cleaning visits visible even when they carry stale draft
  flags. Leave ordinary `pranim` visits without draft markers active.
- Exclude drafts and archived records from the last operational visit lookup.

No write path, SQL function, schema, client merge, payment, code allocation or
SMS behavior is changed by this patch. This investigation does not establish
the historical order-first client-link patch as the cause of the reported
records. Drafts intentionally skip master-client creation until finalization.

## Validation

- Existing Fletore linking/pagination regression passes.
- Eleven new behavioral scenarios cover lifecycle classification, original
  identity display, ambiguity, a synthetic nineteen-row incident, and the
  actual live backup API through Fletore and cron HTML/JSON output. Email transport is mocked;
  the test sends no messages and uses no production credentials.
- Full `npm run build` passes, including the new Fletore regression gate.

Operational data repairs are separate, narrowly guarded transactions with
before/after snapshots in the existing repair log. Production data and private
incident evidence are intentionally excluded from this repository patch.
