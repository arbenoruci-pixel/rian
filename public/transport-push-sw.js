/* Imported by the existing /vite-sw.js; never replaces offline caches. */
(() => {
  const uuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
  self.addEventListener('message', event => {
    if (event.data?.type === 'TEPIHA_PUSH_READY') event.ports?.[0]?.postMessage({ pushVersion: 1 });
  });
  self.addEventListener('push', event => {
    let data = {};
    try { data = event.data?.json() || {}; } catch {}
    const valid = data.version === 1 && uuid(data.eventId) && uuid(data.userId);
    event.waitUntil(self.registration.showNotification(valid ? data.title : 'TEPIHA', {
      body: valid ? data.body : 'Ke një njoftim të ri. Hape Transportin.',
      icon: '/icon-192.png', badge: '/icon-192.png',
      tag: valid ? `tepiha-${data.eventId}` : 'tepiha-update', renotify: false,
      data: valid ? { orderId: uuid(data.orderId) ? data.orderId : null, userId: data.userId } : {},
    }));
  });
  self.addEventListener('notificationclick', event => {
    event.notification.close();
    const data = event.notification.data || {};
    const query = uuid(data.orderId) && uuid(data.userId)
      ? `?push_order=${encodeURIComponent(data.orderId)}&push_user=${encodeURIComponent(data.userId)}` : '';
    const target = new URL('/transport/board' + query, self.location.origin).href;
    event.waitUntil((async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Do not navigate an unrelated screen containing an unsaved draft.
      const board = windows.find(w => new URL(w.url).origin === self.location.origin
        && new URL(w.url).pathname === '/transport/board');
      if (board?.navigate) { const client = await board.navigate(target); if (client) return client.focus(); }
      return self.clients.openWindow(target);
    })());
  });
})();
