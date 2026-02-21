// lib/transportOfflineSync.js
// TEPIHA — Transport offline drafts → Supabase sync
// Keeps the existing transport draft storage key used by /app/transport/pranimi.

import { supabase } from '@/lib/supabaseClient';

const LS_KEY = 'transport_draft_orders_v1';

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function readDrafts() {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeDrafts(arr) {
  if (!isBrowser()) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(arr || [])); } catch {}
}

// Best-effort: push any transport drafts that already have a code into transport_orders.
// We intentionally do not invent codes here; /transport/pranimi remains the only place
// that assigns T-codes. We only sync what exists.
export async function syncTransportDraftsNow({ limit = 50 } = {}) {
  if (!isBrowser()) return { ok: true, synced: 0 };
  if (!navigator.onLine) return { ok: true, synced: 0 };

  const drafts = readDrafts();
  if (!drafts.length) return { ok: true, synced: 0 };

  let synced = 0;
  const keep = [];

  for (const d of drafts.slice(0, limit)) {
    try {
      const tcode = String(d?.tcode || d?.code || '').trim();
      // If draft has no T-code yet, keep it local.
      if (!tcode || !tcode.toUpperCase().startsWith('T')) {
        keep.push(d);
        continue;
      }

      // Shape expected by transport tables (best-effort, tolerant)
      const row = {
        client_tcode: tcode,
        status: d?.status || 'new',
        visit_nr: d?.visit_nr ?? d?.visitNr ?? null,
        data: d,
      };

      const { error } = await supabase
        .from('transport_orders')
        .upsert(row, { onConflict: 'client_tcode,visit_nr' });
      if (error) throw error;

      synced += 1;
    } catch {
      keep.push(d);
    }
  }

  // Keep any remaining drafts beyond limit
  if (drafts.length > limit) keep.push(...drafts.slice(limit));
  writeDrafts(keep);
  return { ok: true, synced };
}
