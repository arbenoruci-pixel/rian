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
