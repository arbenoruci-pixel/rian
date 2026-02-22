
// SMART SYNC ENGINE — TEPIHA BASE (non-breaking patch)

function loadQueue() {
  try { return JSON.parse(localStorage.getItem('offline_queue') || '[]'); }
  catch { return []; }
}

function saveQueue(q) {
  localStorage.setItem('offline_queue', JSON.stringify(q || []));
}

function isOpSuccess(respJson) {
  if (!respJson || respJson.ok !== true) return false;
  if (Array.isArray(respJson.results)) {
    return respJson.results.every(r => r && r.ok === true);
  }
  return true;
}

function computeNextRetry(attempts) {
  const base = Math.min(60000, 1000 * Math.pow(2, Math.min(attempts, 6)));
  const jitter = Math.floor(Math.random() * 400);
  return Date.now() + base + jitter;
}

export async function smartSyncOnce() {
  if (!navigator.onLine) return { ok:false, reason:'offline' };

  let queue = loadQueue();
  if (!queue.length) return { ok:true, synced:0 };

  const now = Date.now();
  let synced = 0;

  for (let i = 0; i < queue.length; i++) {
    const op = queue[i];

    if (op.nextRetryAt && op.nextRetryAt > now) continue;

    const res = await fetch('/api/offline-sync', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        type: op.type,
        payload: op.payload,
        op_id: op.op_id
      })
    });

    let json = null;
    try { json = await res.json(); } catch {}

    if (!res.ok || !isOpSuccess(json)) {
      op.attempts = (op.attempts || 0) + 1;
      op.nextRetryAt = computeNextRetry(op.attempts);

      saveQueue(queue);

      localStorage.setItem('tepiha_last_sync_error', JSON.stringify({
        ts: Date.now(),
        op_id: op.op_id,
        type: op.type,
        http: res.status,
        body: json
      }));

      return { ok:false, synced, reason:'op_failed' };
    }

    // SUCCESS → remove op
    queue.splice(i, 1);
    i--;
    synced++;
    saveQueue(queue);
  }

  return { ok:true, synced };
}

let syncing = false;

export function startSmartSync() {
  const run = async () => {
    if (syncing) return;
    syncing = true;
    try { await smartSyncOnce(); }
    finally { syncing = false; }
  };

  window.addEventListener('online', run);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') run();
  });

  setInterval(run, 15000);
}
