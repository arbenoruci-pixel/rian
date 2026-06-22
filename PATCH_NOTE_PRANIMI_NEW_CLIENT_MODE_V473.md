# Pranimi V473 — Explicit New Client Mode

## Root rule

A normal entry into **PRANIMI** now always starts a clean new-client draft:

- keeps only the allocator-issued code for the new draft;
- clears stale selected-client, name, phone, photo, search and match state;
- rejects stale existing-client handoff/session data;
- does not hydrate the previous `CURRENT_SESSION_KEY` unless the route explicitly requests `resumeCurrent=1`;
- ignores late asynchronous client-verification results after the draft/client context changes.

An existing client is loaded only through an explicit handoff:

- `existingClient=1`;
- a client ID or verified code/name/phone payload;
- source action such as **KRIJO POROSI TË RE PËR KËTË KLIENT**.

An incomplete draft is restored only through the explicit draft-open flow. Edit bridges from Pastrimi/Gati remain supported.

## Safety behavior

- Closing or changing a selected existing client restores the active draft's allocator code.
- Failed existing-client verification restores the active draft code.
- A stale verification promise cannot inject an old client into a newer Pranimi draft.
- Fresh Pranimi links clear stale existing-client handoff state before navigation.

## Database

This source patch does not delete or rewrite clients, orders, payments or allocator rows. It relies on the V39.1 live RPC path already deployed.
