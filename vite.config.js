import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import circularDependencyReporter, { circularDependencyReporterBuild } from './tools/viteCircularDependencyPlugin.mjs';

const rootDir = path.resolve(__dirname);

const BUSINESS_ROUTE_RE = /^\/(?:pranimi|pastrimi|gati|arka(?:\/.*)?|transport(?:\/.*)?|marrje-sot|dispatch|fletore|baza|search|worker)(?:\/.*)?$/;

export default defineConfig({
  plugins: [
    circularDependencyReporter({ failOnError: process.env.CIRCULAR_FAIL === '1' }),
    circularDependencyReporterBuild({ failOnError: process.env.CIRCULAR_FAIL === '1' }),
    react({
      babel: {
        plugins: ['styled-jsx/babel'],
      },
    }),
    VitePWA({
      strategies: 'generateSW',
      filename: 'vite-sw.js',
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'offline.html',
        'manifest.json',
        'manifest.webmanifest',
      ],
      manifest: {
        id: '/',
        name: 'TEPIHA',
        short_name: 'TEPIHA',
        description: 'TEPIHA offline PWA',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#05070d',
        theme_color: '#05070d',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,ico,png,svg,webp,webmanifest,json,woff2}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        cleanupOutdatedCaches: false,
        // Keep updates passive during an active iOS PWA session.
        // The waiting worker is not activated from the app UI during an active session.
        clientsClaim: false,
        skipWaiting: false,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api/,
          /^\/assets\/.*\.map$/,
          /^\/debug(?:\/.*)?$/,
          /^\/diag-lite(?:\/.*)?$/,
          /^\/diag-raw(?:\/.*)?$/,
        ],
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => request.mode === 'navigate' && BUSINESS_ROUTE_RE.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'tepiha-vite-business-routes-v29',
              networkTimeoutSeconds: 4,
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 80,
                maxAgeSeconds: 7 * 24 * 60 * 60,
                purgeOnQuotaError: true,
              },
            },
          },
          {
            urlPattern: ({ request, url }) => request.destination === 'script' || request.destination === 'style' || url.pathname.startsWith('/assets/'),
            // PATCH V28: keep cached hashed chunks available while checking the network in background.
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'tepiha-vite-static-assets-v29',
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 320,
                maxAgeSeconds: 14 * 24 * 60 * 60,
                purgeOnQuotaError: false,
              },
            },
          },
          {
            urlPattern: ({ request }) => request.destination === 'image' || request.destination === 'font',
            handler: 'CacheFirst',
            options: {
              cacheName: 'tepiha-vite-media-v29',
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 120,
                maxAgeSeconds: 30 * 24 * 60 * 60,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': rootDir,
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
