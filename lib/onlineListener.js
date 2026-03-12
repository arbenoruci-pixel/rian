// lib/onlineListener.js
// MASTER SYNC CONTROLLER

import { runSync } from './syncEngine';
import { autoSyncOrders } from './offlineSync';

export function setupOnlineListeners() {
  if (typeof window === 'undefined') return;

  window.addEventListener('online', async () => {
    console.log('🌐 Interneti u kthye! Duke nisur sinkronizimin e harmonizuar...');
    
    // 1. Lajmërojmë pjesët e tjera të UI (opsionale)
    window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'));

    // 2. Nisim motorin e ri (SyncEngine) - Ky merret me radhën e re IndexedDB
    try {
      await runSync({ auto: true });
    } catch (e) {
      console.warn('[OnlineListener] SyncEngine failed', e);
    }

    // 3. Nisim motorin e vjetër (AutoSync) - Ky merret me radhën e vjetër localStorage
    try {
      await autoSyncOrders();
    } catch (e) {
      console.warn('[OnlineListener] Legacy AutoSync failed', e);
    }
  });
}

// Aktivizimi i menjëhershëm
if (typeof window !== 'undefined') {
  setupOnlineListeners();
}
