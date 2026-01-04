TEPIHA PATCH — ARKA: SHPENZIME + BUXHETI (FIX)

QKA E RREGULLON KY PATCH:
1) BUILD ERROR: heq konfliktin e Git-it (>>>>>>> / ======= / <<<<<<<) duke e zevendesu krejt lib/arkaDb.js me version te paster.
2) BUXHETI I KOMPANISE: kur shton SHPENZIM me BURIMI = BUXHET, tani e ul balancin (krijon automatikisht OUT te arka_company_moves).
3) ORDER BY: mos me rrezu page-n kur DB s'ka kolonat `at` / `created_at` (ben fallback).

SI ME APLIKU (1 nga 1):
A) Shko ne repo: rian
B) ZEVENDESO file-in: lib/arkaDb.js  (copy nga ky patch)
C) ZEVENDESO file-in: app/arka/buxheti/page.jsx (copy nga ky patch)
D) Deploy prap ne Vercel.

TEST (shpejt):
1) Shko ARKA → SHPENZIME → zgjidh BUXHET → shto 20€.
2) Shko ARKA → BUXHETI I KOMPANISE → OUT (SHPENZIME) duhet me u rrit +20€ dhe BALANCI me ra.

Nëse don, hapi tjeter: e lidhim edhe CASH_TODAY expense me cycle OUT (ky patch e ben kur ka cikël OPEN).
