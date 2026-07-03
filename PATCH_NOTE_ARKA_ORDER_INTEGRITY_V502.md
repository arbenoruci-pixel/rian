# PATCH NOTE — ARKA / ORDER INTEGRITY V502

Qellimi: mos me leju ma qe app-i ta shenoj order-in si `paid CASH`/`dorzim` pa u kriju/verifiku rreshti real ne `arka_pending_payments`.

## Problemet qe u targetuan

Nga DB health scan dolen keto klasa problemesh:

1. `paid_order_without_arka_payment` — order data thote pagume CASH, por nuk ka ARKA row.
2. `arka_payment_but_order_unpaid` — ARKA row ekziston, por order data ka mbet borxh.
3. `duplicate_active_payments` — pagesa active te dyfishuara.
4. `handoff_ledger_mismatch` — cash_handoff nuk perputhet me ledger.
5. `budget_summary_mismatch` — summary nuk perputhet me ledger.

Pas SQL cleanup, 4 check-at kryesore dolen 0. Patch-i V502 e mbron kodin qe mos te rikthehen.

## Ndryshime ne kod

### 1. `components/payments/PaySheetPortal.jsx`

- U bllokua mbyllja e pageses nese nuk ka `onSubmit` handler real.
- Nuk lejohet queue/local update qe veq e rrit `paid/paid_cash` ne order.
- Offline CASH payment nuk e mbyll order-in si te paguar; duhet ARKA transaction real.

### 2. `lib/syncEngine.js`

- Guard-i `ensureArkaPaymentBeforePaidCashOrderPatch` tash kap edhe patch-e qe kane `paid`, `paid_eur`, `paid_cash`, `debt`, ose `data.pay` edhe kur patch-i nuk e sjell statusin explicit.
- Guard-i lexon edhe statusin aktual ne DB (`dorzim`) per rastet ku patch-i vjen si payment update i veçante.
- Nese mungon active ARKA payment, e krijon permes `/api/arka/transaction` para se ta ruaj order patch-in.
- Nese mungon actor PIN, patch-i deshton dhe nuk e prish order-in.

### 3. `app/api/sync/route.js`

- I njejti ARKA guard u forcua per paid fields (`paid_eur`, `paid_cash`, `data.pay`).
- Numeric local_oid update path tash kalon guard-in para DB update.

### 4. `app/api/offline-sync/route.js`

- Legacy route u align me ARKA guard.
- `patch_order_data` dhe numeric-local-oid update nuk mund ta shenojne CASH order si paid pa ARKA transaction.

### 5. `package.json` / `package-lock.json`

- Version bump: `2.0.55-arka-order-integrity-v502`.

## Validim lokal

U kryen syntax checks per JS modules:

```bash
node -c lib/arka/arkaEngine.js
node -c lib/arkaCashSync.js
node -c components/payments/payService.js
node -c lib/syncEngine.js
node -c app/api/sync/route.js
node -c app/api/offline-sync/route.js
node -c server/index.mjs
```

`npm run build` nuk u krye ne sandbox sepse mungon `node_modules` / `vite` (`sh: 1: vite: not found`).

## Test plan pas deploy

1. Hap app-in ne Safari/Chrome fresh refresh.
2. Provo nje pagese CASH ne `gati`.
3. Kontrollo DB:
   - `arka_pending_payments` duhet me pas row me `order_id`.
   - `orders.data.pay.paid` duhet me perputh amount.
4. Provo offline: pagesa nuk duhet me u mbyll si paid pa ARKA.
5. Run `SQL_HEALTH_ARKA_ORDER_INTEGRITY_V502.sql`.

