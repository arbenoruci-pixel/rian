import { createDispatchOutbox, DISPATCH_OUTBOX_KEY, DISPATCH_OUTBOX_ITEM_PREFIX } from './dispatchOutbox.js';
import { createDispatchCreateIntentJournal } from './dispatchCreateIntent.js';
import { getActor } from './actorSession.js';
import { insertTransportOrder } from './transport/transportDb.js';
import { createDispatchOutboxStorage } from './dispatchOutboxStorage.js';
import { reportDispatchDiagnostic } from './dispatchDiagnostics.js';

export const DISPATCH_OUTBOX_EVENT = 'tepiha:dispatch-outbox';
let outbox;
let installed = false;
const changed = () => window.dispatchEvent(new CustomEvent(DISPATCH_OUTBOX_EVENT));
export function getDispatchOutbox() {
  if (!outbox) outbox = createDispatchOutbox({
    storage: createDispatchOutboxStorage({ indexedDB: window.indexedDB, localStorage: window.localStorage }),
    getActorId: () => { const actor = getActor(); return actor?.id || actor?.user_id || ''; },
    online: () => navigator.onLine !== false,
    submit: insertTransportOrder,
    onChange: changed,
    onIssue: ({ code }) => reportDispatchDiagnostic('queue_issue', { code }),
    onCommitted: (item) => {
      createDispatchCreateIntentJournal().clear(item.id);
      window.dispatchEvent(new CustomEvent('tepiha:dispatch-order-committed', { detail: { id: item.id } }));
    },
  });
  return outbox;
}

export function wakeDispatchOutbox() {
  try {
    void getDispatchOutbox().drain().catch(() => {
      window.dispatchEvent(new CustomEvent('tepiha:dispatch-outbox-storage-error'));
    });
  } catch { window.dispatchEvent(new CustomEvent('tepiha:dispatch-outbox-storage-error')); }
}

export function installDispatchOutbox() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // Runs outside the Dispatch page, including after navigation and app resume.
  window.addEventListener('online', wakeDispatchOutbox);
  window.addEventListener('focus', wakeDispatchOutbox);
  window.addEventListener('tepiha:session-changed', () => { changed(); wakeDispatchOutbox(); });
  window.addEventListener('storage', (event) => {
    if (event.key === DISPATCH_OUTBOX_KEY || event.key?.startsWith(DISPATCH_OUTBOX_ITEM_PREFIX) || !event.key) changed();
    wakeDispatchOutbox();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeDispatchOutbox(); });
  window.setInterval(wakeDispatchOutbox, 2000);
  wakeDispatchOutbox();
}
