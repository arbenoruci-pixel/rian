


# TEPIHA — RIAN-MAIN (SPEC & LOGJIKA)

Kjo README është “source of truth” për rregullat e aplikacionit. Qëllimi: kur bëjmë ndryshime, i targetojmë saktë pjesët në source pa i prishur pjesët tjera.

---


## 1) ROLLET / PIN / PAGESA ME ORË


- **Përdoruesit** ruhen në LocalStorage: `tepiha_users_v1`.
- Login ruhet te: `tepiha_current_user_v1`.
- Role:
  - **ADMIN**: mund të krijojë/editojë puntorë, t’i bëjë active/inactive, të ndryshojë role, të bëjë **topup/investim** dhe **terheqje nga buxheti**.
  - **WORKER**: operon normalisht por s’ka privilegje admin.
  - (Transport/Dispatch do shtohet si role më vete në fazat e Transportit.)
- **Ndryshimi i PIN**: punëtori, pasi bën login, duhet të ketë opsion ta ndryshojë PIN-in e vet dhe ai PIN të ruhet për të.
- **Paga/orë**: ADMIN mund të vendosë pagë/orë edhe për veten dhe për admin tjetër (p.sh. vëllai).

---

## 2) STATUS FLOW (POROSITË)

Statuset:
- `pranim` → `pastrim` → `gati` → `dorzim`

Rregulla:
- **PRANIMI** krijon porosinë dhe e çon në **PASTRIM**.
- **PASTRIMI** kur mbaron e kalon në **GATI**.
- **GATI**: porosia njoftohet me mesazh dhe pret marrjen.
- **DORZIM**: pagesa finale dhe porosia del nga lista aktive.

---

## 3) KODI (NR RENDOR) — NUMRA VETËM

- Kodi është **numër** (p.sh. `57`).
- Display mund të jetë `KODI: 57`, por në data ruhet pa prefix.
- Kodi rezervohet me lease (30 min) për të mos u përzier.

---

## 4) TE PA PLOTSUARA

- Ekziston listë **TE PA PLOTSUARA**.
- Qëllimi: me leju ruajtje draft kur s’ka të gjitha të dhënat.
- Transporti do ketë **te pa plotsuara vetëm të transportusit** (jo të tjerëve) — do ndahet me “ownerId/transportId”.

---

## 5) PAGESA & BORXHI

- Totali = `m2_total * €/m2`.
- Klienti mund të paguajë **në fillim** ose pjesërisht.
- Borxhi = `total - paid` (nëse pozitiv).
- Kthimi = `paid - total` (nëse pozitiv).
- Çdo pagesë e regjistruar duhet të reflektohet në **ARKË** (cash).

---

## 6) SHKALLORE (STAIRS)

- Shkalloret nuk hapin shumë rreshta.
- Futet **qty** (numri i hapave/copave) dhe **m² për copë** (default 0.3).
- Total shkallore = `qty * 0.3` (ose per).

---

## 7) KAPACITETI (FLOW I DITËVE)

- Kapaciteti i ditës: **deri 400 m²**.
- Kur **PASTRIMI** ka > 400 m², konsiderohet overflow dhe premtimi i marrjes rritet.

Shembull logjik (si e kemi diskutuar):
- `<= 400 m²` → **MARRJE PAS 2 DITËVE**
- `> 400 m²` → **MARRJE PAS 3 DITËVE**
- (Shkallë të tjera mund të përdoren më vonë: 600/800/…)

Kjo shfaqet si “KAPACITETI NË PASTRIMI: X m²” + label.

---

## 8) ARKA (Baza) — CLEAN LOGJIK

Arkë është cash.

**Seksione kryesore**:
- PAGESAT SOT
- SHPENZIME
- BUGJETI I KOMPANISË
- INVESTIME
- PUNTORËT

### 8.1 Bugjeti (ADMIN)
- Bugjeti i kompanisë ruhet veçmas nga cash.
- ADMIN mund të bëjë **TERHEQJE NGA BUXHETI** me:
  - shumën
  - kujt i është dhënë
  - arsyen (e detyrueshme)

### 8.2 Investime
- Investimet janë para të futura në kompani (p.sh. Arben 21k, vëllai 16k).
- Regjistrohen si “topup/investim” (ADMIN).

---

## 9) TRANSPORTI — PLAN LOGJIK (FAZA)

### Qëllimi
Transportusi pranon porosi në terren dhe i sjell në bazë. Baza i pastron dhe i paketohen, por porositë e transportusit **nuk dalin në GATI të bazës** — dalin në **GATI të transportusit**.

### 9.1 Numrat rendor të transportusit
- Rekomandim: prefix **T** (p.sh. `T57`) për t’i dalluar nga porositë e bazës.
- Këto kode janë **të veçanta** dhe nuk përzihen me kodet e bazës.

### 9.2 Sinkronizimi me kapacitet
- Kur transportusi i pranon porositë (të kompletuara), baza duhet të shohë **M2 në ardhje** (incoming) për kapacitet.
- Deri sa nuk bëhet “Shkarkim në Bazë”, porositë janë **incoming**.

### 9.3 Shkarkim në bazë
- Kur transportusi vjen, klikon “SHKARKIM NË BAZË”.
- Porositë krijohen/kalojnë në listën **PASTRIMI** të bazës (si porosi normale), me mundësi editimi (copa të fshehta, shtesa, etj.).

### 9.4 GATI për transportusin
- Kur baza e kalon në **GATI**, këto porosi shfaqen te lista “GATI” e transportusit (jo te gati e bazës).

### 9.5 Arka e transportusit
- Transportusi ka arkë të vet:
  - hap ditën
  - mbledh pagesa
  - shënon shpenzime (naftë, etj.)
  - në fund sistemi i nxjerr: **SA DUHET T’I DORZOJË BAZËS** = (cash i mbledhur) − (shpenzime të aprovuara)
- “Transfer” nuk përdoret.

### 9.6 Bonus transportusi
- Bonus: çdo **500 porosi** të sjellura → **100 €** bonus.

---

## 10) FILET KRYESORE QË PREKIM

- `app/pranimi/page.jsx` — pranimi + pagesa + shkallore + te pa plotsuara
- `app/pastrimi/page.jsx` — lista pastrim + kapacitet
- `app/gati/page.jsx` — ready list + aging colors
- `app/marrje-sot/page.jsx` — pickup list
- `app/arka/page.jsx` — arka + puntorët + bugjeti + investimet
- `lib/*` — helpers/store

---

## 11) RREGULLI I ARTË (MOS PRISH)

- Ndryshime **të targetuara**, pa refaktor.
- Pa ndryshuar UI/strukturë pa arsye.
- Kur shtojmë logjikë, e shkruajmë këtu në README.
