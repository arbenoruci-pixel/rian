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
  // Transport session (preferred)
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const s = safeJsonParse(raw);
    if (s?.transport_id) return s;
  } catch {}

  // Fallback: allow ADMIN/OWNER/DISPATCH to open transport pages without forcing transport login.
  // Useful for Home search + deep links.
  try {
    const rawMain = localStorage.getItem(MAIN_SESSION_KEY);
    const main = safeJsonParse(rawMain);
    const mainUser = main?.user || main?.actor || null;
    const role = String(mainUser?.role || '').toUpperCase();
    if (role === 'ADMIN' || role === 'OWNER' || role === 'DISPATCH') {
      return {
        transport_id: 'ADMIN',
        role,
        name: mainUser?.name || mainUser?.display || 'ADMIN',
        pin: mainUser?.pin || null,
        is_admin: true,
      };
    }
  } catch {}

  return null;
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

  // IMPORTANT: For /transport screens the dedicated transport PIN session must win.
  // Otherwise an existing ADMIN/main session will override the driver PIN and mix codes.
  const dedicated = read(STORAGE_KEY);
  if (dedicated?.transport_id) {
    return {
      role: 'TRANSPORT',
      name: String(dedicated.transport_name || 'TRANSPORT'),
      transport_id: String(dedicated.transport_id),
      transport_pin: String(dedicated.transport_id),
      from_transport_session: true,
    };
  }

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


  return null;
}
