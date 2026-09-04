#!/usr/bin/env python3
"""Retire the legacy ARKA daily open/close runtime without touching history.

This is intentionally strict: it patches only the known active runtime files and
fails if an expected legacy block cannot be found.
"""

from __future__ import annotations

from pathlib import Path


ROUTE_PATH = Path("src/generated/routes.generated.jsx")
LAYOUT_PATH = Path("app/arka/layout.jsx")
ARKA_PATH = Path("app/arka/page.jsx")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 match, found {count}")
    return text.replace(old, new, 1)


def write_changed(path: Path, original: str, updated: str, changed: list[str]) -> None:
    if original != updated:
        path.write_text(updated, encoding="utf-8")
        changed.append(str(path))


def patch_route(changed: list[str]) -> None:
    original = ROUTE_PATH.read_text(encoding="utf-8")
    updated = original

    import_line = "import ArkaDitorePageEager from '@/app/arka/ditore/page.jsx';\n"
    if import_line in updated:
        updated = updated.replace(import_line, "", 1)

    old_route = "  { path: '/arka/ditore', element: eagerElement(ArkaDitorePageEager, '/arka/ditore') },"
    redirect_route = "  { path: '/arka/ditore', element: <Navigate to='/arka' replace /> },"
    if old_route in updated:
        updated = updated.replace(old_route, redirect_route, 1)

    if redirect_route not in updated:
        raise RuntimeError("Safe /arka/ditore redirect is missing")
    if "ArkaDitorePageEager" in updated:
        raise RuntimeError("Legacy ARKA daily-close component remains in routing truth")

    write_changed(ROUTE_PATH, original, updated, changed)


def patch_layout(changed: list[str]) -> None:
    original = LAYOUT_PATH.read_text(encoding="utf-8")
    updated = original
    updated = updated.replace(
        "import ArkaDailyCloseShortcut from '@/components/ArkaDailyCloseShortcut.jsx';\n",
        "",
    )
    updated = updated.replace("        <ArkaDailyCloseShortcut />\n", "")

    if "ArkaDailyCloseShortcut" in updated:
        raise RuntimeError("Legacy floating daily-close shortcut remains in ARKA layout")

    write_changed(LAYOUT_PATH, original, updated, changed)


def patch_arka_page(changed: list[str]) -> None:
    original = ARKA_PATH.read_text(encoding="utf-8")
    updated = original

    disabled_row_accept = """  function handleAccept() {
      // ARKA_DAILY_CLOSE_V2_ONE_WAY: individual acceptance is disabled; Dispatch closes all confirmed cash in one wizard.
      if (typeof window !== 'undefined') window.location.assign('/arka/ditore');
    }
"""
    direct_row_accept = """  async function handleAccept() {
    if (onReviewAccept) {
      onReviewAccept({
        worker: workerSummary?.worker || { pin: row?.worker_pin, name: row?.worker_name },
        pendingHandoffRows: [row],
      });
      return;
    }
    if (review.hasDuplicateTransportItems) {
      alert('🔴 U GJET DUPLICATE TRANSPORT ITEM. Totali u shfaq me dedupe, por pranimi raw u ndalua për siguri.');
      return;
    }
    try {
      setBusy('accept');
      await acceptDispatchHandoff({ handoffId: row.id, actor });
      await onDone?.(row?.id);
      alert('✅ CASH U PRANUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U PRANUA CASH.'}`);
    } finally {
      setBusy('');
    }
  }
"""
    updated = replace_once(
        updated,
        disabled_row_accept,
        direct_row_accept,
        "PendingHandoffRow direct accept restoration",
    )

    updated = replace_once(
        updated,
        "{busy === 'accept' ? '...' : 'HAP MBYLLJEN DITORE'}",
        "{busy === 'accept' ? '...' : 'PRANO CASH'}",
        "PendingHandoffRow button label",
    )

    disabled_manager_accept = """  function acceptWorkerCashFromCard() {
      // ARKA_DAILY_CLOSE_V2_ONE_WAY: every manager entry point uses the same daily close route.
      if (typeof window !== 'undefined') window.location.assign('/arka/ditore');
    }

  async function confirmCashAcceptReview() {
      // ARKA_DAILY_CLOSE_V2_ONE_WAY: legacy review modal cannot post to the budget.
      setCashAcceptReview(null);
      if (typeof window !== 'undefined') window.location.assign('/arka/ditore');
    }
"""
    direct_manager_accept = """  function acceptWorkerCashFromCard(item) {
    const rows = Array.isArray(item?.pendingHandoffRows) ? item.pendingHandoffRows : [];
    if (!rows.length) {
      alert('S’KA DORËZIM CASH NË PRITJE PËR KËTË PUNTOR.');
      return;
    }
    setCashAcceptReview(buildWorkerHandoffReview(item));
  }

  async function confirmCashAcceptReview() {
    const review = cashAcceptReview;
    const rows = Array.isArray(review?.handoffRows) ? review.handoffRows : [];
    if (!rows.length) {
      setCashAcceptReview(null);
      alert('S’KA DORËZIM CASH NË PRITJE.');
      return;
    }
    if (review?.hasDuplicateTransportItems) {
      alert('🔴 U GJET DUPLICATE TRANSPORT ITEM. Totali u korrigjua me dedupe në ekran, por pranimi raw u ndalua për siguri.');
      return;
    }
    try {
      setBusy('accept_cash_review');
      for (const row of rows) {
        await acceptDispatchHandoff({ handoffId: row.id, actor });
        await handlePendingHandoffDone(row?.id);
      }
      setCashAcceptReview(null);
      alert('✅ CASH U PRANUA NË ARKË: ' + euro(review?.baseTotal || 0));
      await scheduleManagerMutationRefresh(actor);
    } catch (e) {
      alert('🔴 ' + (e?.message || 'NUK U PRANUA CASH.'));
    } finally {
      setBusy('');
    }
  }
"""
    updated = replace_once(
        updated,
        disabled_manager_accept,
        direct_manager_accept,
        "Manager direct accept restoration",
    )

    updated = replace_once(
        updated,
        "{pendingCount ? 'MBYLL DITËN (' + pendingCount + ')' : 'MBYLL DITËN'}",
        "{pendingCount ? 'PRANO CASH (' + pendingCount + ')' : 'PRANO CASH'}",
        "Worker card direct accept label",
    )

    card_start_marker = "          {/* ARKA_DAILY_CONTROL_V1:ARKA — read-only daily facts for DISPATCH. */}"
    card_end_marker = "          <div className=\"arkaWorkerStats adminTopGrid ownerTotalsGrid\">"
    start = updated.find(card_start_marker)
    end = updated.find(card_end_marker, start + 1 if start >= 0 else 0)
    if start < 0 or end < 0 or end <= start:
        raise RuntimeError(
            f"Legacy daily-control card markers invalid: start={start}, end={end}"
        )
    updated = updated[:start] + updated[end:]

    write_changed(ARKA_PATH, original, updated, changed)


def verify() -> None:
    route = ROUTE_PATH.read_text(encoding="utf-8")
    layout = LAYOUT_PATH.read_text(encoding="utf-8")
    page = ARKA_PATH.read_text(encoding="utf-8")

    redirect_route = "{ path: '/arka/ditore', element: <Navigate to='/arka' replace /> }"
    if redirect_route not in route:
        raise RuntimeError("Retired /arka/ditore redirect is missing")

    active_text = "\n".join((route, layout, page))
    forbidden = (
        "ArkaDitorePageEager",
        "ArkaDailyCloseShortcut",
        "ARKA_DAILY_CLOSE_V2_ONE_WAY",
        "HAP MBYLLJEN DITORE",
        "MBYLLJA DITORE",
        "window.location.assign('/arka/ditore')",
        'window.location.assign("/arka/ditore")',
        'to="/arka/ditore"',
        "to='/arka/ditore'",
        'href="/arka/ditore"',
        "href='/arka/ditore'",
        "arka_open_cycle_safe",
        "close_arka_day_v2",
        "get_arka_daily_close_preview_v2",
        "get_arka_daily_close_preview_v3",
        "get_arka_daily_close_preview_v4",
        "add_arka_closed_day_expense_v1",
    )
    leftovers = [token for token in forbidden if token in active_text]
    if leftovers:
        raise RuntimeError(f"Active legacy ARKA references remain: {leftovers}")

    required = (
        "async function handleAccept()",
        "await acceptDispatchHandoff({ handoffId: row.id, actor });",
        "setCashAcceptReview(buildWorkerHandoffReview(item));",
        "PRANO CASH",
    )
    missing = [token for token in required if token not in page]
    if missing:
        raise RuntimeError(f"Direct ARKA acceptance pieces are missing: {missing}")


def main() -> None:
    changed: list[str] = []
    patch_route(changed)
    patch_layout(changed)
    patch_arka_page(changed)
    verify()
    if not changed:
        raise RuntimeError("No runtime files changed")
    print("Changed files:")
    for path in changed:
        print(path)
    print("Verified: direct ARKA flow is active; legacy daily open/close UI is retired.")


if __name__ == "__main__":
    main()
