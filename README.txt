PATCH: BASE MASTER CACHE HYDRATE + HOT WRITE

Changed files:
- app/gati/page.jsx
- app/pastrimi/page.jsx

What changed:
1) If base master cache is empty on refresh/mount, pages now call ensureFreshBaseMasterCache() and rebuild from local orders.
2) Gati now patches base master cache immediately from DB rows during refresh.
3) Pastrimi now patches base master cache immediately from DB mirror rows during refresh.

Why:
- Fixes master_cache_sync count=0 after deploy/epoch change.
- Fixes fast navigation Home -> Pastrimi/Gati before delayed cache persist finishes.
- Avoids DB/schema changes.
