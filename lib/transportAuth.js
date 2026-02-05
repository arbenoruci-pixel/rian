// lib/transportAuth.js
// Transport session (PIN-based). Keeps transport scope isolated from base.
// IMPORTANT: If the main app is already logged in as role TRANSPORT, we reuse that session
// so the user is NOT asked for PIN twice.

import { getActor } from '@/lib/actorSession';

const KEY = 'tepiha_transport_session_v1';

export function getTransportSession() {
  if (typeof window === 'undefined') return null;

  // 1) If main actor is TRANSPORT, reuse it
  try {
    const a = getActor();
    if (a?.role === 'TRANSPORT' && a?.pin) {
      return {
        transport_id: String(a.pin),
        transport_name: a?.name || 'TRANSPORT',
        role: 'TRANSPORT',
        from: 'actor',
      };
    }
  } catch {}

  // 2) Fallback to dedicated transport session
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
