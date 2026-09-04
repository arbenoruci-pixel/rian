# ARKA open/close retired

- Payroll advances use a cycle-free writer.
- New active pending records strip `cycle_id` and `applied_cycle_id`.
- Legacy closed-day errors enter the compatibility fallback path.
- The daily-close shortcut is disabled.
- Historical records and migrations stay intact for audit history.
