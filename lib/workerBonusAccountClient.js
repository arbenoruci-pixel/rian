import { getActor } from '@/lib/actorSession';
export { workerBonusMonthKey } from './workerBonusAccount.js';

const cache = new Map();
const inFlight = new Map();
const accessGeneration = new Map();
const CACHE_MS = 30000;
const identity = actor => `${actor?.id || actor?.user_id || ''}:${actor?.pin || ''}:${actor?.role || ''}`;
const errors = {
  AUTH_REQUIRED: 'Hyr përsëri në aplikacion për t’i parë bonuset.',
  DEVICE_NOT_APPROVED: 'Pajisja duhet të jetë e aprovuar.',
  WORKER_BONUS_FORBIDDEN: 'Nuk ke qasje në bonuset e kësaj llogarie.',
  WORKER_BONUS_SESSION_CHANGED: 'Llogaria ka ndryshuar. Hape përsëri faqen.',
  WORKER_BONUS_MONTH_INVALID: 'Zgjidhe muajin e saktë.',
};

function reportError(code, httpStatus = 0, message) {
  const error = new Error(message || errors[code] || 'Bonuset nuk u ngarkuan. Provo përsëri.');
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

function revokeCachedAccess(actorIdentity) {
  for (const key of cache.keys()) if (key.startsWith(`${actorIdentity}:`)) cache.delete(key);
  accessGeneration.set(actorIdentity, (accessGeneration.get(actorIdentity) || 0) + 1);
}

export async function fetchWorkerBonusAccount({ targetPin, month, force = false } = {}) {
  const actor = getActor() || {}, actorIdentity = identity(actor);
  const generation = accessGeneration.get(actorIdentity) || 0;
  const workerPin = String(targetPin || actor.pin || '').trim();
  const cacheKey = `${actorIdentity}:${workerPin}:${month || ''}`;
  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.savedAt < CACHE_MS) return cached.value;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
  const promise = (async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Je offline. Lidhu me internet për gjendjen e fundit të bonuseve.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const expectedActorId = actor.id || actor.user_id;
      const response = await fetch('/api/worker-bonuses', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetPin: workerPin, month, ...(expectedActorId ? { expectedActorId } : {}) }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        if ([401, 403].includes(response.status)) revokeCachedAccess(actorIdentity);
        throw reportError(data?.error || 'WORKER_BONUS_REQUEST_FAILED', response.status);
      }
      if (actorIdentity !== identity(getActor()) || generation !== (accessGeneration.get(actorIdentity) || 0)) {
        revokeCachedAccess(actorIdentity);
        throw reportError('WORKER_BONUS_SESSION_CHANGED', 403);
      }
      cache.set(cacheKey, { savedAt: Date.now(), value: data });
      while (cache.size > 12) cache.delete(cache.keys().next().value);
      return data;
    } finally { clearTimeout(timer); }
  })();
  inFlight.set(cacheKey, promise);
  try { return await promise; } finally { if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey); }
}
