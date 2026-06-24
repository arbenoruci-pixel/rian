# V474 — PASTRIMI disable 4-day delay review prompts

Purpose: remove the PASTRIMI system that auto-prompts after 4 days to explain why an order has not moved to GATI.

Changes:
- Added `PASTRIM_DELAY_REVIEW_ENABLED = false`.
- `getPastrimDelayReviewInfo()` now returns no active warning/due/softWarning when disabled.
- Auto-open modal on Pastrimi entry is disabled.
- Quick filter chips for delay review (`Mbi 4 ditë`, `Snooze`, `Due tani`) are removed from the rendered filter list.

Preserved:
- Normal PASTRIMI list.
- Manual GATI flow.
- Paketimi/rack gate.
- Debt/payment flows.
- Existing DB history fields remain untouched.

No SQL required.
