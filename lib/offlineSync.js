// lib/offlineSync.js
// Deprecated facade kept for backwards compatibility.

import { scheduleRunSync } from './syncEngine';

export async function autoSyncOrders() {
  return await scheduleRunSync({ source: 'offlineSync', delayMs: 300 });
}
