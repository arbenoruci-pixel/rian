// lib/transportAuth.js
// Transport session (PIN-based). Keeps transport scope isolated from base.

const KEY = 'tepiha_transport_session_v1';

export function getTransportSession() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.transport_id) return null;
    return s;
  } catch {
    return null;
  }
}

export function setTransportSession(session) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEY, JSON.stringify(session || {}));
}

export function clearTransportSession() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(KEY);
}
