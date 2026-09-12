import { readBestActor } from './sessionStore.js';
import { getDeviceId } from './deviceId.js';
import { mergeNotificationEvents, isReadyNotificationOrderId } from './readyNotificationModel.js';
import { canTrackReadyNotifications } from './roles.js';
import { approvedApiRequest } from './approvedApiRequest.js';
export const NOTIFICATION_CHANGE = 'tepiha:ready-notifications';
const KEY = 'tepiha_ready_notifications_v1';
let running = false, installed = false;
const actor = () => { const a = readBestActor({ allowTransportFallback: true }); return { ...a, id: a?.id || a?.user_id }; };
const notify = () => window.dispatchEvent(new Event(NOTIFICATION_CHANGE));
const ITEM_PREFIX = 'tepiha_ready_notification_item_v2:';
function eventKey(event) {
  if (!event || typeof event.id !== 'string' || !event.id || typeof event.viewer_id !== 'string' || !event.viewer_id) {
    throw new Error('Ruajtja e lajmërimeve nuk lexohet.');
  }
  // Keep the immutable server acknowledgement separate from pending metadata.
  // A delayed tab can never turn an acknowledged event back into pending.
  return ITEM_PREFIX + (event.pending === false ? 'ack:' : 'pending:') + encodeURIComponent(event.viewer_id) + ':' + event.id;
}
function writeEvent(event) {
  const key = eventKey(event);
  const raw = JSON.stringify(event);
  localStorage.setItem(key, raw);
  const saved = localStorage.getItem(key);
  if (saved !== raw) {
    if (!saved || eventKey(JSON.parse(saved)) !== key) throw new Error('Lajmërimi nuk u ruajt në pajisje.');
  }
}
function migrateLegacy() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return;
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('Ruajtja e lajmërimeve nuk lexohet.');
  for (const event of rows) {
    if (!localStorage.getItem(eventKey(event))) writeEvent(event);
  }
  // Copy first; interruption or quota failure must leave the old queue available.
  if (localStorage.getItem(KEY) === raw) localStorage.removeItem(KEY);
}
function read() {
  migrateLegacy();
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(ITEM_PREFIX)) keys.push(key);
  }
  const rows = new Map();
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    const event = JSON.parse(raw);
    if (eventKey(event) !== key) throw new Error('Ruajtja e lajmërimeve nuk lexohet.');
    const identity = JSON.stringify([event.viewer_id, event.id]);
    const previous = rows.get(identity);
    if (!previous || event.pending === false || previous.pending !== false) rows.set(identity, event);
  }
  return [...rows.values()];
}
function write(rows) {
  // Separate event keys preserve simultaneous writes from independent tabs.
  // No pending event is removed until a server acknowledgement has been stored.
  for (const event of rows) writeEvent(event);
  notify();
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
export function localNotifications() { return read().filter(e => e.viewer_id === actor()?.id); }
async function request(body) {
  getDeviceId();
  return approvedApiRequest('/api/client-profile', body, { timeoutMs: 8000 });
}
export function recordReadyNotification({ orderId, channel, kind, attemptId }) {
  const worker = actor();
  if (!worker?.id) throw new Error('Hyr përsëri në aplikacion për të ruajtur lajmërimin.');
  if (!canTrackReadyNotifications(worker.role)) throw new Error('Ky rol nuk e ka lajmërimin GATI për porositë e bazës.');
  if (!isReadyNotificationOrderId(orderId)) throw new Error('Porosia nuk ka ID zyrtare.');
  if (!['sms','whatsapp','viber'].includes(channel) || !['opened','confirmed','cancelled'].includes(kind)) throw new Error('Lajmërimi është i pavlefshëm.');
  const id = crypto.randomUUID();
  const event = { id, attempt_id: attemptId || id, order_id: String(orderId), channel, kind,
    actor_id: worker.id, author_name: worker.name || worker.role, occurred_at: new Date().toISOString(),
    viewer_id: worker.id, pending: true };
  write([...read(),event]); // Synchronous persistence before external app handoff.
  void flushReadyNotifications();
  return event;
}
export async function flushReadyNotifications() {
  if (running || navigator.onLine === false || !canUseReadyNotifications()) return;
  running = true;
  try {
    const worker = actor();
    const pending = localNotifications().filter(e => e.pending && !e.blocked);
    // Storage key enumeration is unordered. Every attestation needs its opened event first.
    const ordered = [...pending.filter(e => e.kind === 'opened'), ...pending.filter(e => e.kind !== 'opened')];
    for (const event of ordered) {
      if (actor()?.id !== worker?.id) break;
      if (read().find(e => e.id === event.id)?.blocked) continue;
      try {
        const result = await request({ ...event, action:'ADD_READY_NOTIFICATION' });
        if (actor()?.id !== worker?.id) break;
        verifyAcknowledgement(event, result?.event);
        write(mergeNotificationEvents(read(), [{ ...result.event, viewer_id: worker.id, pending: false }]));
      } catch (error) {
        const permanent = error.message === 'READY_NOTIFICATION_ROLE_DENIED' ||
          ([400,404,409].includes(error.httpStatus || error.status) && error.message !== 'READY_NOTIFICATION_ATTEMPT_PENDING');
        write(read().map(e => e.attempt_id === event.attempt_id && e.pending ? { ...e, sync_error: String(error.message), blocked: permanent } : e));
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
    write(mergeNotificationEvents(read(), result.events.map(e => ({...e,viewer_id:worker.id,pending:false}))));
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
  window.addEventListener('storage',e => { if (e.key === KEY || e.key?.startsWith(ITEM_PREFIX) || !e.key) { notify(); wake(); } });
  document.addEventListener('visibilitychange',() => { if (!document.hidden) wake(); });
  window.setInterval(wake,15000);
  wake();
}
