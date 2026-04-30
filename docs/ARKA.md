# ARKA (V2)

ARKA V2 është modul i ri, **clean** dhe **modular**, për menaxhimin e parave:
- pagesat
- shpenzimet
- borxhet (kush na ka borxh / kujt i kemi borxh)
- investimet
- mbyllja mujore me ndarje % mes owner-ave

## Rregullat e roleve

- **ADMIN**: sheh përmbledhje (TOTAL, NET, profit), mbyllje mujore, reset.
- **WORKER/PUNTOR**: sheh vetëm transaksionet individuale (pa TOTAL/NET).

Roli lexohet nga `localStorage.CURRENT_USER_DATA.role`.

## Struktura (file-t)

- `app/arka/page.jsx` — UI modulare me tabs.
- `lib/arkaV2Store.js` — datastore i ARKËS (localStorage-first).

## Storage keys (localStorage)

- `ARKA_V2_STATE` — gjendja e ditës + owner-at me %
- `ARKA_V2_TX` — transaksionet (IN/OUT)
- `ARKA_V2_WORKERS` — lista e punëtorëve (admin-only)
- `ARKA_V2_DEBTS` — borxhet
- `ARKA_V2_INVEST` — investimet
- `ARKA_V2_MONTHS` — mbylljet mujore

## Mbyllja mujore (MONTH CLOSE)

Mbyllja ruan:
- IN total
- OUT total
- NET
- ndarjen % për secilin owner

## Reset

Reset është vetëm për **ADMIN** dhe fshin vetëm ARKA V2 keys (nuk prek orders).

## Plan për “ONLINE” (Supabase)

Aktualisht store është localStorage-first. Hapi tjetër është të zëvendësohen funksionet në `lib/arkaV2Store.js` me thirrje Supabase (upsert/select) dhe localStorage të mbetet vetëm cache.
