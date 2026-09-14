# Dispatch location compatibility and compact client pages

The old public GPS button saved coordinates in `transport_orders.data`, while
the new Dispatch contact panel read only `client_family_locations`. Both GPS
forms were visible on signed tracking links. A successful legacy save therefore
appeared missing to Dispatch.

Staff location reads now use the exact visit's validated legacy GPS when it has
no newer family location submission. Empty, malformed and out-of-range values
are rejected; zero is valid. Legacy coordinates do not get a fabricated send
date. New submissions retain precedence and the existing token, device and
client/visit checks remain in place. No production data repair or migration is
needed, and no source order, payment, client or location is rewritten.

The open Dispatch panel refreshes on focus, page resume, visibility changes and
every 20 seconds while visible, with cleanup and aborted obsolete requests.
Signed tracking links show one GPS/address form; unsigned legacy links retain
their existing GPS button. The new form requires an explicit save acknowledgment
and retains its immutable request for an ambiguous-response retry.

Client facts, status and actions remain visible. Timelines, message templates,
editing, internal notes and cancellation are collapsed. The edit shortcut opens
its section before focusing the address. The modal is keyed by visit, uses a
two-column fact summary and constrains mobile input widths. The customer page
uses a compact name/code/status/amount summary and shorter location/family copy.
The read-only phone build guard checks the actual input attributes, and the
driver-release label assertions follow the updated wording.

Validation: 14 actual tracking/family React DOM/API/SQL scenarios and 15 Dispatch
contact/location scenarios, plus the complete production build gates. Regression
coverage includes a legacy order GPS with no new-table row, valid zero/invalid
coordinates, new submission precedence, only one form on an assigned transport
visit, public save through SQL to Dispatch's map link, focus refresh, old links,
token boundaries, retries, client switches, and unchanged financial/source rows.
Cloud browser navigation timed out; these checks do not establish physical
iPhone layout or native GPS/SMS behavior. No customer messages were sent.

Rollback application: prior commit `18811b8c7a1aa17c76cc4544053e06d89d8da809`,
prior deployment `dpl_6ctTVfwtWChenqgZ7EgeXwNcnktw`. Retain customer submissions
and the existing `tepiha_before_family_20260914` database snapshot.
