export const PUSH_CONSENT_KEY = 'tepiha_transport_push_consent_v1';
const messages = {
  PUSH_SESSION_CHANGED: 'Llogaria ka ndryshuar. Hape përsëri Transportin.',
  PUSH_UNAVAILABLE: 'Njoftimet nuk janë ende gati. Provo përsëri më vonë.',
  PUSH_TEST_RATE_LIMIT: 'Prit një minutë para provës tjetër.',
  PUSH_ORDER_CHANGED: 'Kjo porosi ka ndryshuar ose i është caktuar një shoferi tjetër.',
  DEVICE_NOT_APPROVED: 'Telefoni duhet të jetë i aprovuar nga Dispatch.',
};
export async function pushRequest(action, actorId, extra = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('/api/transport/push', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...extra, action, expectedActorId: actorId }), signal: controller.signal });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(messages[result.error] || 'Njoftimet nuk u konfirmuan. Kontrollo internetin dhe provo përsëri.');
    return result;
  } finally { clearTimeout(timer); }
}
export function pushSupport(w = window, n = navigator) {
  const ios = /iPhone|iPad|iPod/.test(n.userAgent) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1);
  const installed = w.matchMedia?.('(display-mode: standalone)').matches || n.standalone === true;
  if (ios && !installed) return 'install';
  return w.isSecureContext && 'serviceWorker' in n && 'PushManager' in w && 'Notification' in w ? 'supported' : 'unsupported';
}
export function readPushConsent() { try { return JSON.parse(localStorage.getItem(PUSH_CONSENT_KEY) || 'null'); } catch { return null; } }
export function writePushConsent(value) {
  try { if (value) localStorage.setItem(PUSH_CONSENT_KEY, JSON.stringify(value)); else localStorage.removeItem(PUSH_CONSENT_KEY); } catch {}
}
export function applicationServerKey(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
export async function subscriptionHash(subscription) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function ensurePushWorker(registration) {
  const probe = () => new Promise(resolve => {
    if (!registration.active) return resolve(false);
    const channel = new MessageChannel();
    const done = value => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(value); };
    const timer = setTimeout(() => done(false), 800);
    channel.port1.onmessage = event => done(event.data?.pushVersion === 1);
    try { registration.active.postMessage({ type: 'TEPIHA_PUSH_READY' }, [channel.port2]); } catch { done(false); }
  });
  if (await probe()) return;
  // Upgrade an installed older worker once, without clearing offline data.
  await registration.update();
  for (let i = 0; i < 8; i += 1) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Hape përsëri app-in që të përfundojë përditësimi i njoftimeve.');
}
export function installPushSessionGuard(readActor) {
  const check = () => {
    const consent = readPushConsent();
    const actor = readActor();
    if (!consent || consent.actorId === String(actor?.id || actor?.user_id || '')) return;
    writePushConsent(null);
    void pushRequest('DISABLE', consent.actorId).catch(() => {});
    void navigator.serviceWorker?.getRegistration('/').then(reg => reg?.pushManager?.getSubscription())
      .then(sub => sub?.unsubscribe()).catch(() => {});
  };
  window.addEventListener('tepiha:session-changed', check);
  window.addEventListener('storage', check);
}
