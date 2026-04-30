import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  // IMPORTANT: version MUST be stable across requests.
  // Using Date.now() here causes Safari/PWA to think every request is a new build,
  // triggering VersionGuard to purge caches + reload in a loop.
  const v =
    process.env.NEXT_PUBLIC_APP_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    'dev';

  const res = NextResponse.json({ ok: true, v });
  res.headers.set('Cache-Control', 'no-store, max-age=0');
  return res;
}
