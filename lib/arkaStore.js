// lib/arkaStore.js
// Helper për të regjistruar pagesat në ARKA nga GATI / MARRJE SOT
// Kjo e lë derën hapur për punëtorë dhe transport më vonë.

import { supabase } from '@/lib/supabaseClient';
import { pushOp } from '@/lib/offlineStore';

const BUCKET = 'tepiha-photos';

// ruaje në localStorage që ARKA/page.jsx t'i lexojë njësoj
export function saveArkaLocal(rec) {
  if (typeof window === 'undefined') return;
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('arka_list_v1') || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  const idx = list.findIndex((r) => r.id === rec.id);
  if (idx >= 0) {
    list[idx] = rec;
  } else {
    list.unshift(rec);
  }
  list = list.slice(0, 500);
  localStorage.setItem('arka_list_v1', JSON.stringify(list));
}

// API për GATI / MARRJE SOT:
// thirre p.sh.
//   await addArkaRecordFromOrder(order, {
//     paid: paidAmount,
//     worker: 'Arben',
//     source: 'GATI',
//   });
export async function addArkaRecordFromOrder(order, meta = {}) {
  if (!order) return null;
  const now = Date.now();

  const rec = {
    id: meta.id || `arka_${order.id || now}`,
    orderId: order.id || null,
    code: order.client?.code || '',
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    paid: Number(meta.paid ?? order.pay?.paid ?? 0) || 0,
    ts: meta.ts || now,
    worker: meta.worker || null,
    source: meta.source || null,
  };

  // ruaje në Supabase
  if (supabase) {
    try {
      const path = `arka/${rec.id}.json`;
      const blob =
        typeof Blob !== 'undefined'
          ? new Blob([JSON.stringify(rec)], { type: 'application/json' })
          : null;
      if (blob) {
        await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
      }
    } catch (e) {
      console.error('Error uploading ARKA record to Supabase', e);
      // queue retry for when network returns
      try {
        await pushOp({
          op_id: `op_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          type: 'upload_storage',
          payload: {
            bucket: BUCKET,
            path: `arka/${rec.id}.json`,
            contentType: 'application/json',
            data: JSON.stringify(rec),
          },
          created_at: Date.now(),
        });
      } catch {}
    }
  }

  // ruaje në localStorage
  try {
    saveArkaLocal(rec);
  } catch (e) {
    console.error('Error saving ARKA record to localStorage', e);
  }

  return rec;
}