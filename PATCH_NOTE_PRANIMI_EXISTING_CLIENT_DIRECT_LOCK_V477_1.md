# V477.1 — Existing-client direct lock: keep historical code for phoneless clients

This is a follow-up hardening on top of V477. V477 fixed the open path (search →
Pranimi opens locked to the historical client code with no new allocation). V477.1
fixes a remaining weak point in the **final save** path that was found during deep scan.

## What was still wrong

The final-save lifecycle decides between three modes:

- `EDIT_EXISTING_ORDER`
- `EXISTING_CLIENT_HISTORICAL_CODE`  (reuse the client's historical code, e.g. 471)
- `NEW_ASSIGNED_CODE`               (allocate a fresh pool code, e.g. 289)

To pick `EXISTING_CLIENT_HISTORICAL_CODE`, the save needed `resolvedSelectedClient`
to be non-null. That was gated by `isStrongBaseClientNamePhoneMatch`, which requires a
**valid phone** (≥ 8 digits) on the selected client and the form.

For a client that has no phone (or only a `PA NUMER <code>` placeholder), that gate
fails. `resolvedSelectedClient` became `null`, the lifecycle silently fell back to
`NEW_ASSIGNED_CODE`, and the allocator minted a brand-new code at save time — exactly
the "new code instead of historical 471" symptom this whole effort is meant to remove,
just moved from the open step to the save step.

The open path was correct (it locked 471 and showed badge 471), so the regression was
only visible at the very end, when the saved order came back under a new code.

## The fix

At final save, the explicit existing-client lock from search is now honoured directly,
without requiring the typed-phone strong match:

- A new `isExplicitLockedSelectedClient` flag is true only when **all** hold:
  - the session was opened through the explicit existing-client handoff
    (`newOrderUrlClientRef.current.explicit === true`),
  - the locked ref carries a real client id and a real code,
  - the still-selected client's id matches the locked id, **and**
  - the still-selected client's code matches the locked code.
- When true, `resolvedSelectedClient` is allowed to be the selected client even if the
  phone is empty, so the lifecycle stays `EXISTING_CLIENT_HISTORICAL_CODE`.

The strong phone/name match is what we want for **manually typed** clients; it is the
wrong gate for a client the worker explicitly selected from search. The historical code
is still proven before it is used: the `EXISTING_CLIENT_HISTORICAL_CODE` branch calls
`verifyExistingPranimiClientCode` → `verifyExistingClientCodeForSave`, which re-checks
`clients` by exact id + code (and tolerates an empty phone). Nothing is taken on trust.

## Why it cannot allocate a new code for an existing client

- Open path (V477): the allocator (`tryReserveCodeInBackground`) is never called in the
  `explicitExisting` branch of `resetForNewOrder`; the code is locked to the verified
  historical code, or the save is blocked with a verification error. (Statically proven:
  0 allocator calls in the existing branch, > 0 in the normal-new branch.)
- Autosave: the historical code is never reserved in `base_code_pool`, because
  `renewForDraft` only renews a code that the allocator itself assigned for this draft
  session (`assignedCodeForDraft`). The historical code was never assigned through the
  allocator, so the lease renew short-circuits with `RENEW_CODE_NOT_ASSIGNED`.
- Save path (V477.1): the explicit lock now reaches `EXISTING_CLIENT_HISTORICAL_CODE`
  for phoneless clients too, so the `NEW_ASSIGNED_CODE` allocator branch is no longer
  entered for an intentionally selected existing client.

## How it protects normal new Pranimi and draft resume

The guard is inert outside the explicit-search path, because every other entry resets
`newOrderUrlClientRef.current` to `{ explicit: false }` and clears `selectedClient`:

- normal new Pranimi (`resetForNewOrder` non-existing branch),
- `clearSelectedClientBinding` (worker clears/changes the client),
- Pastrimi/Gati edit bridge hydrate,
- draft open from "Te Pa Plotesuarat" (`applyDraftSnapshotToForm`).

So:

- Normal new client still allocates a fresh code and starts blank (V473 unchanged).
- Manual phone-typed match still uses the phone strong match and still shows the
  "PËRDOR KLIENTIN EKZISTUES" popup for manual entry.
- Draft resume from "Te Pa Plotesuarat" still keeps its reserved/locked code and its
  original `reserved_by` lifecycle PIN (V475 unchanged).
- Final status still settles to `pastrim` with the in-flight autosave barrier (V476
  unchanged).
- A stale lock ref combined with a cleared/different selected client cannot force the
  historical lifecycle, because the id+code corroboration fails.

## Files changed

- app/pranimi/page.jsx
  (final-save client resolution: add `isExplicitLockedSelectedClient` and include it in
  the `resolvedSelectedClient` decision; add an audit debug event)
- package.json
  (add `test:pranimi-existing-client-lock` script)
- tools/verify-pranimi-existing-client-direct-lock-v477-1.mjs (new)

## Validation

- `node tools/verify-pranimi-existing-client-handoff-v477.mjs` → PASS
- `node tools/verify-pranimi-existing-client-direct-lock-v477-1.mjs` → PASS
  - static: handoff clientId fix, allocator isolation, V473/V475/V476 invariants,
    V477.1 save guard present
  - lifecycle test plan (all PASS):
    - search existing (phoned)      → EXISTING_CLIENT_HISTORICAL_CODE
    - search existing (phoneless)   → EXISTING_CLIENT_HISTORICAL_CODE
    - normal new client             → NEW_ASSIGNED_CODE
    - manual phone confirm          → EXISTING_CLIENT_HISTORICAL_CODE
    - stale lock + cleared client   → NEW_ASSIGNED_CODE
    - edit existing order           → EDIT_EXISTING_ORDER
- Whole-file bracket balance unchanged vs pre-edit backup.
- `npm run build` not run here: npm registry is blocked and `node_modules` is absent in
  this environment, so the Vite build could not be executed. Syntax of the edited region
  was validated with `node --check`, and the project verify tools above pass.

## Restrictions honoured

- No Service Worker / cache changes.
- No offline pre-reserved pool system.
- No DB schema / RPC changes.
- No mass delete or destructive DB logic.
- Offline-first behaviour for normal new Pranimi unchanged.

## Known limitation (unchanged by this patch, flagged for decision)

Existing-client-from-search requires connectivity: the boot verification
(`resolveExplicitExistingClientHandoff`) and the save verification
(`verifyExistingClientCodeForSave`) both require online. Offline, this specific flow is
blocked with a verification error rather than locking from cache — a deliberate
safety trade-off so a wrong client/code is never attached. Making it work offline would
require local client verification (a local clients cache), which is intentionally NOT
added here to respect the "no offline pre-reserved pool / no risky broad logic"
constraints. Normal new Pranimi remains fully offline-capable.
