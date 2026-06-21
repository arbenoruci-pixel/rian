// lib/actorSession.js
// Active actor/session reader for the Vite runtime.

import { readMainActor } from './sessionStore';
import { resolveActorPin } from './pinIdentity';

export function getActor() {
  return readMainActor();
}

export function getActorPinStrict(actor = null) {
  return resolveActorPin(actor || getActor());
}

export function requireActorPin() {
  const a = getActor();
  const pin = getActorPinStrict(a);
  if (!pin) {
    const err = new Error('MISSING_PIN');
    err.code = 'MISSING_PIN';
    throw err;
  }
  return { ...a, pin, pinCode: pin };
}

export function actorPayload(action) {
  const a = getActor();
  const pin = getActorPinStrict(a);
  return {
    actor_pin: pin || null,
    actor_name: a?.name || null,
    actor_role: a?.role || null,
    actor_action: action || null,
  };
}

export function getActorStrict() {
  try {
    const a = getActor();
    const pin = getActorPinStrict(a);
    if (!a || !pin || !a.name) {
      return {
        pin: 'OFFLINE',
        name: 'OFFLINE',
        role: 'OFFLINE',
      };
    }
    return {
      pin,
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
