// lib/debugLog.js
// Hidden debug log ring buffer (localStorage). Safe: no UI changes unless opened.

const KEY = 'TEPIHA_DEBUG_LOGS_V1';

export function dbgPush(entry) {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]');
    arr.unshift({ t: new Date().toISOString(), ...entry });
    localStorage.setItem(KEY, JSON.stringify(arr.slice(0, 80)));
  } catch {}
}

export function dbgGet() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export function dbgClear() {
  try { localStorage.removeItem(KEY); } catch {}
}
