# Inventory audit

Admin and Dispatch open **AUDITIMI** from Pastrimi or Gati. Existing owner/admin role aliases are supported. Workers and Transport actors cannot load the audit or save its actions; approved-device identity is resolved by the API and active role is checked again inside the database write.

1. **Pastrim mbi 4 ditë** includes Base and Transport orders whose processing timestamp is older than 96 hours. Admission time is used only when an explicit processing timestamp/history is unavailable. `updated_at` never restarts the clock. Select visible rows, review the count, and confirm **Kalo në Gati**.
2. **Kontroll fizik në Gati** starts at **Pa kontrolluar**. After physically finding the carpets, choose **U gjet** or **Nuk u gjet**, optionally with a note. Missing orders stay in Gati. Filter by result or code/client/rack; **Rikontrollo** resets a result for another check.

The audit does not collect payment, send SMS, assign a fictitious rack, award bonuses, or close delivery. The previous client-side cleanup that delivered unverified orders has been retired. Existing normal payment, ready/rack, SMS and delivery actions remain separate.

## Persistence and retries

`POST /api/inventory-audit` requires same-origin JSON and an approved device belonging to a privileged active user. The list includes both order tables without requiring an attached client record. Failed or incomplete reads disable actions.

Writes call the service-role-only `inventory_audit_write_v1`. Each item locks its row, checks the precise `updated_at` revision, validates status and age again, and saves its attributed event atomically. Operation IDs make a lost-response retry idempotent. A bulk request reports individual outcomes, retaining failed selections for review. A conflicting status trigger rolls back that item instead of reporting a different result as success.

`inventory_audit_events` has RLS and no anonymous/authenticated access. Protected `data.inventory_audit` metadata keeps the latest state and cannot be erased or forged by ordinary offline clients. The legacy `data.audit` summary remains compatible with existing Gati badges. Audit events contain user IDs/names, never PINs.

The migration adds a narrow condition to the two existing Base payment reconciliation triggers. They skip only a new audit operation performed by this service-role RPC. The transaction-local operation marker is restored after the write. Ordinary ready/payment/offline writes keep their original trigger definitions and behavior.

Audit saving requires a connection and acknowledges only a server-confirmed result. Existing operational offline queues are unchanged. No existing order is moved or physically verified by installing the migration.

## Deployment and validation

Apply `supabase/migrations/20261011155334_order_inventory_audit_v1.sql` before deploying the API/UI. Its trigger adjustment fails closed if the known production trigger structure has changed. Application rollback can retain the additive audit schema and protected historical metadata.

`npm run test:inventory-audit-v1` runs real PostgreSQL-compatible PGlite migration/RPC integration tests plus React DOM interaction tests. It is part of the full `npm run build` CI gate. Coverage includes roles, 96-hour boundaries, both order sources, stale-device writes, idempotency, partial failures, payment/measurement preservation, bonus trigger isolation, missing-order retention, offline client protection and the phone-friendly two-step UI.

Mobile/desktop Chromium rendering and interactions were also checked with synthetic orders. Tests never move real customer orders or claim to establish physical inventory.
