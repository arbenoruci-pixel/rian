import { withDeadline } from './boundedRequest.js';

export function isRecoverableDispatchPhoneCheck(error) {
  const code = String(error?.code || error?.message || error || '').trim().toUpperCase();
  if (/AUTH_REQUIRED|NOT_APPROVED|NOT_ALLOWED|MISMATCH|CONFLICT|INVALID|DISABLED|RETIRED|OTHER_USER/.test(code)) return false;
  return /NETWORK|TIMEOUT|UNREACHABLE/.test(code)
    || /^(DISPATCH_PHONE_CHECK_FAILED|AUTH_DEVICE_LOOKUP_FAILED|AUTH_USER_LOOKUP_FAILED)$/.test(code)
    || /^DISPATCH_PHONE_CHECK_HTTP_(408|425|429|500|502|503|504)$/.test(code)
    || [408, 425, 429, 500, 502, 503, 504].includes(Number(error?.httpStatus));
}

// One advisory phone lookup per form. Back off after two quick retries, then
// probe every 15s while visible: mobile networks can recover without an online
// event. Disposal aborts old requests when a phone changes or the form closes.
export function watchDispatchPhoneCheck({ inspect, onResult, onError, onBusy,
  events = window, visibility = document, online = () => navigator.onLine !== false,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false, running = false, timer = null, retries = 0, lastError = null;
  const lifecycle = new AbortController();
  const available = () => online() && !visibility.hidden;
  function schedule(delay) {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(run, delay);
  }
  async function run() {
    timer = null;
    if (stopped || running) return;
    if (!available()) {
      lastError = new Error('DISPATCH_PHONE_CHECK_NETWORK_FAILED');
      onError(lastError); onBusy(false);
      return;
    }
    running = true; onBusy(true);
    try {
      const result = await withDeadline(signal => inspect(signal), 15000, 'DISPATCH_PHONE_CHECK_TIMEOUT', { signal: lifecycle.signal });
      if (stopped) return;
      lastError = null; retries = 0; onResult(result);
    } catch (error) {
      if (stopped) return;
      lastError = error; onError(error);
      if (isRecoverableDispatchPhoneCheck(error) && available()) {
        schedule([1000, 3000, 15000][Math.min(retries++, 2)]);
      }
    } finally {
      running = false;
      if (!stopped) onBusy(false);
    }
  }
  function resume() {
    if (stopped || running || !available() || !lastError || !isRecoverableDispatchPhoneCheck(lastError)) return;
    retries = 0; schedule(0);
  }
  events.addEventListener('online', resume);
  events.addEventListener('focus', resume);
  visibility.addEventListener('visibilitychange', resume);
  schedule(320);
  return () => {
    stopped = true;
    lifecycle.abort();
    if (timer !== null) clearTimer(timer);
    events.removeEventListener('online', resume);
    events.removeEventListener('focus', resume);
    visibility.removeEventListener('visibilitychange', resume);
  };
}
