const STORAGE_KEY = 'tepiha_transport_session_v1'
const MAIN_SESSION_KEY = 'tepiha_session_v1'

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function setTransportSession(payload) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch (e) {
    console.error('setTransportSession error', e)
  }
}

export function clearTransportSession() {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (e) {
    console.error('clearTransportSession error', e)
  }
}

export function getTransportSession() {
  if (typeof window === 'undefined') return null

  // 1) Dedicated transport session (preferred)
  const raw = localStorage.getItem(STORAGE_KEY)
  const dedicated = raw ? safeJsonParse(raw) : null
  if (dedicated?.transport_id) return dedicated

  // Helper: promote any legacy session into dedicated transport session (one-time)
  function promote(transport_id, source) {
    const tid = String(transport_id || '').trim()
    if (!tid) return null
    const payload = { transport_id: tid, source: source || 'legacy', promoted_at: new Date().toISOString() }
    try { setTransportSession(payload) } catch {}
    return payload
  }

  // 2) Reuse main session if role is TRANSPORT (common in your app)
  const rawMain = localStorage.getItem(MAIN_SESSION_KEY)
  const main = rawMain ? safeJsonParse(rawMain) : null
  if (main?.user?.role === 'TRANSPORT' && main?.user?.pin) {
    return promote(main.user.pin, 'main_session') || { transport_id: String(main.user.pin) }
  }

  // 3) Optional: actor session (if present in your project)
  try {
    // lazy require to avoid hard crash if file changes
    // eslint-disable-next-line global-require
    const { getActor } = require('./actorSession')
    const actor = typeof getActor === 'function' ? getActor() : null
    if (actor?.role === 'TRANSPORT' && actor?.pin) {
      return promote(actor.pin, 'actor_session') || { transport_id: String(actor.pin) }
    }
  } catch {
    // ignore
  }

  return null
}

// ------------------------------------------------------------
// ✅ Harmonized transport context (ADMIN/DISPATCH/TRANSPORT)
// - Keeps PIN hidden (UI should render name only)
// - Prevents stale dedicated transport session from hijacking ADMIN
// - Uses CURRENT_USER_DATA / tepiha_session_v1 as primary identity
// ------------------------------------------------------------

export function getTransportContext() {
  if (typeof window === 'undefined') return null;

  const read = (k) => {
    try { return safeJsonParse(localStorage.getItem(k) || ''); } catch { return null; }
  };

  const main = read(MAIN_SESSION_KEY);
  const actor = (() => {
    try {
      // eslint-disable-next-line global-require
      const { getActor } = require('./actorSession');
      return typeof getActor === 'function' ? getActor() : null;
    } catch {
      return null;
    }
  })();

  const u = actor || main?.user || null;
  const role = String(u?.role || '').trim() || null;
  const pin = String(u?.pin || '').trim() || null;
  const name = String(u?.name || '').trim() || null;

  // TRANSPORT: use numeric pin as the routing/ownership id
  if (role === 'TRANSPORT' && pin) {
    return {
      role,
      name: name || 'TRANSPORT',
      // internal only
      transport_id: String(pin),
      // never render this in UI
      transport_pin: String(pin),
    };
  }

  // ADMIN/DISPATCH: create a stable internal id per user, without exposing pin.
  // This keeps ownership consistent when admin creates transport orders.
  if ((role === 'ADMIN' || role === 'DISPATCH') && pin) {
    return {
      role,
      name: name || role,
      transport_id: `${role}_${pin}`,
      transport_pin: String(pin),
    };
  }

  // Fallback: dedicated transport session (legacy)
  const dedicated = read(STORAGE_KEY);
  if (dedicated?.transport_id) {
    return {
      role: String(dedicated.role || 'TRANSPORT'),
      name: String(dedicated.transport_name || 'TRANSPORT'),
      transport_id: String(dedicated.transport_id),
      transport_pin: String(dedicated.transport_id),
      legacy: true,
    };
  }

  return null;
}
