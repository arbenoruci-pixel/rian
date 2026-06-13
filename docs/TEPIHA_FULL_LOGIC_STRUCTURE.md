# TEPIHA — FULL AGREED LOGIC (STRUCTURE ONLY)

This document is the **structure/skeleton** for the agreed logic. It does **not** change existing PRANIMI/PASTRIMI/GATI/MARRJE-SOT pages yet.

## Core rules (non‑negotiable)
- Keep dark UI + compact lists. No refactors/renames.
- Cash only.
- Base order codes are numeric and **generated only in Base PRANIMI**.
- Transport order codes are **T‑prefixed** (T1, T2...) and never mixed with base.
- Same client keeps same code forever; next visit = reactivation.

## Roles
- ADMIN
- PUNTOR (base worker)
- TRANSPORT
- DISPATCH

## Login + PIN
- Login via PIN.
- First login forces PIN change.
- Worker can change own PIN.
- Admin can reset worker PIN (forces change again).

## Clock‑in / Clock‑out (planned)
- Each worker has shifts:
  `{ worker_id, role, clock_in, clock_out, breaks[], hourly_wage }`
- Worked time = (clock_out - clock_in) - breaks.
- Pay = hours * hourly_wage.

## Base workflow (unchanged)
`pranim → pastrim → gati → dorezim`

## Transport workflow (separate)
`transport_incomplete → transport_ready_for_base → pastrim → gati_transport → dorezim_transport`

### Capacity
- Base daily capacity: 400 m².
- `transport_ready_for_base` **reserves** capacity (coming list for Dispatch/Base).
- When transporter presses **SHKARKO NË BAZË**, status becomes `pastrim` and capacity becomes active.

### Base + Transport interaction
- After unload: appears in Base PASTRIM.
- Base can edit and continues normal wash/pack.
- When Base marks GATI: it **does not** show in Base GATI list; it shows in **GATI TRANSPORT** for that transporter.

## ARKA (cash only)
### Transport ARKA
- Open day
- Collect cash
- Add expenses (fuel, road, etc.)
- Close day → net amount to deliver to base

### Base ARKA
- Receives **net** only.
- Logs transporter delivery + transporter expenses.

## Approvals (planned)
- PUNTOR can add small expenses.
- If expense > threshold → requires DISPATCH approval.
- PUNTOR never sees budget totals.

