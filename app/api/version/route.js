import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const v =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.NEXT_PUBLIC_APP_VERSION ||
    String(Date.now());

  const res = NextResponse.json({ ok: true, v });
  res.headers.set('Cache-Control', 'no-store, max-age=0');
  return res;
}
