# Ready notification history

GATI and the base-ready client-profile message modal now record separate events
for opening SMS/WhatsApp/Viber and the worker confirming or cancelling sending.
This is worker attestation, not carrier delivery/read evidence. Existing orders
without records display “Pa konfirmim dërgimi”; historical sends are unknown.

Each event has an immutable UUID and attempt UUID, base order ID, channel,
worker identity and client occurrence time. The authenticated API assigns the
author name and validates actor ID and ownership of the original opened event.
The database also records server receipt time. No message body is persisted.

Local capture happens synchronously before app handoff. A durable local journal
replays in order, under the original actor, after connection/resume. Explicit
storage failure prevents a misleading handoff acknowledgement. Pending records
are displayed as local; protected API failures remain visible. Cross-device
history loads through the authenticated API and is distinct from offline cache.
Reopening the sheet can resume confirmation of an earlier locally saved attempt.

Deploy prerequisite: apply sql/ready_notification_events_v1.sql. It creates an
append-only event table, RLS enabled, with no client/public privileges. Only the
server role has SELECT/INSERT. The no-RLS-policies advisor notice is intentional:
all access is through existing approved-device authentication and base/admin
role checks. The table cannot be read or written using browser Supabase roles.

Validation: executable tests cover status semantics, actor checks, replay and
conflict rejection, offline persistence, lost response after commit, authorization
failure, account switch and quota/corrupt storage. Full build passed. Schema
privilege query verified RLS=true, anon read=false, client insert=false, service
insert=true/update=false. No customer message was sent in testing. Authenticated
mobile end-to-end validation remains unavailable in this workspace.
