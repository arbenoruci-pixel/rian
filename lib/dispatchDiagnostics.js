import { fetchJsonWithDeadline } from './boundedRequest.js';

// Same-origin diagnostics contain stage/timing/error codes only, never the form.
export function reportDispatchDiagnostic(phase, details = {}) {
  if (typeof window === 'undefined') return;
  const rawCode = String(details.code || '');
  const code = /^(?:[A-Z][A-Z0-9_]+|[A-Za-z]+Error)$/.test(rawCode)
    ? rawCode : rawCode ? 'DISPATCH_SUBMISSION_FAILED' : '';
  const body = { bootId: 'dispatch-' + Date.now(), incidentType: 'dispatch_submission',
    currentPath: '/dispatch', phase, events: [],
    meta: { stage: phase, code: code.slice(0, 100),
      elapsedMs: Number(details.elapsedMs || 0),
      build: String(window.__TEPIHA_BUILD_ID || '').slice(-150) } };
  void fetchJsonWithDeadline('/api/runtime-incident', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }, 4000).catch(() => {});
}

export function traceDispatchSubmission() {
  const started = Date.now(); let stage = 'intent';
  const timer = setTimeout(() => reportDispatchDiagnostic('waiting_' + stage, { elapsedMs: Date.now() - started }), 20000);
  return {
    stage(value) { stage = value; },
    finish(value, code = '') {
      clearTimeout(timer);
      reportDispatchDiagnostic(value, { code, elapsedMs: Date.now() - started });
    },
  };
}
