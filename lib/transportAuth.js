import { getActor } from './actorSession'
import { canAccessTransportAdmin, normalizeRole } from './roles'
import {
  readMainActor,
  readTransportSession,
  persistTransportSession,
  clearAllSessionState,
} from './sessionStore'

const STORAGE_KEY = 'tepiha_transport_session_v1'

export function setTransportSession(payload) {
  return persistTransportSession(payload)
}

export function clearTransportSession() {
  clearAllSessionState({ preserveTransport: true })
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (e) {
    console.error('clearTransportSession error', e)
  }
}

function bridgeFromMain(mainUser) {
  const role = normalizeRole(mainUser?.role)
  const pin = String(mainUser?.pin || '').trim() || null
  const userId = String(mainUser?.user_id || mainUser?.id || '').trim() || null
  const isHybridTransport = mainUser?.is_hybrid_transport === true
  const name = String(mainUser?.name || mainUser?.display || role || 'USER').trim() || 'USER'

  if (!pin) return null

  if (role === 'TRANSPORT') {
    return {
      transport_id: String(userId || mainUser?.transport_id || pin),
      transport_pin: String(pin),
      transport_name: String(name || 'TRANSPORT'),
      role: 'TRANSPORT',
      name,
      pin,
    }
  }

  if (canAccessTransportAdmin(role)) {
    return {
      transport_id: userId ? String(userId) : `MAIN_${role}_${String(pin)}`,
      transport_pin: String(pin),
      transport_name: String(name || role || 'USER'),
      role,
      name,
      pin,
      is_admin: true,
      from_main_admin: true,
    }
  }

  if (isHybridTransport) {
    return {
      transport_id: String(userId || mainUser?.transport_id || pin),
      transport_pin: String(pin),
      transport_name: String(name || 'TRANSPORT'),
      role: 'TRANSPORT',
      name,
      pin,
      is_hybrid_transport: true,
      from_main_hybrid: true,
    }
  }

  return null
}

export function getTransportSession() {
  if (typeof window === 'undefined') return null

  const dedicated = readTransportSession()
  if (dedicated?.transport_id) return dedicated

  const mainUser = getActor() || readMainActor() || null
  return bridgeFromMain(mainUser)
}

export function getTransportContext() {
  if (typeof window === 'undefined') return null

  const dedicated = readTransportSession()
  if (dedicated?.transport_id) {
    return {
      role: normalizeRole(dedicated.role || 'TRANSPORT') || 'TRANSPORT',
      name: String(dedicated.transport_name || dedicated.name || 'TRANSPORT'),
      transport_name: String(dedicated.transport_name || dedicated.name || 'TRANSPORT'),
      transport_id: String(dedicated.transport_id),
      transport_pin: String(dedicated.transport_pin || dedicated.pin || dedicated.transport_id),
      pin: String(dedicated.pin || dedicated.transport_pin || dedicated.transport_id),
      from_transport_session: true,
    }
  }

  const bridged = bridgeFromMain(getActor() || readMainActor() || null)
  if (!bridged) return null

  return {
    role: normalizeRole(bridged.role) || 'TRANSPORT',
    name: String(bridged.name || bridged.transport_name || 'TRANSPORT'),
    transport_name: String(bridged.transport_name || bridged.name || 'TRANSPORT'),
    transport_id: String(bridged.transport_id),
    transport_pin: String(bridged.transport_pin || bridged.pin || bridged.transport_id),
    pin: String(bridged.pin || bridged.transport_pin || bridged.transport_id),
    is_admin: bridged.is_admin === true,
    is_hybrid_transport: bridged.is_hybrid_transport === true,
    from_main_admin: bridged.from_main_admin === true,
    from_main_hybrid: bridged.from_main_hybrid === true,
  }
}
