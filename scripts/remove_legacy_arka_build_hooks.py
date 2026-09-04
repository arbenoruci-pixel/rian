#!/usr/bin/env python3
"""Remove retired ARKA daily open/close installers and tests from package scripts."""

from __future__ import annotations

import json
from pathlib import Path


PACKAGE_PATH = Path("package.json")

PREBUILD_REMOVE = {
    "node tools/apply-arka-daily-control-v1.mjs",
    "node tools/apply-arka-daily-expense-step-v1.mjs",
    "node tools/apply-arka-daily-close-v2.mjs",
    "node tools/apply-arka-daily-operations-v3.mjs",
}

BUILD_REMOVE = {
    "npm run test:arka-daily-control",
    "npm run test:arka-daily-close-v2",
    "npm run test:arka-daily-expense-step-v1",
    "npm run test:arka-daily-operations-v3",
}

SCRIPT_KEYS_REMOVE = {
    "test:arka-daily-control",
    "test:arka-daily-close-v2",
    "test:arka-daily-expense-step-v1",
    "test:arka-daily-operations-v3",
}

VERSION_FRAGMENTS_REMOVE = (
    "-arka-daily-close-v2",
    "-arka-daily-expense-step-v1",
    "-arka-daily-operations-v3",
)


def remove_chain_entries(value: str, removed: set[str], label: str) -> str:
    entries = [entry.strip() for entry in str(value or "").split("&&") if entry.strip()]
    found = removed.intersection(entries)
    missing = removed.difference(entries)
    if missing:
        raise RuntimeError(f"{label}: expected hooks missing: {sorted(missing)}")
    return " && ".join(entry for entry in entries if entry not in removed)


def main() -> None:
    original = PACKAGE_PATH.read_text(encoding="utf-8")
    package = json.loads(original)
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        raise RuntimeError("package.json scripts object is missing")

    scripts["prebuild"] = remove_chain_entries(
        scripts.get("prebuild", ""), PREBUILD_REMOVE, "prebuild"
    )
    scripts["build"] = remove_chain_entries(
        scripts.get("build", ""), BUILD_REMOVE, "build"
    )

    for key in SCRIPT_KEYS_REMOVE:
        if key not in scripts:
            raise RuntimeError(f"Expected retired script key is missing: {key}")
        del scripts[key]

    version = str(package.get("version") or "")
    for fragment in VERSION_FRAGMENTS_REMOVE:
        version = version.replace(fragment, "")
    package["version"] = version

    updated = json.dumps(package, ensure_ascii=False, indent=2) + "\n"
    if updated == original:
        raise RuntimeError("No package.json changes were made")
    PACKAGE_PATH.write_text(updated, encoding="utf-8")

    remaining = PACKAGE_PATH.read_text(encoding="utf-8")
    forbidden = sorted(PREBUILD_REMOVE | BUILD_REMOVE | SCRIPT_KEYS_REMOVE)
    leftovers = [token for token in forbidden if token in remaining]
    if leftovers:
        raise RuntimeError(f"Retired ARKA build hooks remain: {leftovers}")

    print("Removed retired ARKA daily open/close build hooks and tests.")


if __name__ == "__main__":
    main()
