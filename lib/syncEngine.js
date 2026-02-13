
import { getPendingOps, setMeta } from "./offlineStore";

let syncing=false;

export async function runSync(){
  if(syncing) return;
  if(typeof navigator !== "undefined" && !navigator.onLine) return;
  syncing=true;
  try{
    const ops = await getPendingOps();
    for(const op of ops){
      try{
        await fetch("/api/offline-sync",{
          method:"POST",
          headers:{ "Content-Type":"application/json"},
          body:JSON.stringify(op)
        });
      }catch(e){
        console.warn("Sync fail",e);
      }
    }
    await setMeta("last_sync_at", Date.now());
  }finally{
    syncing=false;
  }
}
