# ARKA • SHPENZIME

## ÇKA U BO
- U shtua moduli i veçantë **SHPENZIME**: `/arka/shpenzime`.
- Shfaq vetëm lëvizjet **OUT** (dalje cash).
- Shton shpenzim të ri (OUT) vetëm për role: **ADMIN/OWNER/DISPATCH**.
- Supabase është master; local përdoret vetëm kur DB s’punon.

## KU ME PREK
- Menu:
  - `app/arka/page.jsx`
- Moduli:
  - `app/arka/shpenzime/page.jsx`
  - `lib/arkaDb.js` (dbAddMove, dbListMoves, dbCanWork)

## SHËNIME
- Kjo faqe kërkon që dita të jetë e hapur (HAP DITËN te `/arka/cash`).
