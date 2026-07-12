# Transport Permanent T-Code V2 — Source Release

Date: 2026-07-11  
Project: `tepiha-app`  
Source version: `2.0.57-transport-permanent-tcode-v2`

## Qellimi i release-it

Transporti vazhdon si sistem i ndare nga Baza dhe ruan identitetin e vet me prefiksin `T`.

Rregullat e implementuara:

- `transport_clients.tcode` eshte T-kodi permanent i klientit.
- Klienti ekzistues e perdor te njejtin T-kod ne çdo porosi.
- Klienti i ri merr vetem nje T-kod, ne momentin final te ruajtjes.
- Allocator-i zgjedh kodin me te vogel qe eshte realisht i lire.
- Kodi i rezervuar lirohet kur nuk perdoret.
- `transport_orders.id` eshte UUID-ja unike e porosise.
- `visit_nr` numeron vizitat per T-kodin permanent.
- Smart SMS hap porosine konkrete me UUID.
- Self Entry, Dispatch, porosia publike dhe offline sync perdorin te njejten porte atomike.

## Arkitektura finale

### Identiteti i klientit

```text
telefon i normalizuar
  -> transport_clients
  -> client_id
  -> T-kodi permanent
```

Per klient ekzistues:

```text
T272 / vizita 1
T272 / vizita 2
T272 / vizita 3
```

Per klient te ri:

```text
merret kodi me i vogel i lire, p.sh. T5
krijohet transport_clients me T5
krijohet porosia me UUID unik
T5 behet kodi permanent i klientit
```

### Identiteti i porosise

- `id` / UUID: identifikon porosine konkrete.
- `client_tcode`: identifikon klientin permanent.
- `visit_nr`: identifikon rendin e vizites.
- `code_str`: ruan aliasin publik/historik te porosise per pajtueshmeri.
- JSON ruan `order_id`, `public_order_id`, `transport_client_tcode` dhe lifecycle metadata.

## Rruget e ruajtjes

Te gjitha rruget aktive kalojne ne save atomik:

1. `app/transport/pranimi/page.jsx` — Self Entry.
2. `app/dispatch/page.jsx` — Dispatch.
3. `api/public-booking.js` — public booking deploy handler.
4. `app/api/public-booking/route.js` — public booking API route.
5. `server/index.mjs` — development/server public booking.
6. `app/api/offline-sync/route.js` — offline API sync.
7. `lib/transportCore/syncEngine.js` — active transport sync.
8. `lib/transportOfflineSync.js` — legacy local draft sync.
9. `lib/syncEngine.js`, `lib/offlineStore.js`, `lib/ordersDb.js`, `lib/ordersService.js`, `lib/transportOrdersDb.js` — generic/compatibility paths.

Nuk ka me `insert` ose `upsert` direkt aktiv ne `transport_orders` jashte portes atomike.

## Porta atomike

### Browser

`lib/transport/transportDb.js`

- ben lookup final te telefonit;
- deshtimi i lookup-ut e ndal ruajtjen;
- perdor T-kodin master per klientin ekzistues;
- perdor vetem nje kod te rezervuar per klientin e ri;
- therrit RPC-ne `create_transport_order`;
- verifikon UUID-ne, telefonin, `client_id`, T-kodin, `code_str` dhe `visit_nr`;
- pajton race condition kur i njejti telefon krijohet paralelisht;
- liron kodin e perkohshem kur kodi permanent fitohet nga DB-ja.

### Server

`lib/transport/transportServer.js`

- implementon te njejtin lookup dhe lifecycle per API/server/offline;
- ruan idempotence me UUID;
- riperdor kodin offline te rezervuar pa marre kod te dyte;
- perdor historine e vjeter vetem kur telefoni ka nje T-kod te vetem dhe te qarte;
- bllokon historine konfliktuese me disa T-kode;
- liron kodin pas deshtimit ose race reconciliation.

## Allocator-i

`lib/transportCodes.js`

- madhesia e pool-it ne klient eshte `1`;
- kodi merret vetem kur telefoni eshte konfirmuar klient i ri;
- DB-ja zgjedh T-kodin me numer me te vogel;
- mirror-i lokal verifikohet ndaj owner-it dhe statusit ne DB;
- kodet qe kane reference ne klient, porosi, alias historik ose pagese nuk riciklohen;
- `release_transport_code_if_unused` e liron kodin vetem pas kontrollit ne DB;
- API-ja e vjeter `lib/transportCodePool.js` delegon te allocator-i canonical.

## Normalizimi i telefonit

Moduli i ri `lib/transport/phone.js` unifikon formatet e telefonit ne browser dhe server.

Mbeshteten:

- Kosove: `+383`, `00383`, format lokal `04...`;
- Shqiperi: `+355`, `00355`;
- Maqedoni e Veriut: `+389`, `00389`;
- Zvicer: `+41`, `0041`;
- Gjermani: `+49`, `0049`;
- Austri: `+43`, `0043`.

Shembuj:

```text
+383 45 255 074       -> 45255074
00383 045 255 074     -> 45255074
045 255 074           -> 45255074

+355 68 123 4567      -> 355681234567
00355 068 123 4567    -> 355681234567
```

Per shtetet tjera kodi i shtetit ruhet ne identity key, qe numri nderkombetar te mos perplaset me nje numer lokal te Kosoves.

## Self Entry

- nuk rezervon kod sapo hapet forma;
- ben lookup final para save-it;
- klienti ekzistues merr T-kodin permanent;
- klienti i ri merr nje kod ne fund;
- ndryshimi i telefonit pas zgjedhjes e zhvlereson identitetin e vjeter;
- rezervimi pastrohet pas save-it te verifikuar;
- drafti ruan prefiksin dhe telefonin e plote;
- SMS hapet vetem pasi ruajtja verifikohet.

## Dispatch

- nuk krijon klient para porosise;
- nuk mban buffer me shume kode;
- ben lookup live menjehere para vendimit per kod;
- perdor save atomik;
- verifikon UUID, telefon, permanent T-code dhe visit number;
- pas suksesit pastron rezervimin lokal.

Kjo shmang klientin jetim dhe T-kodin e zene kur porosia deshton.

## Offline sync

- ID-te lokale konvertohen ne UUID stabile;
- retry i njejte nuk krijon porosi te dyte;
- draftet e vjetra migrohen nga lista e objekteve ne layout-in real me ID + item key;
- prefiksi nderkombetar ruhet dhe rindertohet;
- klienti ekzistues merr T-kodin permanent;
- kodi offline lirohet kur nuk nevojitet;
- klienti i ri perdor kodin qe kishte rezervuar, pa marre kod tjeter.

## Smart SMS dhe tracking

`lib/smartSms.js` dhe `app/k/[id]/page.jsx`

Linku primar:

```text
/k/<order-uuid>?src=transport
```

Rregullat:

- UUID-ja e strukturuar e porosise ka perparesi ndaj ID-ve wrapper;
- lifecycle i ri pa UUID deshton sigurt dhe nuk hap viziten e fundit gabimisht;
- linket historike me T-kod vazhdojne si fallback;
- UUID-ja kerkohet direkt, pa fallback ne T-code;
- fallback-u T-code perdoret vetem per linke te vjetra.

## Historia dhe pajtueshmeria

Porosite e vjetra mund te kene `code_str` ndryshe nga T-kodi permanent. Release-i:

- ruan aliaset historike per Arka, audit dhe linke te vjetra;
- perdor `client_tcode` si identitet permanent;
- nuk riciklon kod qe figuron ne `legacy_order_code` ose `legacy_client_tcode`;
- bllokon telefonin historik kur ka disa identitete te mundshme.

## Testet e kaluara

```text
npm run test:pranimi-code                         PASS
npm run test:pranimi-allocator                    PASS
npm run test:dispatch-date                        PASS
npm run test:pranimi-new-client-mode              PASS
npm run test:pranimi-final-status                 PASS
npm run test:pranimi-existing-client-lock         PASS
npm run test:transport-permanent-tcode             PASS (106 checks)
npm run test:transport-server-atomic               PASS
npm run cycles:strict                              PASS
npm run build                                      PASS
```

Behavior tests perfshijne:

- klient ekzistues `T272` pa rezervim te ri;
- klient i ri merr `T5` para `T15`;
- offline client ekzistues liron kodin e perkohshem;
- offline client i ri perdor kodin e tij;
- race condition pajtohet me T-kodin master;
- histori me nje T-kod riperdoret;
- histori me disa T-kode bllokohet;
- formatet nderkombetare te telefonit nuk krijojne klient te dyte;
- telefoni i pavlefshem bllokohet para allocator-it;
- Smart SMS hap UUID-ne ekzakte.

Build-i ka vetem paralajmerimet ekzistuese te Vite per mixed static/dynamic imports dhe madhesine e chunk-ut. Nuk ka build error ose circular dependency.

## Gjendja e DB-se gjate kesaj faze

Gjate punes ne source V2 u be vetem lexim i definicioneve te funksioneve ne production Supabase. Nuk u ekzekutua migration, update, insert, delete ose cleanup ne kete faze.

Source-i eshte harmonizuar me funksionet production qe ishin instaluar ne fazen e DB-se:

- `create_transport_order(...)`;
- `reserve_transport_codes_batch(...)`;
- `release_transport_code_if_unused(...)`;
- `transport_order_code_canonicalize()`.

## Deploy

Paketa duhet deploy-uar si release i aplikacionit. Pas deploy-it, klientet aktive duhet te rifreskojne versionin/PWA-ne qe Self Entry, Dispatch dhe offline runtime ta marrin kodin e ri.

Kontrollet pas deploy-it:

1. Klient ekzistues: asnje rritje e pool-it dhe i njejti T-kod.
2. Klient i ri: merret kodi me i vogel i lire.
3. Dy porosi te klientit: `visit_nr` rritet dhe UUID-te jane te ndryshme.
4. SMS nga secila porosi hap UUID-ne e sakte.
5. Draft offline i klientit ekzistues liron rezervimin.
6. `pool_orphan_used = 0` mbetet invariant.
