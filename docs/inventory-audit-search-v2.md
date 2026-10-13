# Inventory audit: cross-stage search

Searching Auditimi by exact carpet code or explicit name/phone/rack mode now
looks through **all Pastrim and Gati orders** returned by the existing complete,
approved-device API. The active browsing tab, four-day threshold and previous
physical-check result do not hide matching active visits. Fresh processing
orders and orders with missing processing dates remain searchable.

Each result shows its real stage, source, pieces and entry date/order ID. A
summary counts matches in Pastrim and Gati separately. Base `1339` and Transport
`T1339` stay distinct, with no phone/rack/partial-code fallback. Repeated visits
remain separate. Inactive/delivered orders stay outside this active-stock audit.

During search, stage/result browsing filters are not presented as active.
**Pastro kërkimin** restores the prior browsing filter. Choosing a workflow tab
ends search and restores that tab's normal list. An empty processing query
still shows only visits older than 96 hours; an empty ready query defaults to
**Pa kontrolluar**.

Actions follow each result's actual stage. Fresh/unknown-date Pastrim results
are visible without a ready-verification button or bulk checkbox. Only overdue
processing results may be selected and explicitly confirmed for **Kalo në Gati**,
including when the search began on Gati. Ready results retain **U gjet**, **Nuk u
gjet** and **Rikontrollo**. Moving an overdue result updates that same visible
result to Gati, ready for a separate physical check. Search and mode changes
clear hidden bulk selections; the move payload uses only visible eligible rows.

No API/database/role changes or migration are required. Existing Admin/Dispatch
authorization, 96-hour database gate, revision checks, idempotent write handling,
payments, SMS, measurements and offline protections remain unchanged. Searching
never moves or verifies an order. Tests use synthetic records only.

`tools/verify-inventory-audit-search-v2.mjs` tests the pure selector. It is imported
by the existing UI regression suite, so `npm run test:inventory-audit-v1` and the
production `npm run build` gate run it. The UI regression reproduces code 1339
from either tab and deep links, stale-result filters, stage-specific actions,
mixed-stage repeated visits, safe bulk moves, cancellations, clear-search
restoration, exact code boundaries, permissions and failure handling.
