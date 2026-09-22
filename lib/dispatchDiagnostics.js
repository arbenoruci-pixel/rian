import { fetchJsonWithDeadline } from './boundedRequest.js';

// Same-origin diagnostics contain timings, safe UUIDs and release identifiers,
// never customer names, phone numbers or the form payload.
export function reportDispatchDiagnostic(phase, details = {}) {
  if (typeof window === 'undefined') return;
  const at = Date.now();
  const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '')) ? value : '';
  let asset = '';
  try {
    const src = document.querySelector('script[type="module"][src]')?.getAttribute('src') || '';
    const path = new URL(src, window.location.origin).pathname;
    if (/^\/assets\/index-[\w-]+\.js$/.test(path)) asset = path;
  } catch {}
  const rawCode = String(details.code || '');
  const code = /^(?:[A-Z][A-Z0-9_]+|[A-Za-z]+Error)$/.test(rawCode)
    ? rawCode : rawCode ? 'DISPATCH_SUBMISSION_FAILED' : '';
  const body = { bootId: 'dispatch-' + at, incidentType: 'dispatch_submission',
    currentPath: '/dispatch', phase, events: [],
    lastEventAt: new Date(at).toISOString(), online: navigator.onLine !== false,
    visibilityState: document.visibilityState,
    meta: { stage: phase, code: code.slice(0, 100),
      elapsedMs: Number(details.elapsedMs || 0),
      requestId: uuid(details.requestId), orderId: uuid(details.orderId),
      storageStage: String(details.storageStage || '').slice(0, 40),
      attempts: Number(details.attempts || 0), asset, release: 'dispatch-confirmation-v1',
      build: String(window.__TEPIHA_BUILD_ID || '').slice(-150) } };
  void fetchJsonWithDeadline('/api/runtime-incident', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }, 4000).catch(() => {});
}

export function traceDispatchSubmission() {
  const started = Date.now(); let stage = 'intent', requestId = '';
  const timer = setTimeout(() => reportDispatchDiagnostic('waiting_' + stage, { requestId, elapsedMs: Date.now() - started }), 20000);
  return {
    identify(value) { requestId = value; },
    stage(value) { stage = value; },
    finish(value, code = '') {
      clearTimeout(timer);
      reportDispatchDiagnostic(value, { code, requestId, elapsedMs: Date.now() - started });
    },
  };
}
