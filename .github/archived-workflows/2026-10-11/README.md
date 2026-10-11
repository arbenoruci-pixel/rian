# Retired invalid one-time workflows

Audit date: 2026-10-11. Reviewed source: `c2f98739edcc84a1a5ca40b111875a6824da5e1c`.

The four files here are byte-for-byte copies moved out of `.github/workflows`
and given a `.disabled` suffix. They are historical patch proposals, not CI
tests. Do not restore or execute them against current `main`: they rewrite
application code, reset old release/cache versions and push directly to `main`.
Recover individual ideas through a separately reviewed change with current tests.

## Confirmed cause of the empty failed runs

Embedded Python multiline strings contain JavaScript at insufficient YAML
indentation. GitHub rejects the workflow before scheduling a job, even when its
intended path filter would exclude an unrelated push. The payroll run page
explicitly reports `Invalid workflow file` and a YAML syntax error at line 36.
The Pastrimi run's jobs API returned `[]`. Local actionlint 1.7.12 and a separate
YAML parser reproduce syntax errors in all four files. These failures provide
no evidence about live application behavior.

| Archived file | Failed run | Local actionlint error location |
| --- | --- | --- |
| `one-time-fix-dispatch-payroll.yml.disabled` | [38097430022](https://github.com/arbenoruci-pixel/rian/actions/runs/38097430022) | line 36 |
| `one-time-fix-dispatch-phone-sw-compat-v1.yml.disabled` | [38097430666](https://github.com/arbenoruci-pixel/rian/actions/runs/38097430666) | line 45 |
| `one-time-fix-pastrimi-payment-expense-speed.yml.disabled` | [38097431402](https://github.com/arbenoruci-pixel/rian/actions/runs/38097431402) | line 31 |
| `one-time-fix-transport-phone-corruption.yml.disabled` | [38097432108](https://github.com/arbenoruci-pixel/rian/actions/runs/38097432108) | line 31 |

The fourth failure was discovered while checking all runs for the same commit.
It has the same root cause and is included to stop the remaining empty-run alarm.

## Comparison with current application behavior

| Historical proposal | Current source and retained coverage | Findings and limits |
| --- | --- | --- |
| Dispatch payroll access and worker cash credit | `app/arka/payroll/page.jsx`, `lib/arka/arkaEngine.js`, `lib/payrollMonthClose.js`; `test:unified-arka-payroll-v1`, `test:offline-incident-safety-v1` (includes Dispatch/drafts/payroll behavioral tests), `test:arka-final-integrity` | Dispatch is allowed through the current role guard and salary payment uses the active actor PIN. Salary, advances and worker cash use the current unified accounting flow. The old optional `cashCreditAmount`/`SALARY_CREDIT` conversion is **absent**, and existing tests do not prove that proposed feature. This cleanup does not introduce it or claim it shipped. |
| Dispatch phone/PWA compatibility | `tools/verify-home-search-local-oid-dedupe-v1.mjs`, `tools/verify-dispatch-phone-check-resilience-v2.mjs`, `tools/apply-dispatch-phone-check-final-identity-v2.mjs`; `test:home-search-local-oid-dedupe-v1`, `test:dispatch-phone-check-resilience-v2`, `test:dispatch-phone-atomic-fallback` | Compatible SW-generation checks already exist. The current final-identity layer and server-authoritative Dispatch path replace the old patch's implementation assumptions. All three checks remain in the production build. |
| Pastrimi payment/expense speed | `app/pastrimi/page.jsx`, `lib/pastrimiPaymentIntent.js`, `components/payments/payService.js`, `lib/arkaService.js`, `components/ArkaExpenseComposer.jsx`; `test:pastrimi-payment-background`, `test:pastrimi-payment-background-v2`, `test:pastrimi-payment-fast-close-v4`, `test:pastrimi-payment-touch-v3`, `test:arka-daily-expense-step-v1`, offline gates | Pastrimi has the later journal/outbox and immediate-close flow with stable payment identity and queued-state handling. Expenses include a date-scoped random-suffix identity. The old blanket 7-second options and generic expense queued-result fallback are **not present as proposed**; current tests cover the later flows, not those exact historical edits. |
| Strict Transport phone validation/dialing | `lib/transport/phone.js`, `lib/transport/board/shared.js`, `app/transport/item/page.jsx`; retained Dispatch phone, Transport recovery and atomic-create coverage | The historical `canonicalizeTransportPhoneForDial` helper and exact eight-digit Kosovo validator are **absent**. Current normalization and dialing use different helpers. Existing coverage must not be described as proving the unimplemented strict-dialing proposal. The archived code remains available for a separate phone-validation review. |

## Ongoing CI

`.github/workflows/ci.yml` now runs on every pull request targeting `main`, every
push to `main`, and manual dispatch, without path exclusions. It has read-only
repository permission and does not commit or push generated files.

- `Workflow validation` checks every active workflow with checksum-pinned
  actionlint 1.7.12. Embedded shell/Python linting is outside this configuration
  check; their scripts are not executed by the linter.
- `Build and regression tests` installs the lockfile, runs the existing payment
  PIN-session verifier, then runs the complete `npm run build`, including all
  existing prebuild steps and 77 test-script groups before the Vite/PWA build.
- Existing valid workflows, the legacy payment-PIN workflow, application code,
  package scripts, lockfile and deployment configuration are preserved.

Local verification uses Node 24 and the same commands as CI. The archived bytes
are checked against the original Git blobs. This is code/build regression
coverage; no live payments, customer records or physical-device state are changed.
