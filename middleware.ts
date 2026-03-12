// middleware.ts
// OFFLINE-SAFE PWA MIDDLEWARE
// - Never block SW/manifest/offline shell/Next static assets
// - Never redirect HTML navigations in middleware (let SW serve cached shell when offline)
// - If you need protection, protect /api routes only; keep page gating client-side (AuthGate)

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_FILE = /\.(.*)$/;

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  // Always bypass Next internals + public files/assets
  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/images/") ||
    pathname === "/sw.js" ||
    pathname === "/manifest.json" ||
    pathname === "/offline.html" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/apple-touch-icon") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Bypass App Router RSC payload requests (critical for navigation/prefetch)
  if (searchParams.has("_rsc")) {
    return NextResponse.next();
  }

  // OPTIONAL: Protect APIs only (recommended). Pages stay client-gated by AuthGate.
  // If you rely only on localStorage auth, keep this permissive.
  if (pathname.startsWith("/api/")) {
    const userCookie = req.cookies.get("tepiha_user")?.value;
    if (!userCookie) {
      // Keep permissive to avoid breaking offline/background flows.
      return NextResponse.next();
      // If you DO have cookie auth, enable strict mode:
      // return NextResponse.json({ ok:false, error:"unauthorized" }, { status: 401 });
    }
  }

  // Never hard-redirect navigations here. Let the app boot from cache.
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
