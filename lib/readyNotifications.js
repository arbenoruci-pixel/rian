import { readBestActor } from './sessionStore.js';
import { getDeviceId } from './deviceId.js';
import { mergeNotificationEvents } from './readyNotificationModel.js';
export const NOTIFICATION_CHANGE = 'tepiha:ready-notifications';
const KEY = 'tepiha_ready_notifications_v1';
let running = false, installed = false;
const actor = () => { const a = readBestActor({ allowTransportFallback: true }); return { ...a, id: a?.id || a?.user_id }; };
const notify = () => window.dispatchEvent(new Event(NOTIFICATION_CHANGE));
function read() {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('Ruajtja e lajmërimeve nuk lexohet.');
  return rows;
}
function write(rows) {
  // Pending events are retained until acknowledged, even after a long outage.
  localStorage.setItem(KEY, JSON.stringify(rows));
  notify();
}
export const currentNotificationActorId = () => actor()?.id;
export function localNotifications() { return read().filter(e => e.viewer_id === actor()?.id); }
async function request(body) {
  getDeviceId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/client-profile', { method:'POST', credentials:'same-origin', cache:'no-store',
      headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:controller.signal });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error || 'Lajmërimi nuk u sinkronizua.'), { status: response.status });
    return data;
  } finally { clearTimeout(timer); }
}
export function recordReadyNotification({ orderId, channel, kind, attemptId }) {
  const worker = actor();
  if (!worker?.id) throw new Error('Hyr përsëri në aplikacion për të ruajtur lajmërimin.');
  if (!/^[1-9][0-9]*$/.test(String(orderId || '')) || !Number.isSafeInteger(Number(orderId))) throw new Error('Porosia nuk ka ID zyrtare.');
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
  if (running || navigator.onLine === false) return;
  running = true;
  try {
    const worker = actor();
    for (const event of localNotifications().filter(e => e.pending && !e.blocked)) {
      if (actor()?.id !== worker?.id) break;
      if (read().find(e => e.id === event.id)?.blocked) continue;
      try {
        const result = await request({ ...event, action:'ADD_READY_NOTIFICATION' });
        write(mergeNotificationEvents(read(), [{ ...result.event, viewer_id: worker.id, pending: false }]));
      } catch (error) {
        const permanent = [400,404,409].includes(error.status) && error.message !== 'READY_NOTIFICATION_ATTEMPT_PENDING';
        write(read().map(e => e.attempt_id === event.attempt_id && e.pending ? { ...e, sync_error: String(error.message), blocked: permanent } : e));
        if (permanent) continue;
        break; // Ordered replay: an attestation never overtakes its opened event.
      }
    }
  } catch {} finally { running = false; }
}
export async function fetchReadyNotifications(ids) {
  const worker = actor();
  if (!worker?.id || navigator.onLine === false) return { offline: true };
  const unique = [...new Set(ids.map(String))].filter(id => /^[1-9][0-9]*$/.test(id));
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
  window.addEventListener('storage',e => { if (e.key === KEY) { notify(); wake(); } });
  document.addEventListener('visibilitychange',() => { if (!document.hidden) wake(); });
  window.setInterval(wake,15000);
  wake();
}
