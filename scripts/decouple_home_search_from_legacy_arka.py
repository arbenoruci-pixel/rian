#!/usr/bin/env python3
"""Remove the obsolete ARKA daily-close coupling from the home-search installer."""

from __future__ import annotations

from pathlib import Path


PATH = Path("tools/apply-home-search-base-role-boundary-v1.mjs")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def main() -> None:
    original = PATH.read_text(encoding="utf-8")
    text = original

    text = replace_once(
        text,
        "const ARKA_INSTALLER_PATH = 'tools/apply-arka-daily-close-v2.mjs';\n",
        "",
        "ARKA installer constant",
    )
    text = replace_once(
        text,
        "const ARKA_VERIFY_PATH = 'tools/verify-arka-daily-close-v2.mjs';\n",
        "",
        "ARKA verifier constant",
    )
    text = replace_once(
        text,
        "const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1';",
        "const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-home-search-base-role-v1';",
        "APP version",
    )
    text = replace_once(
        text,
        "const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1';",
        "const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-home-search-base-role-v1';",
        "cache version",
    )

    legacy_function = """function patchArkaVersionOwner() {
  let installer = fs.readFileSync(ARKA_INSTALLER_PATH, 'utf8');
  installer = installer
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);
  fs.writeFileSync(ARKA_INSTALLER_PATH, installer, 'utf8');

  let verify = fs.readFileSync(ARKA_VERIFY_PATH, 'utf8');
  verify = verify.replace(/v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2(?:-home-search-base-role-v1)?/g, CACHE_VERSION);
  fs.writeFileSync(ARKA_VERIFY_PATH, verify, 'utf8');
}

"""
    text = replace_once(text, legacy_function, "", "legacy ARKA patch function")

    old_patch_package = """function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const installerCommand = 'node tools/apply-home-search-base-role-boundary-v1.mjs';
  const finalArkaCommand = 'node tools/apply-arka-daily-close-v2.mjs';
  const pre = String(scripts.prebuild || '').split('&&').map((item) => item.trim()).filter(Boolean)
    .filter((item) => item !== installerCommand && item !== finalArkaCommand);
  pre.push(installerCommand, finalArkaCommand);
  scripts.prebuild = pre.join(' && ');
  scripts['test:home-search-base-role-boundary-v1'] = 'node tools/verify-home-search-base-role-boundary-v1.mjs';
  const testCommand = 'npm run test:home-search-base-role-boundary-v1';
  let build = String(scripts.build || '');
  if (!build.includes(testCommand)) {
    const anchor = ' && npm run test:arka-daily-close-v2';
    if (!build.includes(anchor)) throw new Error('ARKA_TEST_BUILD_ANCHOR_MISSING');
    build = build.replace(anchor, ' && ' + testCommand + anchor);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\\n', 'utf8');
}
"""
    new_patch_package = """function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const installerCommand = 'node tools/apply-home-search-base-role-boundary-v1.mjs';
  const pre = String(scripts.prebuild || '').split('&&').map((item) => item.trim()).filter(Boolean)
    .filter((item) => item !== installerCommand);
  pre.push(installerCommand);
  scripts.prebuild = pre.join(' && ');
  scripts['test:home-search-base-role-boundary-v1'] = 'node tools/verify-home-search-base-role-boundary-v1.mjs';
  const testCommand = 'npm run test:home-search-base-role-boundary-v1';
  let build = String(scripts.build || '');
  if (!build.includes(testCommand)) {
    const anchor = ' && vite build';
    if (build.includes(anchor)) build = build.replace(anchor, ' && ' + testCommand + anchor);
    else build = [build, testCommand].filter(Boolean).join(' && ');
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkg, null, 2) + '\\n', 'utf8');
}
"""
    text = replace_once(text, old_patch_package, new_patch_package, "package patch function")
    text = replace_once(
        text,
        "patchArkaVersionOwner();\n",
        "",
        "legacy ARKA patch call",
    )

    forbidden = (
        "ARKA_INSTALLER_PATH",
        "ARKA_VERIFY_PATH",
        "apply-arka-daily-close-v2.mjs",
        "verify-arka-daily-close-v2.mjs",
        "test:arka-daily-close-v2",
        "ARKA_TEST_BUILD_ANCHOR_MISSING",
        "patchArkaVersionOwner",
        "arka-daily-close-v2",
    )
    leftovers = [token for token in forbidden if token in text]
    if leftovers:
        raise RuntimeError(f"Legacy ARKA coupling remains: {leftovers}")
    if text == original:
        raise RuntimeError("No home-search installer changes were made")

    PATH.write_text(text, encoding="utf-8")
    print("Decoupled home-search installer from retired ARKA daily-close files.")


if __name__ == "__main__":
    main()
