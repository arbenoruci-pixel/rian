// /assets/archive.js — archive/restore helpers (Supabase ONLY)
import { select, update } from '/assets/supabase.js';

export async function archiveOrder(id) {
  // Requires orders.archived boolean column in DB
  await update('orders', { archived: true, updated_at: new Date().toISOString() }, { id });
}

export async function restoreOrder(id) {
  await update('orders', { archived: false, updated_at: new Date().toISOString() }, { id });
}

export async function isArchivedRow(row) {
  return !!row?.archived;
}

export async function listArchived() {
  // Prefer server-filtered results
  const rows = await select('orders', { select:'*', archived:'eq.true', order:'picked_at.desc' });
  return rows || [];
}

// ---- window shim for inline pages ----
try {
  if (typeof window !== 'undefined' && !window.__ARCHIVE_SHIM__) {
    window.__ARCHIVE_SHIM__ = true;
    const api = { archiveOrder, restoreOrder, listArchived, isArchivedRow };
    for (const [k,v] of Object.entries(api)) {
      if (!(k in window)) window[k] = v;
    }
  }
} catch {}
