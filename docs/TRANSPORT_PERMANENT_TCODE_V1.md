# Transport Permanent T-Code V1

Date: 2026-07-11
Project: tepiha-app
Source version: 2.0.56-transport-permanent-tcode-v1

## Qellimi

Transporti mbetet sistem i ndare nga Baza dhe ruan formatin e vet `T...`.

Rregulli final:

- `transport_clients.tcode` eshte T-kodi permanent i klientit.
- Klienti ekzistues e mban te njejtin T-kod ne çdo vizite.
- `transport_orders.id` (UUID) identifikon porosine konkrete.
- `visit_nr` dallon vizitat e klientit me te njejtin T-kod.
- Kod i ri merret vetem kur krijohet klient i ri.
- Smart SMS perdor UUID-ne e porosise konkrete.
- Linket e vjetra me T-kod vazhdojne te funksionojne si fallback historik.

## Gjendja para patch-it

- 768 porosi Transporti.
- 673 kliente master.
- 62 kliente me disa porosi.
- 46 prej tyre kishin T-code drift.
- 55 porosi kishin `client_tcode` ndryshe nga T-kodi master.
- 48 prej tyre ishin aktive.
- 711 porosi nuk kishin `visit_nr`.
- 153 kode ishin `used` pa klient, porosi ose pagese.
- Allocator-i mbante deri 20 kode gati per owner dhe rriti numrat deri mbi T1034.

## Rrenja e problemit

DB trigger-i i vjeter `transport_order_code_canonicalize()` bente:

```sql
new.client_tcode := new.code_str;
```

Kjo e kthente kodin e ri te porosise ne identitet te klientit. RPC-ja e vjeter `create_transport_order()` kishte te njejten sjellje. Frontend-i gjithashtu rezervonte kode para se te vertetonte telefonin.

## Ndryshimet e aplikuara ne production DB

Backup-et private u krijuan ne schema `backup_internal`:

- `transport_orders_before_permanent_tcode_20260711` — 768 rreshta
- `transport_clients_before_permanent_tcode_20260711` — 673 rreshta
- `transport_code_pool_before_permanent_tcode_20260711` — 1,058 rreshta
- `arka_transport_payments_before_permanent_tcode_20260711` — 601 rreshta
- backup i funksioneve dhe indekseve

Ndryshimet:

1. `client_tcode` u kanonizua nga `transport_clients.tcode` per çdo porosi te lidhur.
2. 6 porosi te vjetra u lidhen ne menyre te sigurt me klientin sipas telefonit unik.
3. `visit_nr` u rindertua sipas klientit dhe kronologjise.
4. `code_n` u sinkronizua me pjesen numerike te `code_str`.
5. UUID-ja e porosise u ruajt ne JSON si `order_id` dhe `public_order_id`.
6. Aliaset historike `code_str` u ruajten per pajtueshmeri me pagesat dhe linket e vjetra.
7. Trigger-i i ri mban `client_tcode` permanent dhe llogarit `visit_nr` me advisory lock.
8. RPC-ja `create_transport_order()` kerkon klientin me telefon dhe perdor T-kodin master.
9. Allocator-i kthen maksimum nje kod dhe zgjedh kodin me te vogel available.
10. U shtua `release_transport_code_if_unused()`.
11. U liruan 153 kode vertet te paperdorura.
12. U hoqen default-et e rrezikshme te `code_n` dhe `code_str` qe therrisnin sequence veçmas.
13. U shtuan indekse per klient, T-kod dhe vizite.
14. U shtuan T-format constraints.

## Gjendja pas patch-it ne DB

- 768 porosi.
- 673 kliente.
- 739 porosi te lidhura me klient master.
- 29 porosi historike pa lidhje te sigurt; porosia me e re prej tyre eshte 2026-06-05.
- 0 `client_tcode` mismatch ndaj klientit master.
- 0 porosi te lidhura pa `visit_nr`.
- 0 grupe me `visit_nr` te dyfishuar.
- 0 `code_n` mismatch.
- 0 kode `used` pa reference.
- 747 kode `used`.
- 311 kode `available`.
- kodi me i vogel available: T5.
- sequence qendrore mbetet 1057, por allocator-i tani riciklon T5, T9, T14... para se te krijoje numer te ri.

## Ndryshimet ne kod

### Self Entry

- U hoq prewarm-i 650 ms.
- Lookup-u i telefonit eshte fail-closed.
- Klienti ekzistues perdor T-kodin permanent.
- Klienti i ri merr vetem nje kod ne momentin final te save-it.
- Save-i perdor RPC atomike dhe verifikon `client_id`, T-kodin dhe UUID-ne.
- Kodi lirohet kur save-i deshton dhe nuk ka reference reale.

### Dispatch

- U hoq buffer-i i kodeve.
- Klienti ekzistues nuk merr kod te ri.
- Assignment/edit nuk rezervon kod.
- Klienti i ri merr vetem nje kod.
- Payload-i mban T-kodin permanent.

### Smart SMS

- Linku primar eshte `/k/<order-uuid>?src=transport`.
- UUID-ja e porosise ka perparesi ndaj T-kodit.
- Fallback-u me T-kod ruhet per SMS/linke historike.
- Tracking-u kerkon fillimisht porosine ekzakte; fallback-u me T-kod kerkon edhe `legacy_order_code`.

## Testet

Kaluan:

- `npm run test:transport-permanent-tcode` — 20/20
- `npm run test:pranimi-final-status`
- `npm run build`
- Smart SMS UUID check
- DB allocator test: kerkesa per 5 kode ktheu vetem T5
- DB release test: T5 u kthye `available`
- DB RPC rollback test: klienti T272 mori `client_tcode=T272`, `visit_nr=3`, UUID korrekt dhe zero rreshta testues mbeten

Nje test i vjeter `test:pranimi-new-client-mode` kontrollon nje rresht identik me regex ne modulin Baza dhe deshton ndaj burimit ekzistues. Ky test nuk lidhet me Transportin dhe patch-i nuk e ndryshon ate modul.

## Deploy

DB-ja production eshte patch-uar dhe verifikuar. Source zip-i duhet deploy-uar qe:

- frontend-i te ndaloje rezervimet paraprake;
- Self Entry dhe Dispatch ta perdorin rrugen e re atomike;
- Smart SMS te dergoje UUID-ne e porosise.

Deri ne deploy, DB-ja ruan pajtueshmeri me versionin e vjeter duke mbajtur `code_str` si alias historik dhe `client_tcode` permanent.

## Supabase advisors

Advisor-et nxoren disa probleme te vjetra te RLS, duplicate policies dhe indekse ne projekt. Ato jane jashte patch-it te T-kodit. Funksionet e reja kane `search_path` te fiksuar; allocator-i dhe release RPC nuk kane grant per rolin `PUBLIC`.
