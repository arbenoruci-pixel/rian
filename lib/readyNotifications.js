import { readBestActor } from './sessionStore.js';
import { getDeviceId } from './deviceId.js';
import { isReadyNotificationOrderId } from './readyNotificationModel.js';
import { canTrackReadyNotifications } from './roles.js';
import { approvedApiRequest } from './approvedApiRequest.js';
import { createReadyNotificationStorage, READY_NOTIFICATION_LEGACY_KEY, READY_NOTIFICATION_ITEM_PREFIX } from './readyNotificationStorage.js';
export const NOTIFICATION_CHANGE = 'tepiha:ready-notifications';
let running = false, installed = false, storage = null, channel = null;
const actor = () => { const a = readBestActor({ allowTransportFallback: true }); return { ...a, id: a?.id || a?.user_id }; };
const notify = () => window.dispatchEvent(new Event(NOTIFICATION_CHANGE));
function getStorage() {
  if (!storage) storage = createReadyNotificationStorage({ indexedDB: globalThis.indexedDB, localStorage: globalThis.localStorage });
  return storage;
}
const read = () => getStorage().read();
async function write(rows) {
  await getStorage().write(rows);
  notify();
  try { channel?.postMessage('changed'); } catch {}
}
function verifyAcknowledgement(event, confirmed) {
  for (const field of ['id', 'attempt_id', 'order_id', 'actor_id', 'channel', 'kind']) {
    if (!confirmed || String(confirmed[field] ?? '') !== String(event[field] ?? '')) {
      throw new Error('Konfirmimi i lajmërimit nuk përputhet. Do të provohet përsëri.');
    }
  }
}
export const currentNotificationActorId = () => actor()?.id;
export const canUseReadyNotifications = () => !!actor()?.id && canTrackReadyNotifications(actor()?.role);
export async function localNotifications() { return (await read()).filter(e => e.viewer_id === actor()?.id); }
async function request(body) {
  getDeviceId();
  return approvedApiRequest('/api/client-profile', body, { timeoutMs: 8000 });
}
export async function recordReadyNotification({ orderId, channel, kind, attemptId }) {
  const worker = actor();
  if (!worker?.id) throw new Error('Hyr përsëri në aplikacion për të ruajtur lajmërimin.');
  if (!canTrackReadyNotifications(worker.role)) throw new Error('Ky rol nuk e ka lajmërimin GATI për porositë e bazës.');
  if (!isReadyNotificationOrderId(orderId)) throw new Error('Porosia nuk ka ID zyrtare.');
  if (!['sms','whatsapp','viber'].includes(channel) || !['opened','confirmed','cancelled'].includes(kind)) throw new Error('Lajmërimi është i pavlefshëm.');
  const id = crypto.randomUUID();
  const event = { id, attempt_id: attemptId || id, order_id: String(orderId), channel, kind,
    actor_id: worker.id, author_name: worker.name || worker.role, occurred_at: new Date().toISOString(),
    viewer_id: worker.id, pending: true };
  await read(); // Complete legacy migration before accepting a new event.
  if (actor()?.id !== worker.id) throw new Error('Përdoruesi ndryshoi. Hape përsëri lajmërimin.');
  await write([event]); // Commit this event before permitting external app handoff.
  if (actor()?.id !== worker.id) throw new Error('Përdoruesi ndryshoi. Hape përsëri lajmërimin.');
  void flushReadyNotifications();
  return event;
}
export async function flushReadyNotifications() {
  if (running || navigator.onLine === false || !canUseReadyNotifications()) return;
  running = true;
  try {
    const worker = actor();
    const pending = (await localNotifications()).filter(e => e.pending && !e.blocked);
    // Storage key enumeration is unordered. Every attestation needs its opened event first.
    const ordered = [...pending.filter(e => e.kind === 'opened'), ...pending.filter(e => e.kind !== 'opened')];
    for (const event of ordered) {
      if (actor()?.id !== worker?.id) break;
      if ((await read()).find(e => e.id === event.id && e.viewer_id === worker.id)?.blocked) continue;
      if (actor()?.id !== worker?.id) break;
      try {
        const result = await request({ ...event, action:'ADD_READY_NOTIFICATION' });
        if (actor()?.id !== worker?.id) break;
        verifyAcknowledgement(event, result?.event);
        await write([{ ...result.event, viewer_id: worker.id, pending: false }]);
      } catch (error) {
        const permanent = error.message === 'READY_NOTIFICATION_ROLE_DENIED' ||
          ([400,404,409].includes(error.httpStatus || error.status) && error.message !== 'READY_NOTIFICATION_ATTEMPT_PENDING');
        await write((await read()).filter(e => e.viewer_id === worker.id && e.attempt_id === event.attempt_id && e.pending).map(e => ({ ...e, sync_error: String(error.message), blocked: permanent })));
        if (permanent) continue;
        break; // Ordered replay: an attestation never overtakes its opened event.
      }
    }
  } catch {} finally { running = false; }
}
export async function fetchReadyNotifications(ids) {
  const worker = actor();
  if (!canUseReadyNotifications()) return { unavailable: true };
  if (!worker?.id || navigator.onLine === false) return { offline: true };
  const unique = [...new Set(ids.map(String))].filter(isReadyNotificationOrderId);
  for (let i=0;i<unique.length;i+=100) {
    const result = await request({ action:'GET_READY_NOTIFICATIONS', order_ids:unique.slice(i,i+100) });
    if (actor()?.id !== worker.id) return;
    if (result.truncated) throw new Error('Historia e lajmërimeve është e pjesshme.');
    await write(result.events.map(e => ({...e,viewer_id:worker.id,pending:false})));
  }
  return { offline: false };
}
export function installReadyNotifications() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const wake = () => void flushReadyNotifications();
  window.addEventListener('online',wake);
  window.addEventListener('focus',wake);
  window.addEventListener('tepiha:session-changed',() => { notify(); wake(); });
  window.addEventListener('storage',e => { if (e.key === READY_NOTIFICATION_LEGACY_KEY || e.key?.startsWith(READY_NOTIFICATION_ITEM_PREFIX) || !e.key) { notify(); wake(); } });
  document.addEventListener('visibilitychange',() => { if (!document.hidden) wake(); });
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(NOTIFICATION_CHANGE);
    channel.onmessage = () => { notify(); wake(); };
  }
  window.setInterval(wake,15000);
  wake();
}
