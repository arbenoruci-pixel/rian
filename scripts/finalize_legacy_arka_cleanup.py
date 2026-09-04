#!/usr/bin/env python3
"""Remove the retired ARKA day open/close system from build-time code.

The live ARKA model is continuous: transactions use their real timestamp, cash
handoffs are accepted directly by authorized managers, and payroll advances do
not depend on an opened or closed day.
"""

from __future__ import annotations

import json
import re
import shlex
from pathlib import Path


PACKAGE_PATH = Path("package.json")
LOCK_PATH = Path("package-lock.json")
DIRECT_TEST_KEY = "test:arka-direct-flow-v1"
DIRECT_TEST_COMMAND = "node tools/verify-arka-direct-flow-v1.mjs"

LEGACY_VERSION_PARTS = (
    "arka-daily-close-v2",
    "arka-daily-expense-step-v1",
    "arka-daily-operations-v3",
    "arka-daily-control-v1",
)

EXPLICIT_PREBUILD_REMOVE = {
    "node tools/apply-arka-daily-control-v1.mjs",
    "node tools/apply-arka-daily-close-v2.mjs",
    "node tools/apply-arka-daily-expense-step-v1.mjs",
    "node tools/apply-arka-daily-operations-v3.mjs",
    "node tools/apply-gati-rack-save-v1.mjs",
    "node tools/apply-home-search-base-role-boundary-v1.mjs",
    "node tools/apply-home-search-local-oid-dedupe-v1.mjs",
    "node tools/apply-operational-full-width-v1.mjs",
    "node tools/apply-pastrimi-payment-touch-v3.mjs",
    "node tools/apply-unified-arka-payroll-v1.mjs",
    "node tools/run-base-ready-bonus-v1.mjs",
}

EXPLICIT_TEST_REMOVE = {
    "test:arka-daily-control",
    "test:arka-daily-close-v2",
    "test:arka-daily-expense-step-v1",
    "test:arka-daily-operations-v3",
    "test:gati-rack-save-v1",
    "test:home-search-base-role-boundary-v1",
    "test:home-search-local-oid-dedupe-v1",
    "test:pastrimi-payment-touch-v3",
    "test:unified-arka-payroll-v1",
}

RETIRED_TOOL_PATHS = {
    "tools/apply-arka-daily-control-v1.mjs",
    "tools/verify-arka-daily-control-v1.mjs",
    "tools/apply-arka-daily-close-v2.mjs",
    "tools/verify-arka-daily-close-v2.mjs",
    "tools/apply-arka-daily-expense-step-v1.mjs",
    "tools/verify-arka-daily-expense-step-v1.mjs",
    "tools/apply-arka-daily-operations-v3.mjs",
    "tools/verify-arka-daily-operations-v3.mjs",
    "tools/fix-arka-daily-close-operations-compat-v1.mjs",
    "tools/fix-arka-daily-control-operations-compat-v1.mjs",
    "tools/fix-arka-daily-operations-v3-installer.mjs",
    "tools/apply-base-ready-bonus-v1.mjs",
    "tools/run-base-ready-bonus-v1.mjs",
    "tools/apply-gati-rack-save-v1.mjs",
    "tools/verify-gati-rack-save-v1.mjs",
    "tools/apply-home-search-base-role-boundary-v1.mjs",
    "tools/verify-home-search-base-role-boundary-v1.mjs",
    "tools/apply-home-search-local-oid-dedupe-v1.mjs",
    "tools/verify-home-search-local-oid-dedupe-v1.mjs",
    "tools/apply-operational-full-width-v1.mjs",
    "tools/apply-pastrimi-payment-touch-v3.mjs",
    "tools/verify-pastrimi-payment-touch-v3.mjs",
    "tools/apply-unified-arka-payroll-v1.mjs",
    "tools/verify-unified-arka-payroll-v1.mjs",
}

LEGACY_SOURCE_TOKENS = (
    "ARKA_DAY_ALREADY_CLOSED",
    "ARKA_DAILY_CLOSE_V2_ONE_WAY",
    "ArkaDailyCloseWizard",
    "ArkaDailyCloseShortcut",
    "arka_open_cycle_safe",
    "close_arka_day_v2",
    "get_arka_daily_close_preview_v2",
    "get_arka_daily_close_preview_v3",
    "get_arka_daily_close_preview_v4",
    "add_arka_closed_day_expense_v1",
    "apply-arka-daily-control-v1",
    "apply-arka-daily-close-v2",
    "apply-arka-daily-expense-step-v1",
    "apply-arka-daily-operations-v3",
    "verify-arka-daily-control-v1",
    "verify-arka-daily-close-v2",
    "verify-arka-daily-expense-step-v1",
    "verify-arka-daily-operations-v3",
)


def split_chain(value: str) -> list[str]:
    return [part.strip() for part in str(value or "").split("&&") if part.strip()]


def join_chain(parts: list[str]) -> str:
    return " && ".join(parts)


def referenced_paths(command: str) -> list[Path]:
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    paths: list[Path] = []
    for token in tokens:
        clean = token.strip().strip("'\"")
        if clean.startswith("tools/") or clean.startswith("scripts/"):
            paths.append(Path(clean))
    return paths


def command_is_retired(command: str) -> bool:
    normalized = " ".join(str(command or "").split())
    if normalized in EXPLICIT_PREBUILD_REMOVE:
        return True
    for path in referenced_paths(normalized):
        if str(path) in RETIRED_TOOL_PATHS:
            return True
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if any(token in text for token in LEGACY_SOURCE_TOKENS):
            return True
        if "/arka/ditore" in text and path.name != "verify-arka-direct-flow-v1.mjs":
            return True
    return False


def cleanup_version(value: str) -> str:
    version = str(value or "")
    for part in LEGACY_VERSION_PARTS:
        version = version.replace(f"-{part}", "")
        version = version.replace(part, "")
    version = re.sub(r"-{2,}", "-", version).strip("-")
    return version


def update_lock_version(version: str) -> None:
    if not LOCK_PATH.is_file():
        return
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    lock["version"] = version
    packages = lock.get("packages")
    if isinstance(packages, dict) and isinstance(packages.get(""), dict):
        packages[""]["version"] = version
    LOCK_PATH.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    package = json.loads(PACKAGE_PATH.read_text(encoding="utf-8"))
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        raise RuntimeError("package.json scripts object is missing")

    prebuild_before = split_chain(scripts.get("prebuild", ""))
    prebuild_after = [command for command in prebuild_before if not command_is_retired(command)]
    scripts["prebuild"] = join_chain(prebuild_after)

    removed_script_keys: set[str] = set()
    for key, command in list(scripts.items()):
        if key in EXPLICIT_TEST_REMOVE:
            removed_script_keys.add(key)
            del scripts[key]
            continue
        if key.startswith("test:") and key != DIRECT_TEST_KEY and command_is_retired(command):
            removed_script_keys.add(key)
            del scripts[key]

    build_before = split_chain(scripts.get("build", ""))
    build_after: list[str] = []
    for command in build_before:
        match = re.fullmatch(r"npm\s+run\s+([^\s]+)", command)
        if match and match.group(1) in removed_script_keys.union(EXPLICIT_TEST_REMOVE):
            continue
        if command_is_retired(command):
            continue
        if command != "vite build":
            build_after.append(command)

    scripts[DIRECT_TEST_KEY] = DIRECT_TEST_COMMAND
    direct_run = f"npm run {DIRECT_TEST_KEY}"
    if direct_run not in build_after:
        build_after.append(direct_run)
    build_after.append("vite build")
    scripts["build"] = join_chain(build_after)

    version = cleanup_version(package.get("version", ""))
    package["version"] = version
    PACKAGE_PATH.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    update_lock_version(version)

    final_text = PACKAGE_PATH.read_text(encoding="utf-8")
    forbidden = (
        "test:arka-daily-control",
        "test:arka-daily-close-v2",
        "test:arka-daily-expense-step-v1",
        "test:arka-daily-operations-v3",
        "apply-arka-daily-control-v1",
        "apply-arka-daily-close-v2",
        "apply-arka-daily-expense-step-v1",
        "apply-arka-daily-operations-v3",
    )
    leftovers = [token for token in forbidden if token in final_text]
    if leftovers:
        raise RuntimeError(f"Retired ARKA package hooks remain: {leftovers}")

    print(f"Removed {len(prebuild_before) - len(prebuild_after)} retired prebuild commands.")
    print(f"Removed {len(removed_script_keys)} retired verification scripts.")
    print(f"Kept {len(prebuild_after)} active prebuild commands.")
    print(f"Installed {DIRECT_TEST_KEY} as the replacement integrity check.")


if __name__ == "__main__":
    main()
