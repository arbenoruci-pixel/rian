// lib/offlineSyncClient.js
// Harmonized & Safe Sync Client (No data loss + Anti-Ghosting)

import { getPendingOps, deleteOp, pushOp, removeOrderLocal } from "@/lib/offlineStore";
import { supabase } from "@/lib/supabaseClient";

// 🔥 AUTO-BLACKLIST HELPER: E varrosim fantazmën lokalish sapo të kalojë në server
function banishGhost(localId) {
  if (typeof window === 'undefined' || !localId) return;
  if (String(localId).match(/^[0-9]+$/)) return; // Mos blloko ID-të e vërteta nga DB
  try {
    const bl = JSON.parse(window.localStorage.getItem('tepiha_ghost_blacklist') || '[]');
    if (!bl.includes(String(localId))) {
      bl.push(String(localId));
      window.localStorage.setItem('tepiha_ghost_blacklist', JSON.stringify(bl));
    }
  } catch(e) {}
}

async function ping() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    // Ping i sigurt qe nuk bllokohet nga RLS e tabelave
    const { error } = await supabase.auth.getSession();
    return !error;
  } catch {
    return false;
  }
}

export async function queueOp(type, payload) {
  const op = {
    op_id: (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `op_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type,
    payload,
    created_at: new Date().toISOString(),
  };
  await pushOp(op);
  return op.op_id;
}

export async function trySyncPendingOps() {
  const ok = await ping();
  if (!ok) return { ok: false, reason: "OFFLINE" };

  let ops = [];
  try {
    ops = await getPendingOps();
  } catch {
    ops = [];
  }

  if (!Array.isArray(ops) || ops.length === 0) return { ok: true, synced: 0 };

  // I rendisim sipas kohes (me te vjetrat te parat)
  ops.sort((a, b) => String(a?.created_at || "").localeCompare(String(b?.created_at || "")));

  let syncedCount = 0;
  for (const op of ops) {
    try {
      const normalized = {
        ...op,
        type: op?.type || op?.op_type || op?.opType,
      };

      const r = await fetch("/api/offline-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(normalized),
      });

      const j = await r.json().catch(() => ({}));
      
      if (j && j.ok) {
        // ✅ U RUAJT ME SUKSES NE SERVER
        if (j.localId) {
          try {
            // 1. Shënojmë si të sinkronizuar
            await removeOrderLocal(j.localId);
            // 2. 🔥 E fshehim nga UI menjëherë që të mos shfaqet "ghost"
            banishGhost(j.localId);
          } catch {}
        }
        // Fshijme operacionin nga radha e sinkronizimit
        await deleteOp(op.op_id);
        syncedCount += 1;
      } else {
        // ❌ GABIM SERVERI (Konflikt kodi, etj)
        // MODIFIKIMI KRITIK: Nuk e fshijme operacionin! E lejme ne telefon.
        console.warn("[SyncClient] Serveri refuzoi sinkronizimin:", op.op_id, j?.error);
        
        // Nese eshte nje gabim specifik qe tregon se porosia ekziston, mund ta fshijme
        if (j?.existed) {
             await deleteOp(op.op_id);
             if (j.localId) banishGhost(j.localId); // E varrosim nëse konfirmohet që qenka lart
        } else {
            // Per cdo gabim tjeter (kodi bosh, etj), e ndalim sinkronizimin 
            // qe te mos vazhdoje me te tjerat pa e zgjidhur kete
            break; 
        }
      }
    } catch (err) {
      // Gabim rrjeti - ndalojme procesin per t'u rikthyer me vone
      console.error("[SyncClient] Network error:", err);
      break;
    }
  }

  return { ok: true, synced: syncedCount };
}
