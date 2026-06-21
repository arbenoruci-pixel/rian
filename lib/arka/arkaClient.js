import { ARKA_ACTION } from './arkaConstants.js';
import { isArkaNetworkError, postArkaTransaction } from './arkaNetwork.js';

const OFFLINE_QUEUE_TYPE = 'arka_transaction';
const DEFAULT_RETRY_DELAYS_MS = [500, 1400, 3000];

function localIdempotencySuffix() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function flattenParts(parts = []) {
  return (Array.isArray(parts) ? parts : [parts])
    .flat(Infinity)
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
}

export function buildArkaIdempotencyKey(action, parts = [], options = {}) {
  const cleanAction = String(action || '').trim().toUpperCase();
  const cleanParts = flattenParts(parts);
  const stable = [cleanAction, ...cleanParts].join(':');
  if (options?.randomSuffix === true) return [stable, localIdempotencySuffix()].filter(Boolean).join(':');
  return stable || cleanAction;
}

function stableStringify(value) {
  const seen = new WeakSet();
  const sort = (input) => {
    if (!input || typeof input !== 'object') return input;
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(sort);
    return Object.keys(input).sort().reduce((out, key) => {
      if (['created_at', 'updated_at', 'clientTs', '_queued_at', '_flush_attempt'].includes(key)) return out;
      out[key] = sort(input[key]);
      return out;
    }, {});
  };
  try { return JSON.stringify(sort(value)); } catch { return String(value || ''); }
}

function simpleHash(input = '') {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function deriveIdempotencyKey(action, payload = {}) {
  const existing = String(payload?.idempotencyKey || payload?.idempotency_key || '').trim();
  if (existing) return existing;
  return buildArkaIdempotencyKey(action, ['AUTO', simpleHash(stableStringify({ ...payload, action }))]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function isOnline() {
  try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; }
}

async function enqueueArkaTransaction(payload = {}, meta = {}) {
  const { queueOp } = await import('@/lib/offlineSyncClient');
  const opId = await queueOp(OFFLINE_QUEUE_TYPE, {
    transaction: {
      ...(payload || {}),
      _queued_at: new Date().toISOString(),
      _queue_reason: meta?.reason || 'network',
    },
    action: payload?.action,
    idempotency_key: payload?.idempotencyKey || payload?.idempotency_key || '',
  });
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tepiha:arka-offline-queued', {
        detail: { op_id: opId, action: payload?.action, idempotency_key: payload?.idempotencyKey || payload?.idempotency_key || '' },
      }));
    }
  } catch {}
  return opId;
}

export function isQueuedArkaResult(result = {}) {
  return Boolean(result?.offlineQueued || result?.queued || result?.localOnly || result?.offline);
}

export async function arkaTransaction(payload = {}, options = {}) {
  const action = String(payload?.action || '').trim().toUpperCase();
  if (!Object.values(ARKA_ACTION).includes(action)) throw new Error('ARKA_ACTION_INVALID');

  const idempotencyKey = deriveIdempotencyKey(action, payload);
  const body = {
    ...payload,
    action,
    idempotencyKey,
    idempotency_key: payload?.idempotency_key || idempotencyKey,
  };

  const queueOnNetworkFailure = options?.queueOnNetworkFailure !== false && payload?.queueOnNetworkFailure !== false;
  const retryDelays = Array.isArray(options?.retryDelaysMs) ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = options?.timeoutMs;
  const maxAttempts = Math.max(1, Number(options?.maxAttempts || retryDelays.length || 1));
  let lastNetworkError = null;

  if (!isOnline()) {
    if (!queueOnNetworkFailure) {
      const err = new Error('ARKA_OFFLINE');
      err.network = true;
      throw err;
    }
    const queuedOpId = await enqueueArkaTransaction(body, { reason: 'offline' });
    return { ok: true, offline: true, offlineQueued: true, queued: true, localOnly: true, action, idempotencyKey, queuedOpId };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await postArkaTransaction(body, { timeoutMs });
    } catch (error) {
      if (!isArkaNetworkError(error)) throw error;
      lastNetworkError = error;
      if (attempt < maxAttempts - 1) await delay(retryDelays[Math.min(attempt, retryDelays.length - 1)] || 0);
    }
  }

  if (!queueOnNetworkFailure) throw lastNetworkError || new Error('ARKA_NETWORK_UNREACHABLE');

  const queuedOpId = await enqueueArkaTransaction(body, { reason: String(lastNetworkError?.message || 'network') });
  return {
    ok: true,
    offline: true,
    offlineQueued: true,
    queued: true,
    localOnly: true,
    action,
    idempotencyKey,
    queuedOpId,
    reason: 'ARKA_NETWORK_QUEUED',
  };
}
