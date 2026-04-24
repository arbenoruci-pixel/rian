# DEEP SCAN — Next.js -> sistemi i ri

Ky raport është bazuar në krahasim të strukturës `app/`, `app/api/`, `components/`, `lib/`, `src/`, `server/` dhe `api/`.

## Çka u verifikua
- U krahasuan të gjitha `app/**/page.jsx` route-t me `src/generated/routes.generated.jsx`.
- U kontrollua SPA fallback në `vercel.json` për deep-link / refresh.
- U krahasuan `app/api/**/route.js` me `server/index.mjs` dhe root `api/`.
- U kontrolluan login/auth/session flows, rolet, device approval dhe sign-out visibility.
- U kontrolluan shtresat e startup-it: `AuthGate`, `DeferredMount`, `ServiceWorkerRegister`, `OfflineSyncRunner`, `SyncStarter`, `RuntimeIncidentUploader`, `SessionDock`.
- U kontrollua shtresa e shimeve të migrimit (`src/shims/*`) dhe `styled-jsx` support në `vite.config.js`.

## A) Çka është kaluar mirë
1. **Page routes**
   - Të gjitha `app/**/page.jsx` route-t janë gjeneruar në `src/generated/routes.generated.jsx`.
   - Nuk u gjet route page-level që ekziston në `app/` e mungon në router.

2. **Deep-link / refresh fallback**
   - `vercel.json` ka rewrite SPA për route-t e frontend-it dhe përjashton `/api/*` dhe asset-et statike.
   - Kjo e mbulon direct open / refresh për route-t e UI-së.

3. **styled-jsx migration layer**
   - `vite.config.js` e ka `styled-jsx/babel` plugin.
   - Pra styled-jsx vetë nuk duket të jetë arsyeja kryesore e design mismatch.

4. **Core shell i migrimit**
   - `src/AppRoot.jsx` po i ngarkon route-t, `AuthGate`, `GlobalErrorBoundary`, `ServiceWorkerRegister`, `OfflineSyncRunner`, `SyncStarter`, `RuntimeIncidentUploader`, `SessionDock`.
   - `src/main.jsx` nuk përdor `StrictMode`, që ul double-mount risk në këtë migrim.

## B) Çka ishte pjesërisht e kaluar
1. **API migration**
   - Migrimi kishte kaluar login/version/runtime-incident.
   - Por root `api/` nuk i kishte realisht të gjitha endpoint-et që i përmendte `MIGRATION_NOTES_VITE.md`.

2. **Backup/restore layer**
   - Frontend-i i backup/restore ekzistonte.
   - `server/index.mjs` i kthente këto si placeholder `BACKUP_ENDPOINT_PENDING_PORT`.
   - Pra UI ishte aty, backend port jo.

3. **Auth role layer**
   - Login flow ekzistonte.
   - UI nuk i ofronte të gjitha rolet privilegjuese që pjesë tjera të app-it i pranojnë (`OWNER`, `PRONAR`, `SUPERADMIN`).

## C) Çka mungonte krejt dhe u shtua në patch
1. **Root API endpoints për deploy / Vercel / sistemi i ri**
   U shtuan këto endpoint-e reale në root `api/`:
   - `api/public-booking.js`
   - `api/transport/fletore.js`
   - `api/backup/latest.js`
   - `api/backup/run.js`
   - `api/backup/dates.js`
   - `api/backup/restore.js`
   - `api/cron/backup.js`
   - `api/backup/_shared.js` si helper i përbashkët

2. **Server wiring për backup/restore**
   - `server/index.mjs` u lidh me handler-at realë të backup-it, në vend të placeholder `501`.

3. **Legacy route alias**
   - U shtua alias për `/arka/puntoret -> /arka/stafi` në router-in e gjeneruar.

## D) Çka ishte thyer nga migrimi dhe u ndreq
1. **Logout / user icon / SessionDock në route jo-home**
   - `components/SessionDock.jsx` priste eventin `tepiha:home-interactive` edhe kur user-i nuk ishte në home.
   - Ky event emetohet nga home, prandaj SessionDock mund të mos montohej fare në route të tjera.
   - Kjo mund ta fshehë ikonën e user-it / sign out dhe ta bëjë sjelljen të duket si session ghost.
   - U ndreq: gating me `home-interactive` tash përdoret vetëm kur `pathname === '/'`.

2. **Login role mismatch nga UI**
   - `app/login/page.jsx` nuk i ofronte rolet `OWNER`, `PRONAR`, `SUPERADMIN`.
   - Pjesë tjera të app-it i njohin këto role si privilegjuese.
   - U ndreq: rolet u shtuan në login UI.

3. **Admin detection shumë e ngushtë**
   - Login handlers i trajtonin vetëm `ADMIN` dhe `ADMIN_MASTER` si admin bypass për approval.
   - U zgjerua logjika që të përfshijë edhe `OWNER`, `PRONAR`, `SUPERADMIN`.

4. **Legacy redirect i gabuar**
   - `app/admin/devices/page.jsx` e çonte user-in te `/arka/puntoret`, por route aktual është `/arka/stafi`.
   - U ndreq redirect-i.

5. **Backup/restore i thyer në serverin e ri**
   - `server/index.mjs` kthente 501 placeholder për:
     - `/api/backup/latest`
     - `/api/backup/run`
     - `/api/backup/dates`
     - `/api/backup/restore`
   - U ndreq me handler-a realë.

6. **Root API mismatch me MIGRATION_NOTES**
   - `MIGRATION_NOTES_VITE.md` thoshte që `public-booking` dhe `transport/fletore` janë portuar në root api.
   - Në kod ato mungonin realisht.
   - U shtuan.

## E) Çka duhet patjetër me u mbajt nën vëzhgim
1. **Ekzekutim full runtime smoke test**
   - Kjo patch i rregullon boshllëqet strukturore dhe endpoint mismatch-et.
   - Duhet ende smoke test real për:
     - login
     - logout
     - direct open / refresh në disa route
     - porosit public booking
     - transport fletore
     - backup / restore screens

2. **Endpoint-e Next legacy që ekzistojnë në `app/api`, por nuk po përdoren nga UI aktuale**
   - Janë ende disa endpoint-e në `app/api/**` që nuk janë portuar 1:1 në root `api/`.
   - Nga skanimi i thirrjeve aktuale të frontend-it, ato nuk dolën si thirrje aktive të runtime-it aktual.
   - Pra nuk u prekën në këtë patch për të mos rritur blast radius pa nevojë.

3. **SW / offline layer**
   - Kjo patch nuk e ndryshon business logic-in e offline motorit.
   - Nuk u prekën DB schema / tabela.
   - Nuk u bënë ndryshime destruktive.

## File-t e ndryshuara në këtë patch
- `components/SessionDock.jsx`
- `app/login/page.jsx`
- `lib/roles.js`
- `app/admin/devices/page.jsx`
- `src/generated/routes.generated.jsx`
- `api/public-booking.js`
- `api/transport/fletore.js`
- `api/backup/_shared.js`
- `api/backup/latest.js`
- `api/backup/run.js`
- `api/backup/dates.js`
- `api/backup/restore.js`
- `api/cron/backup.js`
- `api/auth/login.js`
- `app/api/auth/login/route.js`
- `server/index.mjs`

## DB impact
- Nuk u bë asnjë ndryshim në DB schema.
- Nuk u shtua asnjë migration SQL.
- Patch-i është i fokusuar në routing, auth/session behavior dhe API coverage të migrimit.
