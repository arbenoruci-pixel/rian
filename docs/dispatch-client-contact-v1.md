# Dispatch client link and location

Dispatch's selected transport visit now has a dedicated short-link invitation in
Smart Message (SMS / WhatsApp / Viber). It requires successful link signing before
offering the message. Changing or closing the visit aborts outstanding requests.

The existing public family form additionally lets customers explicitly select
their current GPS location, review it on a map, add an address, and submit. Denied
GPS access supports a typed address. A lost response retains the same request ID
for retry and locks its inputs until resolved.

`client_family_locations` is an append-only server table indexed by source,
client and visit. Public writes require a valid unexpired family token and a
matching current order/client binding. Staff reads require the existing approved
device authentication. Only the exact selected visit is shown, avoiding an old
or another family member's address being substituted. Existing staff-entered
addresses, GPS, order/payment records and family identities are untouched.
Public info never returns submitted addresses, coordinates or family phone lists.

RLS is enabled; PUBLIC/anon/authenticated have no grants. Service role has only
SELECT and INSERT. The advisor's `rls_enabled_no_policy` INFO is intentional for
this server-only table; no client policy is needed.

The Dispatch card groups copying under More, uses a single message entry point,
improves timeline contrast, labels scheduling/editing in Albanian, aligns amounts,
and keeps the modal above floating search controls. Delivery and payment logic
is unchanged.

Validation: 13 new real React DOM/API/SQL scenarios plus the complete production
build and existing family tests. Covered signing failure, recipient switch races,
token/visit boundaries, replay, GPS denied/accepted, typed address, lost response,
staff refresh, map escaping, table grants and unchanged source records.
Cloud browser interaction timed out; physical iPhone appearance, GPS permission
and native message handoff remain user verification steps. No customer messages
were sent during testing.

Deployment order: additive table migration before app rollout. Prior application
commit is `d1b0d06eb921c752a27c20fb979b8915b70cb53c`; prior production deployment
is `dpl_2ad1hc9HrK1BHa2mDz4wowXT69jF`. Rollback the app to that deployment if
necessary and retain the new table to preserve customer submissions. The verified
pre-family database snapshot remains `tepiha_before_family_20260914`.
