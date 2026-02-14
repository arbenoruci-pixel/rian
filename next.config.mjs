import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const withPWA = require('next-pwa')({
  dest: 'public',
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  runtimeCaching: [
    // App Router navigations (HTML)
    {
      urlPattern: ({ request }) => request.mode === 'navigate',
      handler: 'NetworkFirst',
      options: {
        cacheName: 'pages',
        // Safari iOS (especially Home Screen/PWA) can get stuck on cached HTML.
        // Keep this cache very short so users always get the latest build.
        networkTimeoutSeconds: 12,
        expiration: { maxEntries: 30, maxAgeSeconds: 60 },
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
      // Never cache Supabase responses in the Service Worker.
      // We handle offline via local queue/cache in app code.
      handler: 'NetworkOnly',
      options: {
        cacheName: 'api',
        networkTimeoutSeconds: 12,
        expiration: { maxEntries: 1, maxAgeSeconds: 1 },
      },
    },
  ],
});

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/manifest.json', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      // next-pwa generates these in /public (workbox + sw)
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
      { source: '/workbox-:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
    ];
  },
};

export default withPWA(nextConfig);
