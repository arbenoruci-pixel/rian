// lib/offlineSync.js
// AUTO SYNC LOCAL → DB (PERMANENT)

import { supabase } from '@/lib/supabaseClient';
import { saveOrderToDb } from '@/lib/ordersDb';

function isOnline() {
  try { return navigator.onLine !== false; } catch { return true; }
}

function getOfflineQueue() {
  try {
    const raw = localStorage.getItem('tepiha_offline_queue_v1');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function setOfflineQueue(arr) {
  try {
    localStorage.setItem('tepiha_offline_queue_v1', JSON.stringify(arr || []));
  } catch {}
}

export async function autoSyncOrders() {
  if (!isOnline()) return;

  const queue = getOfflineQueue();
  if (!queue.length) return;

  const remaining = [];

  for (const item of queue) {
    const payload = item?.payload || item;
    try {
      await saveOrderToDb(payload, 'AUTO_SYNC');
    } catch (e) {
      console.warn('SYNC FAILED', payload?.code, e?.message);
      remaining.push(item);
    }
  }

  setOfflineQueue(remaining);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    autoSyncOrders();
  });

  setTimeout(() => {
    autoSyncOrders();
  }, 2000);
}
