TEPIHA — Clean Fresh Build v3 (PRANIMI + PASTRIMI + GATI + ARKA) — 2025-10-13T18:24:52.852478Z

This is a brand-new project (no legacy code). It uses Supabase only.

PAGES

- /                Home (links)
- /pranimi/        PRANIMI with chips (tepiha/staza), totals, €/m², note, photo thumb, code from next_code(), save -> pastrim
- /pastrimi/       Lists status='pastrim'; button BËJE GATI -> status='gati'
- /gati/           Lists status='gati' with aging colors; button PAGUAR & DORËZUAR -> status='dorzim'
- /arka/           Shows today's delivered totals (sum of total where status='dorzim' and picked_at is today)

ASSETS
- /assets/supabase.js    Client with exports (rpc/select/insert/update/sbUpsert) and window.DB
- /assets/pranimi.js     PRANIMI logic + chips + save
- /assets/pastrimi.js    PASTRIMI logic
- /assets/gati.js        GATI logic
- /assets/arka.js        ARKA logic
- /assets/doctor_off.js  Blocks any 'doctor' route
- /assets/styles.css     Dark UI

SUPABASE SQL (run once):
- code_counter table + next_code() function
- orders_set_ready_at() trigger (optional)
- RLS: allow anon select/insert/update on public.orders; execute next_code()

Deploy statically (Vercel/Render). Ensure folder routes are enabled.
