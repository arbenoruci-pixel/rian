import assert from 'node:assert/strict';

const LOCAL_PREFIX = 'transport_receivable_payment_intent_v1:';
const SESSION_PREFIX = 'transport_receivable_payment_intent_session_v2:';

class MemoryStorage {
  constructor({ failWrites = false } = {}) {
    this.failWrites = failWrites;
    this.rows = new Map();
  }

  getItem(key) {
    return this.rows.has(String(key)) ? this.rows.get(String(key)) : null;
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error('QUOTA_EXCEEDED');
    this.rows.set(String(key), String(value));
  }

  removeItem(key) {
    this.rows.delete(String(key));
  }
}

function createCacheStorage({ putGate = null, deleteGate = null } = {}) {
  const buckets = new Map();
  return {
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const bucket = buckets.get(name);
      return {
        async put(url, response) {
          if (putGate) await putGate;
          bucket.set(String(url), await response.text());
        },
        async match(url) {
          const body = bucket.get(String(url));
          return body == null ? undefined : new Response(body, { headers: { 'content-type': 'application/json' } });
        },
        async delete(url) {
          if (deleteGate) await deleteGate;
          return bucket.delete(String(url));
        },
      };
    },
  };
}

function installBrowser({ local, session, caches } = {}) {
  globalThis.window = {
    localStorage: local || new MemoryStorage(),
    sessionStorage: session || new MemoryStorage(),
    location: { origin: 'https://tepiha.vercel.app' },
  };
  globalThis.indexedDB = undefined;
  globalThis.caches = caches;
}

async function freshModule(label) {
  return await import(`../lib/transportPaymentIntent.js?test=${label}-${Date.now()}-${Math.random()}`);
}

// localStorage failure must recover through a restart-durable Cache Storage copy.
{
  const local = new MemoryStorage({ failWrites: true });
  const session = new MemoryStorage();
  const durableCaches = createCacheStorage();
  installBrowser({ local, session, caches: durableCaches });
  const journal = await freshModule('cache-fallback');
  const first = await journal.acquireTransportPaymentIntent('order-cache', 50, 101.88);
  assert.equal(first.storageUnavailable, false);
  assert.equal(first.storage.cache, true);
  assert.equal(first.expectedTotalDue, 101.88);

  // Simulate the Android app being closed: memory + session are gone, Cache remains.
  installBrowser({
    local: new MemoryStorage({ failWrites: true }),
    session: new MemoryStorage(),
    caches: durableCaches,
  });
  const restartedJournal = await freshModule('cache-restart');
  const retry = await restartedJournal.acquireTransportPaymentIntent('order-cache', 50, 51.88);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  assert.equal(retry.expectedTotalDue, 101.88);
  await restartedJournal.clearTransportPaymentIntent('order-cache', first.idempotencyKey);
  let clearedIntent = await restartedJournal.readTransportPaymentIntent('order-cache');
  for (let attempt = 0; clearedIntent && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    clearedIntent = await restartedJournal.readTransportPaymentIntent('order-cache');
  }
  assert.equal(clearedIntent, null);
}

// A delayed cleanup must finish before a later intent can use the same order.
{
  let releaseDelete;
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  installBrowser({
    local: new MemoryStorage({ failWrites: true }),
    session: new MemoryStorage(),
    caches: createCacheStorage({ deleteGate }),
  });
  const journal = await freshModule('delayed-cleanup');
  const first = await journal.acquireTransportPaymentIntent('order-cleanup', 15, 40);
  await journal.clearTransportPaymentIntent('order-cleanup', first.idempotencyKey);

  let settled = false;
  const acquiring = journal.acquireTransportPaymentIntent('order-cleanup', 16, 25).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  releaseDelete();
  const second = await acquiring;
  assert.equal(second.storageUnavailable, false);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
}

// sessionStorage alone is not durable enough to authorize a financial POST.
{
  installBrowser({
    local: new MemoryStorage({ failWrites: true }),
    session: new MemoryStorage(),
    caches: undefined,
  });
  const journal = await freshModule('no-durable-store');
  const intent = await journal.acquireTransportPaymentIntent('order-blocked', 20, 20);
  assert.equal(intent.storage.session, true);
  assert.equal(intent.storageUnavailable, true);
}

// Two distinct keys for one order are a reconciliation conflict, never "newest wins".
{
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const orderId = 'order-conflict';
  local.setItem(LOCAL_PREFIX + orderId, JSON.stringify({
    orderId,
    amountReceived: 30,
    idempotencyKey: 'KEY-A',
    expectedTotalDue: 30,
    createdAt: 100,
  }));
  session.setItem(SESSION_PREFIX + orderId, JSON.stringify({
    orderId,
    amountReceived: 30,
    idempotencyKey: 'KEY-B',
    expectedTotalDue: 30,
    createdAt: 200,
  }));
  installBrowser({ local, session, caches: undefined });
  const journal = await freshModule('conflict');
  const intent = await journal.readTransportPaymentIntent(orderId);
  assert.equal(intent.storageConflict, true);
  assert.equal(intent.conflicts.length, 2);
}

// Concurrent taps in one page acquire exactly one key.
{
  installBrowser({ local: new MemoryStorage(), session: new MemoryStorage(), caches: undefined });
  const journal = await freshModule('concurrent');
  const [left, right] = await Promise.all([
    journal.acquireTransportPaymentIntent('order-concurrent', 44, 44),
    journal.acquireTransportPaymentIntent('order-concurrent', 44, 44),
  ]);
  assert.equal(left.storageUnavailable, false);
  assert.equal(right.storageUnavailable, false);
  assert.equal(left.idempotencyKey, right.idempotencyKey);
}

// An unresolved old key remains available for reconciliation and is never replaced silently.
{
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const orderId = 'order-stale';
  local.setItem(LOCAL_PREFIX + orderId, JSON.stringify({
    orderId,
    amountReceived: 55,
    idempotencyKey: 'STALE-KEY',
    createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
  }));
  installBrowser({ local, session, caches: undefined });
  const journal = await freshModule('stale');
  const existing = await journal.readTransportPaymentIntent(orderId);
  const acquired = await journal.acquireTransportPaymentIntent(orderId, 55, 55);
  assert.equal(existing.stale, true);
  assert.equal(acquired.idempotencyKey, 'STALE-KEY');
  assert.equal(acquired.expectedTotalDue, null);
  assert.ok(local.getItem(LOCAL_PREFIX + orderId));
}

// A delayed durable write must hold acquisition; no financial POST may outrun it.
{
  let releasePut;
  const putGate = new Promise((resolve) => { releasePut = resolve; });
  installBrowser({
    local: new MemoryStorage({ failWrites: true }),
    session: new MemoryStorage(),
    caches: createCacheStorage({ putGate }),
  });
  const journal = await freshModule('delayed-write');
  let settled = false;
  const acquiring = journal.acquireTransportPaymentIntent('order-delayed', 12, 12).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  releasePut();
  const intent = await acquiring;
  assert.equal(intent.storageUnavailable, false);
  assert.equal(intent.storage.cache, true);
}

// A durable write that never settles must time out closed, not hang the UI or POST.
{
  const never = new Promise(() => {});
  installBrowser({
    local: new MemoryStorage({ failWrites: true }),
    session: new MemoryStorage(),
    caches: createCacheStorage({ putGate: never }),
  });
  const journal = await freshModule('hung-write');
  const startedAt = Date.now();
  const intent = await journal.acquireTransportPaymentIntent('order-hung', 17, 17);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 1_300 && elapsed < 3_000);
  assert.equal(intent.storageUnavailable, true);
  assert.equal(intent.storage.uncertain, true);
}

// A failed durable read is "unknown", not "empty"; fresh-key creation must block.
{
  installBrowser({
    local: new MemoryStorage({ failWrites: true }),
    session: new MemoryStorage(),
    caches: { async open() { throw new Error('TEMPORARY_CACHE_READ_FAILURE'); } },
  });
  const journal = await freshModule('uncertain-read');
  const intent = await journal.acquireTransportPaymentIntent('order-uncertain', 13, 13);
  assert.equal(intent.storageReadUncertain, true);
  assert.equal(intent.idempotencyKey, undefined);
}

console.log('PASS transport payment intent resilience v2');
