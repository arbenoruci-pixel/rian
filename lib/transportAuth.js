import { getActor } from './actorSession'

const STORAGE_KEY = 'tepiha_transport_session_v1'
const MAIN_SESSION_KEY = 'tepiha_session_v1'
const CURRENT_USER_KEY = 'CURRENT_USER_DATA'

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readLocalJson(key) {
  if (typeof window === 'undefined') return null
  try {
    return safeJsonParse(localStorage.getItem(key) || '')
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

  // Transport session (preferred)
  try {
    const s = readLocalJson(STORAGE_KEY)
    if (s?.transport_id) {
      return {
        ...s,
        transport_id: String(s.transport_id),
        transport_pin: String(s.transport_pin || s.pin || s.transport_id || ''),
        pin: String(s.pin || s.transport_pin || s.transport_id || ''),
        transport_name: String(s.transport_name || s.name || 'TRANSPORT'),
        name: String(s.name || s.transport_name || 'TRANSPORT'),
      }
    }
  } catch {}

  // Fallback: use main session for ANY logged-in user (ADMIN/DISPATCH/PUNTOR/...)
  try {
    const main = readLocalJson(MAIN_SESSION_KEY)
    const mainUser = main?.user || main?.actor || null
    const role = String(mainUser?.role || '').toUpperCase()
    const pin = mainUser?.pin || null
    const name = mainUser?.name || mainUser?.display || role || 'USER'

    if (role) {
      return {
        transport_id: role === 'TRANSPORT' && pin ? String(pin) : `MAIN_${role}${pin ? '_' + String(pin) : ''}`,
        transport_pin: pin ? String(pin) : '',
        transport_name: String(name || role || 'USER'),
        role,
        name,
        pin,
        is_admin: role === 'ADMIN' || role === 'OWNER' || role === 'DISPATCH',
      }
    }
  } catch {}

  return null
}

// ------------------------------------------------------------
// ✅ Harmonized transport context (ADMIN/DISPATCH/TRANSPORT)
// - Keeps PIN hidden (UI should render name only)
// - Prevents stale dedicated transport session from hijacking ADMIN
// - Uses CURRENT_USER_DATA / tepiha_session_v1 as primary identity
// ------------------------------------------------------------

export function getTransportContext() {
  if (typeof window === 'undefined') return null

  // IMPORTANT: For /transport screens the dedicated transport PIN session must win.
  // Otherwise an existing ADMIN/main session will override the driver PIN and mix codes.
  const dedicated = readLocalJson(STORAGE_KEY)
  if (dedicated?.transport_id) {
    return {
      role: 'TRANSPORT',
      name: String(dedicated.transport_name || dedicated.name || 'TRANSPORT'),
      transport_name: String(dedicated.transport_name || dedicated.name || 'TRANSPORT'),
      transport_id: String(dedicated.transport_id),
      transport_pin: String(dedicated.transport_pin || dedicated.pin || dedicated.transport_id),
      pin: String(dedicated.pin || dedicated.transport_pin || dedicated.transport_id),
      from_transport_session: true,
    }
  }

  const main = readLocalJson(MAIN_SESSION_KEY)
  const currentUser = readLocalJson(CURRENT_USER_KEY)
  const actor = (() => {
    try {
      return typeof getActor === 'function' ? getActor() : null
    } catch {
      return null
    }
  })()

  const u = actor || currentUser || main?.user || main?.actor || null
  const role = String(u?.role || '').trim().toUpperCase() || null
  const pin = String(u?.pin || '').trim() || null
  const name = String(u?.name || u?.display || '').trim() || null

  // TRANSPORT: use numeric pin as the routing/ownership id
  if (role === 'TRANSPORT' && pin) {
    return {
      role,
      name: name || 'TRANSPORT',
      transport_name: name || 'TRANSPORT',
      // internal only
      transport_id: String(pin),
      // never render this in UI
      transport_pin: String(pin),
      pin: String(pin),
    }
  }

  // ADMIN/DISPATCH: create a stable internal id per user, without exposing pin.
  // This keeps ownership consistent when admin creates transport orders.
  if ((role === 'ADMIN' || role === 'DISPATCH') && pin) {
    return {
      role,
      name: name || role,
      transport_name: name || role,
      transport_id: `${role}_${pin}`,
      transport_pin: String(pin),
      pin: String(pin),
    }
  }

  return null
}
