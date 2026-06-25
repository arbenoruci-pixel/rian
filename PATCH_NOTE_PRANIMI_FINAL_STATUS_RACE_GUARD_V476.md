# PATCH NOTE — PRANIMI Final Status Race Guard V476

## Incident
A finalized PRANIMI order could be fully saved and consume its code, while the visible status later remained `pranim` instead of `pastrim`.

Confirmed real row shape:
- `base_code_pool.status = used`
- final order and client existed
- `data.state = pastrim`
- `orders.status = pranim`
- `data.status = pranim`
- lifecycle already said `DB_FINAL / DB_VERIFIED / finalized`

This caused search to show the order as PRANIM and kept it out of PASTRIMI.

## Root cause
A meaningful draft autosave could already be in flight when final save began. Clearing timers stopped future autosaves, but it did not cancel a request already waiting on lease/API/DB work.

There were two race windows:
1. Draft API/direct fallback performed a time-of-check/time-of-use update on the same `orders` row after final save.
2. The post-save client-master link patch did not send an explicit top-level status. If a stale draft write temporarily restored `pranim`, the link step inherited that stale DB status and copied it into `data.status`, while final `data.state = pastrim` remained.

## Fixes
1. **Server draft compare-and-swap**
   - Existing draft updates require the exact previously-read `updated_at`.
   - If final save changes the row first, the draft update matches zero rows and is blocked.

2. **Safe direct fallback**
   - Removed unconditional draft `upsert` by `local_oid`.
   - Direct fallback uses compare-and-swap for an existing draft and insert-only for a new draft.

3. **Generic final-order downgrade barrier**
   - `ordersService` rejects any draft-like update aimed at an already-final PRANIMI order.

4. **In-flight autosave barrier**
   - Mutable `finalSaveInFlightRef` stops an autosave after awaits and before any DB draft write.

5. **Explicit final status during client link**
   - Post-save client linking now writes the final status at top level and in normalized final data.

6. **Final read-back before code consume**
   - Before burning/releasing the lifecycle code, the app rewrites and reads back the exact final status.
   - Code consumption is blocked unless both `orders.status` and `data.status` match `pastrim/gati/dorzim` and the row is final.

## Safety
- No SQL or schema changes.
- No mass data operation.
- Existing V39.1 allocator path remains unchanged.
- Draft resume locked-code V475 remains intact.
- Existing-client explicit mode remains intact.
