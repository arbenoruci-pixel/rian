import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = process.cwd();
const parts = fs.readdirSync(root)
  .filter(name => /^lab-source\.part-\d+\.b64$/.test(name))
  .sort();
if (!parts.length) throw new Error('Scanner lab source archive is missing.');

const encoded = parts.map(name => fs.readFileSync(path.join(root, name), 'utf8').trim()).join('');
const files = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
for (const [relative, content] of Object.entries(files)) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  fs.writeFileSync(target, content);
}

const constantsTarget = path.join(root, 'lib/scanner/constants.js');
let constants = fs.readFileSync(constantsTarget, 'utf8');
constants = constants
  .replace(
    /export const OPENCV_URL = '[^']+';/,
    "export const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/jscanify@1.4.2/src/opencv.js';",
  )
  .replace(
    /export const JSCANIFY_URL = '[^']+';/,
    "export const JSCANIFY_URL = 'https://cdn.jsdelivr.net/npm/jscanify@1.4.2/src/jscanify.js';",
  );
fs.writeFileSync(constantsTarget, constants);

const runtimeTarget = path.join(root, 'lib/scanner/runtime.js');
fs.writeFileSync(runtimeTarget, `import { JSCANIFY_URL, OPENCV_URL } from './constants.js';

let runtimePromise = null;

const OPENCV_CANDIDATES = [
  OPENCV_URL,
  'https://docs.opencv.org/4.12.0/opencv.js',
  'https://unpkg.com/jscanify@1.4.2/src/opencv.js',
];

const JSCANIFY_CANDIDATES = [
  JSCANIFY_URL,
  'https://cdn.jsdelivr.net/gh/puffinsoft/jscanify@master/src/jscanify.js',
  'https://unpkg.com/jscanify@1.4.2/src/jscanify.js',
];

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function removeScript(id) {
  const existing = document.getElementById(id);
  if (existing) existing.remove();
}

function resetGlobal(name) {
  try { delete window[name]; } catch {}
  try { window[name] = undefined; } catch {}
}

function loadExternalScript(src, id, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    removeScript(id);
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.async = true;
    script.referrerPolicy = 'no-referrer';

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      fn(value);
    };

    const timer = window.setTimeout(() => {
      script.remove();
      finish(reject, new Error('Timed out loading ' + src));
    }, timeoutMs);

    script.onload = () => finish(resolve, src);
    script.onerror = () => {
      script.remove();
      finish(reject, new Error('Could not load ' + src));
    };
    document.head.appendChild(script);
  });
}

async function waitForOpenCv(timeoutMs = 45000) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    let candidate = window.cv;
    if (candidate && typeof candidate.then === 'function') {
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
      candidate = await Promise.race([
        candidate,
        new Promise((_, reject) => window.setTimeout(
          () => reject(new Error('OpenCV WebAssembly initialization timed out.')),
          remaining,
        )),
      ]);
      window.cv = candidate;
    }
    if (candidate?.Mat && candidate?.imread && candidate?.warpPerspective) return candidate;
    await new Promise(resolve => window.setTimeout(resolve, 100));
  }
  throw new Error('OpenCV took too long to initialize.');
}

async function loadOpenCv(onStage) {
  const ready = window.cv?.Mat && window.cv?.imread && window.cv?.warpPerspective;
  if (ready) return window.cv;

  const errors = [];
  const candidates = unique(OPENCV_CANDIDATES);
  for (let index = 0; index < candidates.length; index += 1) {
    const src = candidates[index];
    onStage('Loading vision engine ' + (index + 1) + '/' + candidates.length);
    try {
      resetGlobal('cv');
      await loadExternalScript(src, 'rr-opencv-runtime');
      return await waitForOpenCv();
    } catch (error) {
      errors.push(error?.message || String(error));
      removeScript('rr-opencv-runtime');
      resetGlobal('cv');
    }
  }
  throw new Error('Vision engine failed. ' + errors.join(' | '));
}

async function loadDocumentDetector(onStage) {
  if (typeof window.jscanify === 'function') return new window.jscanify();

  const errors = [];
  const candidates = unique(JSCANIFY_CANDIDATES);
  for (let index = 0; index < candidates.length; index += 1) {
    const src = candidates[index];
    onStage('Loading document detector ' + (index + 1) + '/' + candidates.length);
    try {
      resetGlobal('jscanify');
      await loadExternalScript(src, 'rr-jscanify-runtime', 15000);
      if (typeof window.jscanify !== 'function') {
        throw new Error('Detector script loaded without a jscanify constructor.');
      }
      return new window.jscanify();
    } catch (error) {
      errors.push(error?.message || String(error));
      removeScript('rr-jscanify-runtime');
      resetGlobal('jscanify');
    }
  }
  throw new Error('Document detector failed. ' + errors.join(' | '));
}

export function loadScannerRuntime(onStage = () => {}) {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const cv = await loadOpenCv(onStage);
    const scanner = await loadDocumentDetector(onStage);
    onStage('Scanner engine ready');
    return { cv, scanner };
  })().catch(error => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

export async function registerLabServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js?v=0.1.1', {
      scope:'/',
      updateViaCache:'none',
    });
    registration.update().catch(() => {});
    return registration;
  } catch {
    return null;
  }
}
`);

const serviceWorkerTarget = path.join(root, 'public/sw.js');
fs.writeFileSync(serviceWorkerTarget, `const CACHE_VERSION = 'road-ready-scanner-lab-0.1.1';

async function clearOldCaches() {
  const names = await caches.keys();
  await Promise.all(names.map(name => caches.delete(name)));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await clearOldCaches();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await clearOldCaches();
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event?.data?.type === 'RR_SCANNER_CLEAR_CACHE') {
    event.waitUntil(clearOldCaches());
  }
});

void CACHE_VERSION;
`);

const required = [
  "jscanify@1.4.2/src/opencv.js",
  "jscanify@1.4.2/src/jscanify.js",
  'OPENCV_CANDIDATES',
  'JSCANIFY_CANDIDATES',
  "register('/sw.js?v=0.1.1'",
];
const verificationText = constants + fs.readFileSync(runtimeTarget, 'utf8');
for (const marker of required) {
  if (!verificationText.includes(marker)) throw new Error('Scanner runtime repair missing: ' + marker);
}

console.log(`Materialized ${Object.keys(files).length} isolated scanner-lab files from ${parts.length} archive parts.`);
console.log('Applied scanner lab iOS runtime repair 0.1.1 with three-source fallback and cache reset.');

for (const url of [
  'https://cdn.jsdelivr.net/npm/jscanify@1.4.2/src/opencv.js',
  'https://cdn.jsdelivr.net/npm/jscanify@1.4.2/src/jscanify.js',
]) {
  try {
    const response = await fetch(url, { method:'HEAD', signal:AbortSignal.timeout(8000) });
    console.log('Runtime asset probe', response.status, response.headers.get('content-type') || '', url);
  } catch (error) {
    console.warn('Runtime asset probe skipped', url, error?.message || error);
  }
}
