# V477 — Pranimi existing-client direct lock from search

Issue observed:
- From Home/global search, worker tapped **KRIJO POROSI TË RE PËR KËTË KLIENT** on an existing client.
- Pranimi opened with a newly allocated code first.
- Phone-match popup then detected the old client and asked **PËRDOR KLIENTIN EKZISTUES**.
- Expected: the explicit search action should directly open Pranimi locked to the existing client code.

Fix:
- The home/search handoff no longer passes an order id as `clientId` when no real client id exists.
- Pranimi now resolves the explicit existing-client handoff against `clients` by id, code, phone/name fallback.
- If verified, Pranimi locks `codeRaw` immediately to the historical client code before form entry.
- It sets `selectedClient` and `clientMatchDecision` immediately.
- It does not reserve a new temp base code for this explicit existing-client path.
- If the existing client cannot be verified, it shows a blocking verification error instead of silently using a new code.

Expected behavior:
- Search result code 471 + button **KRIJO POROSI TË RE PËR KËTË KLIENT** opens Pranimi with badge 471.
- No temporary code 289 appears.
- No phone-match popup is needed for the same client.
- Final save uses `EXISTING_CLIENT_HISTORICAL_CODE` lifecycle.

Files changed:
- app/pranimi/page.jsx
- components/GlobalHomeSearch.jsx
- app/page.jsx
- tools/verify-pranimi-existing-client-handoff-v477.mjs
