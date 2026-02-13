import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const withPWA = require('next-pwa')({
  dest: 'public',
  register: true,
  skipWaiting: true,
  clientsClaim: true,
  disable: process.env.NODE_ENV === 'development',
  runtimeCaching: [
    // App Router navigations (HTML)
    {
      urlPattern: ({ request }) => request.mode === 'navigate',
      handler: 'NetworkFirst',
      options: {
        cacheName: 'pages',
        networkTimeoutSeconds: 4,
        expiration: { maxEntries: 80, maxAgeSeconds: 24 * 60 * 60 },
      },
    },

    // Next static assets
    {
      urlPattern: /^https?.*\/\_next\/static\/.*/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'next-static',
        expiration: { maxEntries: 250, maxAgeSeconds: 30 * 24 * 60 * 60 },
      },
    },

    // Images
    {
      urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'images',
        expiration: { maxEntries: 250, maxAgeSeconds: 30 * 24 * 60 * 60 },
      },
    },

    // Supabase API (prevents iOS "hanging forever")
    {
      urlPattern: ({ url }) => url.hostname.includes('supabase.co'),
      handler: 'NetworkFirst',
      options: {
        cacheName: 'api',
        networkTimeoutSeconds: 4,
        expiration: { maxEntries: 300, maxAgeSeconds: 5 * 60 },
      },
    },
  ],
});

const nextConfig = {
  reactStrictMode: true,
  env: {
    // Expose a stable build id to the client so we can self-heal stale PWAs.
    NEXT_PUBLIC_APP_VERSION:
      process.env.NEXT_PUBLIC_APP_VERSION ||
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.VERCEL_DEPLOYMENT_ID ||
      '',
  },
  async headers() {
    return [
      // IMPORTANT: prevent stale shell/manifest on iOS (actual app routes are forced-dynamic in app/layout.jsx)
      { source: '/', headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }] },
      { source: '/manifest.json', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      // next-pwa generates these in /public (workbox + sw)
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      { source: '/workbox-:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
};

export default withPWA(nextConfig);
