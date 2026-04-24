// lib/actorSession.js
// Active actor/session reader for the Vite runtime.

import { readMainActor } from './sessionStore';

export function getActor() {
  return readMainActor();
}

export function requireActorPin() {
  const a = getActor();
  const pin = String(a?.pin ?? '').trim();
  if (!pin) {
    const err = new Error('MISSING_PIN');
    err.code = 'MISSING_PIN';
    throw err;
  }
  return a;
}

export function actorPayload(action) {
  const a = getActor();
  return {
    actor_pin: a?.pin || null,
    actor_name: a?.name || null,
    actor_role: a?.role || null,
    actor_action: action || null,
  };
}

export function getActorStrict() {
  try {
    const a = getActor();
    if (!a || !a.pin || !a.name) {
      return {
        pin: 'OFFLINE',
        name: 'OFFLINE',
        role: 'OFFLINE',
      };
    }
    return {
      pin: String(a.pin),
      name: String(a.name),
      role: a.role ? String(a.role) : null,
    };
  } catch {
    return {
      pin: 'OFFLINE',
      name: 'OFFLINE',
      role: 'OFFLINE',
    };
  }
}
