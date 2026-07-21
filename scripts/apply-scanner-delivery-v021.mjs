import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const VERSION = '0.2.1';

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function write(relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function replaceRequired(source, oldValue, newValue, label) {
  if (source.includes(newValue)) return source;
  if (!source.includes(oldValue)) throw new Error(`Scanner delivery patch target missing: ${label}`);
  return source.replace(oldValue, newValue);
}

let component = read('components/ScannerLab.jsx');
component = replaceRequired(
  component,
  'SCANNER CORE · DEMO 0.2',
  'SCANNER CORE · DEMO 0.2.1',
  'visible demo version',
);
component = replaceRequired(
  component,
  "engineReady ? 'Local engine ready'",
  "engineReady ? 'Local engine ready · 0.2.1'",
  'visible engine build',
);
component = replaceRequired(
  component,
  'Standalone scanner lab · no Road Ready production imports',
  'Standalone scanner lab · build 0.2.1 · no Road Ready production imports',
  'visible footer build',
);
write('components/ScannerLab.jsx', component);

// The lab must never cache an old runtime. This endpoint unregisters itself and
// deletes every cache created on this isolated preview origin.
write('public/sw.js', `self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  try {
    const names = await caches.keys();
    await Promise.all(names.map(name => caches.delete(name)));
    await self.registration.unregister();
  } catch {}
  await self.clients.claim();
})()));
`);

write('public/scanner-build.json', `${JSON.stringify({
  version: VERSION,
  engine: 'local-js-lite',
  externalRuntime: false,
  serviceWorker: false,
  cachePolicy: 'no-store',
}, null, 2)}\n`);

write('next.config.mjs', `const noStoreHeaders = [
  { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0' },
  { key: 'Pragma', value: 'no-cache' },
  { key: 'Expires', value: '0' },
];

const nextConfig = {
  async headers() {
    return [
      { source: '/:path*', headers: noStoreHeaders },
    ];
  },
};

export default nextConfig;
`);

const runtime = read('lib/scanner/runtime.js');
const forbidden = [
  'Loading vision engine',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'docs.opencv.org',
  'window.cv',
  'jscanify',
];
for (const marker of forbidden) {
  if (runtime.includes(marker)) throw new Error(`External/stale scanner runtime remains: ${marker}`);
}

for (const marker of [
  'SCANNER CORE · DEMO 0.2.1',
  'Local engine ready · 0.2.1',
  'build 0.2.1',
]) {
  if (!component.includes(marker)) throw new Error(`Visible Scanner Lab build marker missing: ${marker}`);
}

console.log('PASS — Scanner Lab 0.2.1 is local-only, no-store, service-worker-free, and visibly versioned.');
