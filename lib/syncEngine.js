// lib/syncEngine.js
import { getPendingOps, deleteOp, setMeta } from "./offlineStore";

let syncing = false;

async function postOp(op){
  const r = await fetch("/api/offline-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(op),
  });
  if(!r.ok) throw new Error("offline-sync http " + r.status);
  const j = await r.json().catch(()=>({}));
  if(j && j.ok === false) throw new Error(j.error || "offline-sync failed");
  return j;
}

export async function runSync(){
  if(syncing) return;
  if(typeof navigator !== "undefined" && !navigator.onLine) return;

  syncing = true;
  try{
    const ops = await getPendingOps();
    // FIFO order
    ops.sort((a,b)=>(a.created_at||0)-(b.created_at||0));

    for(const op of ops){
      try{
        await postOp(op);
        await deleteOp(op.op_id);
      }catch(e){
        // keep op, retry later
        console.warn("[SYNC] op failed, will retry", op?.type, e?.message || e);
        break; // stop pushing to avoid re-ordering issues
      }
    }

    // Pull updates (optional). If you implement /api/offline-sync?pull=1 you can fetch changed orders.
    await setMeta("last_sync_at", Date.now());
  } finally{
    syncing = false;
  }
}
