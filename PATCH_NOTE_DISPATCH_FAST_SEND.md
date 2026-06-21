# DISPATCH FAST SEND — PATCH

## Problemi i gjetur

Kur shtypej **DËRGO**, rezervimi i T-code kontrollonte kandidatët një nga një. Për secilin kandidat shkarkoheshin deri në 5,000 rreshta nga tabelat e porosive, pagesave dhe klientëve. Çdo query kishte timeout rreth 5 sekonda. Kur shumë kode të ulëta figuronin të lira në pool, por kishin histori reale, pritjet 5-sekondëshe grumbulloheshin dhe mund të arrinin rreth 5 minuta.

## Rregullimi

- Kontrolli i historisë së T-code bëhet me query të filtruar në server dhe në grupe prej 64 kodesh.
- Tabelat nuk shkarkohen më me `select('*').limit(5000)` për çdo kandidat.
- Kandidatët e pool-it lexohen në dritare të vogla dhe renditen sipas kodit më të ulët.
- Claim-i i kodit bëhet me kusht mbi statusin dhe, kur ekziston, me ID-në e saktë të rreshtit.
- Rezervimi ka deadline të prerë 15 sekonda dhe timeout-e të kufizuara.
- Warm-up i kodit deduplikohet, prandaj klikimi **DËRGO** nuk nis skanim paralel të dyfishtë.
- Kërkimi i klientit me telefon kryhet vetëm një herë gjatë tentimeve për T-code.
- Shënimi final idempotent i kodit vazhdon në background pasi porosia ruhet me sukses.
- RPC fallback kërkon vetëm një kod, duke shmangur bllokimin e kodeve shtesë.
- Gabimet e proceseve background kapen për të shmangur promise rejections pa trajtim.

## Skedari i ndryshuar

- `app/dispatch/page.jsx`

Nuk kërkohet ndryshim SQL dhe nuk janë prekur skedarë të tjerë të aplikacionit.

## Verifikimi

- `npm run build` — kaloi me sukses; 600 module u transformuan.
- `npm run cycles:strict` — kaloi; nuk u gjetën varësi rrethore.
- Test rezervimi me T1–T90 të zëna — u rezervua T91 me 19 kërkesa të kufizuara.
- ZIP-i është **no-root**: gjatë ekstraktimit, hyrja kryesore është `app/dispatch/page.jsx`.

## Instalimi

1. Hape root-in e projektit.
2. Ekstrakto ZIP-in aty dhe lejo zëvendësimin e skedarit ekzistues.
3. Ekzekuto `npm run build` dhe deploy sipas procedurës së projektit.
