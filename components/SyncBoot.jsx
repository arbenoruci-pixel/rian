'use client';

import { useEffect } from 'react';
import { getAllOrdersLocal, getMeta, setMeta } from '@/lib/offlineStore';
import { trySyncPendingOps } from '@/lib/offlineSyncClient';
import { runSync } from '@/lib/syncEngine';

// Background sync: pushes offline changes to Supabase and keeps local cache fresh.
export default function SyncBoot() {
  useEffect(() => {
    let alive = true;

    const bootstrapUpload = async () => {
      // One-time best-effort: if you had orders only in Safari local DB, push them to Supabase.
      // This is what makes Chrome/other users see them.
      try {
        const done = await getMeta('bootstrap_uploaded_v1');
        if (done) return;

        const orders = await getAllOrdersLocal().catch(() => []);
        if (!Array.isArray(orders) || orders.length === 0) {
          await setMeta('bootstrap_uploaded_v1', true);
          return;
        }

        // Upload oldest-first to reduce duplicates.
        const sorted = [...orders].sort((a,b)=>String(a?.created_at||'').localeCompare(String(b?.created_at||'')));

        let sent = 0;
        for (const order of sorted) {
          // Require a numeric code; skip drafts without code.
          const codeRaw = order?.code ?? order?.code_n ?? order?.client?.code;
          const digits = String(codeRaw ?? '').replace(/\D+/g,'').replace(/^0+/,'');
          if (!digits) continue;

          try {
            const r = await fetch('/api/offline-sync', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'offline_pranimi', payload: { order } }),
            });
            const j = await r.json().catch(() => ({}));
            if (j?.ok) sent += 1;
          } catch {}
        }

        // Mark done even if partial; reruns can create duplicates.
        await setMeta('bootstrap_uploaded_v1', { ok: true, sent, at: Date.now() });
      } catch {}
    };


    const tick = async () => {
      if (!alive) return;
      try { await trySyncPendingOps(); } catch {}
      try { await runSync(); } catch {}
    };

    bootstrapUpload();
    tick();
    const id = setInterval(tick, 8000);

    const onOnline = () => tick();
    try { window.addEventListener('online', onOnline); } catch {}

    return () => {
      alive = false;
      clearInterval(id);
      try { window.removeEventListener('online', onOnline); } catch {}
    };
  }, []);

  return null;
}