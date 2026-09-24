// Update checks are advisory. Let foreground work resume first, avoid offline
// attempts and overlapping checks, and recover from a transient fetch failure.
export function watchServiceWorkerUpdates({ check, shouldCheck, onSuccess,
  events = window, visibility = document, online = () => navigator.onLine !== false,
  setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 1400 }) {
  let stopped = false, active = false, timer = null, failures = 0, wakePending = false;
  const available = () => online() && !visibility.hidden && visibility.visibilityState !== 'hidden';
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = delay => { clear(); timer = setTimer(run, delay); };
  async function run() {
    timer = null;
    if (stopped || active || !available() || !shouldCheck()) return;
    active = true;
    let success = false;
    try { success = await check() === true; } catch { /* check owns error telemetry */ }
    active = false;
    if (stopped) return;
    if (success) {
      failures = 0; wakePending = false;
      try { onSuccess(); } catch { /* storage cannot break update recovery */ }
      return;
    }
    const delays = [5000, 15000, 60000];
    const retryDelay = delays[failures++];
    if (available() && shouldCheck() && (retryDelay !== undefined || wakePending)) {
      schedule(wakePending ? delayMs : retryDelay);
    }
    wakePending = false;
  }
  function resume() {
    if (stopped || !available()) { clear(); return; }
    if (!shouldCheck()) return;
    if (active) { wakePending = true; return; }
    failures = 0;
    schedule(delayMs);
  }
  events.addEventListener('pageshow', resume);
  events.addEventListener('online', resume);
  events.addEventListener('offline', resume);
  visibility.addEventListener('visibilitychange', resume);
  resume();
  return () => {
    stopped = true; clear();
    events.removeEventListener('pageshow', resume);
    events.removeEventListener('online', resume);
    events.removeEventListener('offline', resume);
    visibility.removeEventListener('visibilitychange', resume);
  };
}
