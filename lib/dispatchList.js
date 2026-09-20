import { withDeadline } from './boundedRequest.js';

export function mergeDispatchRows(rows, updates) {
  const byId = new Map((rows || []).filter(row => row?.id).map(row => [row.id, row]));
  for (const row of updates || []) {
    if (!row?.id) continue;
    const previous = byId.get(row.id);
    if (previous && Date.parse(previous.updated_at || previous.created_at) > Date.parse(row.updated_at || row.created_at)) continue;
    byId.set(row.id, { ...row, _table: 'transport_orders' });
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at));
}

export function isRetryableDispatchRead(error) {
  const code = String(error?.code || error?.message || '').toUpperCase();
  if (/AUTH_REQUIRED|NOT_APPROVED|NOT_ALLOWED|MISMATCH|CONFLICT|INVALID|DISABLED|RETIRED|OTHER_USER/.test(code)) return false;
  return /NETWORK|TIMEOUT|UNREACHABLE|LIST_FAILED|LOOKUP_FAILED/.test(code)
    || [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.httpStatus));
}

// Keep committed rows visible through a failed/older read. Overlapping refreshes
// share work and request one follow-up, so a post-create refresh cannot be lost.
export function createDispatchListLoader({ fetchRows, onRows, onBusy, onError,
  getActorId, available = () => true, timeoutMs = 15000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let running = null, again = false, stopped = false, paused = false, retryTimer = null, failures = 0;
  let request = null;
  let actorId = String(getActorId() || ''), revision = 0;
  const confirmations = new Map();
  const canRead = () => !paused && available();
  function currentActor() {
    const current = String(getActorId() || '');
    if (current !== actorId) {
      actorId = current; confirmations.clear(); revision++;
      onRows(() => []);
    }
    return current;
  }
  function record(row, expectedActor = currentActor()) {
    if (stopped || !row?.id || expectedActor !== currentActor()) return;
    const pending = confirmations.get(row.id);
    if (pending && Date.parse(pending.row.updated_at) > Date.parse(row.updated_at)) return;
    confirmations.set(row.id, { row: { ...row, _table: 'transport_orders' }, revision: ++revision });
    onRows(rows => String(getActorId() || '') === expectedActor ? mergeDispatchRows(rows, [row]) : []);
  }
  function refresh({ followUp = true } = {}) {
    if (stopped || !canRead()) return Promise.resolve();
    if (running) { if (followUp) again = true; return running; }
    if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
    running = Promise.resolve().then(async () => {
      if (stopped) return;
      onBusy(true);
      do {
        again = false;
        if (stopped || !canRead()) break;
        const actor = currentActor(), startedRevision = revision;
        const currentRequest = new AbortController();
        request = currentRequest;
        try {
          const rows = await withDeadline(signal => fetchRows(actor, signal), timeoutMs, 'DISPATCH_LIST_TIMEOUT', { signal: currentRequest.signal });
          if (stopped) return;
          if (currentRequest.signal.aborted) continue;
          if (currentActor() !== actor) { again = true; continue; }
          if (!Array.isArray(rows)) throw new Error('DISPATCH_LIST_INVALID_RESPONSE');
          const overlay = [];
          for (const [id, entry] of confirmations) {
            const fetched = rows.find(row => row.id === id);
            if (entry.revision > startedRevision || (fetched && Date.parse(fetched.updated_at) < Date.parse(entry.row.updated_at))) overlay.push(entry.row);
            else confirmations.delete(id);
          }
          onRows(() => String(getActorId() || '') === actor ? mergeDispatchRows(rows, overlay) : []);
          failures = 0; onError(null);
        } catch (error) {
          if (stopped) return;
          // Opening a form or backgrounding the app deliberately cancels this
          // advisory download. It must not show an outage or start retry traffic.
          if (currentRequest.signal.aborted) continue;
          if (currentActor() !== actor) { again = true; continue; }
          onError(error);
          if (!again && isRetryableDispatchRead(error) && canRead()) {
            retryTimer = setTimer(() => { retryTimer = null; void refresh(); }, [1500, 5000, 15000][Math.min(failures++, 2)]);
          }
        } finally {
          if (request === currentRequest) request = null;
        }
      } while (again && !stopped && canRead());
    }).finally(() => { running = null; if (!stopped) onBusy(false); });
    return running;
  }
  return { refresh, record, setPaused(value) {
    if (stopped || paused === !!value) return;
    paused = !!value;
    if (paused) {
      again = false;
      if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
      request?.abort();
      onBusy(false);
    } else {
      // Also queues one fresh read if a cancelled request is still unwinding.
      void refresh();
    }
  }, stop() {
    stopped = true; request?.abort();
    if (retryTimer !== null) clearTimer(retryTimer);
  } };
}
