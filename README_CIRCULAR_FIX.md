# TEPIHA Circular TDZ Fix V1

Ky ZIP është pa root folder. Kur ta unzip-osh në projekt, file-i kryesor është:

```bash
tools/apply-circular-fix.mjs
```

## Qëllimi

Patch-i e thyen lëmshin e importeve rrethore që Vite/Rollup mund ta kthejë në `ReferenceError: Cannot access ... before initialization`.

Qarqet që priten:

1. `lib/offlineStore.js` → `lib/baseMasterCache.js` → `lib/versionGuard.js` → `lib/offlineStore.js`
2. `lib/offlineStore.js` → `lib/syncManager.js` → `lib/syncEngine.js` → `lib/syncRecovery.js` → `lib/offlineStore.js`

## Çka ndryshon

Patch-i nuk prek DB, schema, pagesa, status-flow, outbox format, ose logjikë biznesi. Ndryshon vetëm mënyrën si ngarkohen modulet.

### `lib/offlineStore.js`

- Heq importin statik nga `@/lib/baseMasterCache`.
- E zëvendëson me `await import('@/lib/baseMasterCache')` vetëm kur duhet:
  - `getBaseMasterCacheKey`
  - `patchBaseMasterRow`
  - `removeBaseMasterRow`

### `lib/syncManager.js`

- Heq importet statike nga:
  - `@/lib/offlineStore`
  - `@/lib/syncEngine`
  - `@/lib/baseMasterCache`
  - `@/lib/syncRecovery`
- Shton wrappers asinkronë që i ngarkojnë këto module vetëm brenda funksioneve.

### `lib/syncRecovery.js`

- Heq importin statik nga `@/lib/offlineStore`.
- Shton wrappers asinkronë për:
  - `deleteOp`
  - `getAllOrdersLocal`
  - `getDeadLetterOps`
  - `getPendingOps`
  - `pushOp`
  - `saveOrderLocal`

### `lib/baseMasterCache.js`

- Ndërron `APP_DATA_EPOCH` që të vijë direkt nga `@/lib/appEpoch`, jo nga `@/lib/versionGuard`.

## Si ta aplikosh

Nga root i projektit:

```bash
node tools/apply-circular-fix.mjs .
```

Pastaj:

```bash
npm run build
```

Script-i krijon backup automatik për çdo file që prek:

```text
.bak-circular-tdz-v1
```

## Si ta kthesh mbrapa

Nëse duhet rollback manual:

```bash
cp lib/offlineStore.js.bak-circular-tdz-v1 lib/offlineStore.js
cp lib/syncManager.js.bak-circular-tdz-v1 lib/syncManager.js
cp lib/syncRecovery.js.bak-circular-tdz-v1 lib/syncRecovery.js
cp lib/baseMasterCache.js.bak-circular-tdz-v1 lib/baseMasterCache.js
```

## Test i shpejtë

Pas build-it, kontrollo që skaneri të mos e raportojë më:

```text
offlineStore.js -> baseMasterCache.js -> versionGuard.js -> offlineStore.js
offlineStore.js -> syncManager.js -> syncEngine.js -> syncRecovery.js -> offlineStore.js
```
