# ARKA (MODULAR MENU)

## Qëllimi
ARKA është paneli i administratorit për:
- cash-in (hap/mbyll ditën)
- shpenzimet
- pagesat
- raportet
- menaxhimin e userave (role + PIN)

## Struktura e fajllave
- `app/arka/page.jsx` — Menu kryesore e ARKËS.
- `app/arka/puntoret/page.jsx` — Lista/Shto/Ç'aktivizo usera (SUPABASE-FIRST; local fallback).
- `app/arka/buxheti/page.jsx` — Ditët e cash-it, shpenzimet, pagesat.
- `lib/arkaDb.js` — Operacionet Supabase për ARKA (arka_days, arka_moves).
- `lib/usersDb.js` — Operacionet Supabase për userat (tepiha_users).

## Supabase
- ARKA përdor `arka_days` dhe `arka_moves` (siç është në `lib/arkaDb.js`).
- Userat përdorin tabelën `tepiha_users`.

## Shënime
- Login është PIN-based me session 8 orë.
- Pas krijimit të userave në ARKË, login përdor Supabase-first dhe bie në local vetëm nëse tabela mungon.
