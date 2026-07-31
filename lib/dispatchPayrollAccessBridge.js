const PAYROLL_PATH = '/arka/payroll';
const ACTOR_STORAGE_KEY = 'CURRENT_USER_DATA';
const INPUT_MARKER = 'data-dispatch-payroll-pin-bridge';

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readActor() {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage?.getItem?.(ACTOR_STORAGE_KEY) || '';
    const actor = raw ? JSON.parse(raw) : null;
    return actor && typeof actor === 'object' ? actor : null;
  } catch {
    return null;
  }
}

function isDispatchActor(actor) {
  return String(actor?.role || '').trim().toUpperCase() === 'DISPATCH';
}

function cleanPin(value) {
  return String(value || '').replace(/\D+/g, '').trim();
}

function isPayrollRoute() {
  try {
    return String(window.location?.pathname || '') === PAYROLL_PATH;
  } catch {
    return false;
  }
}

function setReactInputValue(input, value) {
  if (!input) return false;
  const next = String(value || '');
  if (!next || String(input.value || '') === next) return false;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    const setter = descriptor?.set;
    if (typeof setter === 'function') setter.call(input, next);
    else input.value = next;
  } catch {
    try { input.value = next; } catch { return false; }
  }

  try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
  try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
  return true;
}

function findMasterPinInput() {
  const labels = Array.from(document.querySelectorAll('label'));
  for (const label of labels) {
    const text = String(label?.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!text.includes('MASTER PIN')) continue;
    const input = label.querySelector('input[type="password"], input');
    if (input) return { input, label };
  }

  const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
  for (const input of inputs) {
    const parentText = String(input?.parentElement?.textContent || '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (parentText.includes('MASTER PIN')) return { input, label: input.parentElement };
  }
  return null;
}

function applyDispatchPayrollAccess() {
  if (!isBrowser() || !isPayrollRoute()) return false;
  const actor = readActor();
  if (!isDispatchActor(actor)) return false;

  const pin = cleanPin(actor?.pin);
  if (!pin) return false;

  const found = findMasterPinInput();
  if (!found?.input) return false;

  const { input, label } = found;
  setReactInputValue(input, pin);
  input.setAttribute(INPUT_MARKER, '1');
  input.setAttribute('aria-label', 'Dispatch PIN automatik');
  input.setAttribute('autocomplete', 'off');
  input.readOnly = true;

  try {
    const title = label?.querySelector?.('span');
    if (title) title.textContent = 'Dispatch PIN (automatik)';
  } catch {}

  try {
    label?.setAttribute?.('data-dispatch-payroll-access', 'enabled');
  } catch {}

  try {
    window.__TEPIHA_DISPATCH_PAYROLL_ACCESS__ = {
      enabled: true,
      actorPin: pin,
      actorRole: 'DISPATCH',
      path: PAYROLL_PATH,
      updatedAt: new Date().toISOString(),
    };
  } catch {}

  return true;
}

export function installDispatchPayrollAccessBridge() {
  if (!isBrowser()) return () => {};

  let timer = null;
  let interval = null;
  let observer = null;
  let stopped = false;

  const schedule = (delay = 0) => {
    if (stopped) return;
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      applyDispatchPayrollAccess();
    }, Math.max(0, Number(delay || 0)));
  };

  schedule(0);
  schedule(350);

  try {
    observer = new MutationObserver(() => schedule(40));
    const target = document.getElementById('root') || document.body || document.documentElement;
    if (target) observer.observe(target, { childList: true, subtree: true });
  } catch {}

  const onResume = () => schedule(20);
  const onClick = () => schedule(20);
  const onSession = () => schedule(20);

  try { window.addEventListener('focus', onResume, { passive: true }); } catch {}
  try { window.addEventListener('pageshow', onResume, { passive: true }); } catch {}
  try { window.addEventListener('popstate', onResume, { passive: true }); } catch {}
  try { window.addEventListener('tepiha:session-changed', onSession, { passive: true }); } catch {}
  try { document.addEventListener('visibilitychange', onResume, { passive: true }); } catch {}
  try { document.addEventListener('click', onClick, true); } catch {}

  interval = window.setInterval(() => {
    if (stopped || !isPayrollRoute()) return;
    const actor = readActor();
    if (!isDispatchActor(actor)) return;
    const found = findMasterPinInput();
    const pin = cleanPin(actor?.pin);
    if (found?.input && pin && String(found.input.value || '') !== pin) applyDispatchPayrollAccess();
  }, 1200);

  return () => {
    stopped = true;
    try { if (timer) window.clearTimeout(timer); } catch {}
    try { if (interval) window.clearInterval(interval); } catch {}
    try { observer?.disconnect?.(); } catch {}
    try { window.removeEventListener('focus', onResume); } catch {}
    try { window.removeEventListener('pageshow', onResume); } catch {}
    try { window.removeEventListener('popstate', onResume); } catch {}
    try { window.removeEventListener('tepiha:session-changed', onSession); } catch {}
    try { document.removeEventListener('visibilitychange', onResume); } catch {}
    try { document.removeEventListener('click', onClick, true); } catch {}
  };
}

export default installDispatchPayrollAccessBridge;
