# ARKA • BUXHETI (CASH)

## ÇKA U BO
- Butoni **BUXHETI** në `/arka` lidhet me faqen **Supabase-first**: `/arka/cash`.
- Kjo faqe menaxhon: HAP/MBYLLE ditën, lëvizjet IN/OUT, totalet.
- Nëse DB s’punon, bie në **local fallback** (cache).

## KU ME PREK
- Menu:
  - `app/arka/page.jsx`
- Buxheti (cash):
  - `app/arka/cash/page.jsx`
  - `lib/arkaDb.js` (dbCanWork, dbOpenDay, dbAddMove, ...)

## SHËNIME
- `app/arka/buxheti/page.jsx` është legacy/local (mbetet në projekt, por menu e çon te `/arka/cash`).
