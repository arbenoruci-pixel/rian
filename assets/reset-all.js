/* ============================================================
   Tepiha • RESET-ALL (project-wide)  —  /assets/reset-all.js
   - Clears ALL local keys (v1 + v2) and resets counters
   - Deletes ALL orders/*.json in Supabase bucket
   - Calls Flow/TepihaAuto helpers if present
   - Can resequence client codes
   ============================================================ */
(function (global) {
  const CFG = {
    supabaseUrl:   "https://vnidjrxidvusulinozbn.supabase.co",
    supabaseAnon:  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZuaWRqcnhpZHZ1c3VsaW5vemJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1MTk0NjAsImV4cCI6MjA3MzA5NTQ2MH0.hzGSFKU3sKuUKBUBsTE0rKIerj2uhG9pGS8_K9N7tpA",
    bucket:        "tepiha-photos",
    // All folders that might contain order JSON files
    ordersPrefixes: ["orders", "orders.used", "used", "archive", "orders_archive"]
  };

  /* ---------- logging hook ---------- */
  const onlog = (msg, level="info")=>{
    try {
      const el = document.getElementById("resetLog");
      if (el) {
        const span = document.createElement("div");
        if(level==="ok") span.style.color = "#22c55e";
        if(level==="warn") span.style.color = "#f59e0b";
        if(level==="err") span.style.color = "#f87171";
        span.textContent = msg;
        el.appendChild(span); el.scrollTop = el.scrollHeight;
      }
      console.log("[RESET-ALL]", msg);
    } catch(_) {}
  };

  /* ---------- Local wipe ---------- */
  function clearLocalEverything() {
    // Best-effort: call helpers if present
    try { global.TepihaAuto?.hardResetLocal?.(); onlog("TepihaAuto.hardResetLocal() ✓","ok"); } catch(e){ onlog("TepihaAuto reset fail: "+e.message,"err"); }
    try { global.Flow?.resetAll?.(); onlog("Flow.resetAll() ✓","ok"); } catch(e){ /* Flow may not exist */ }

    // Known keys (v1 + v2)
    const known = new Set([
      "orders_v1","clients_v1","arka_v1","clients_seq_v1",
      "orders_v2","clients_v2","app_meta_v5","next_code",
      "order_list_v1","orders_v1_draft"
    ]);
    // Brutal sweep of patterns we used historically
    const keys = Object.keys(localStorage);
    for(const k of keys){
      if (known.has(k) ||
          k.startsWith("order_") || k.startsWith("orders_") || k.startsWith("orderlist_") ||
          k.startsWith("client_") || k.startsWith("photo_client_") ||
          k.startsWith("legacy_") || k.startsWith("cache_") || k.startsWith("Xcode_")) {
        localStorage.removeItem(k);
      }
    }
    // Also clear everything to be sure, then re-seed minimal meta
    localStorage.clear();
    try {
      // If your new store exists, make sure the dash counter is -1 after reset
      const meta = { version: "reset-all", migrated: false, nextDash: -1, lastClean: Date.now() };
      localStorage.setItem("app_meta_v5", JSON.stringify(meta));
    } catch(_) {}

    onlog("LocalStorage cleared & counters reset ✓","ok");
  }

  /* ---------- Service worker/cache wipe ---------- */
  async function nukeSWCaches() {
    try {
      const regs = await (navigator.serviceWorker?.getRegistrations?.() || []);
      for (const r of regs) await r.unregister();
      const names = await (caches?.keys?.() || []);
      for (const n of names) await caches.delete(n);
      onlog("Service Worker + caches cleared ✓","ok");
    } catch(e){ onlog("SW/cache clear failed: "+e.message,"warn"); }
  }

  /* ---------- Supabase (cloud) ---------- */
  async function sbClient() {
    if (!("supabase" in global)) {
      await new Promise((res, rej)=>{
        const s=document.createElement("script");
        s.src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
        s.onload=res; s.onerror=()=>rej(new Error("Supabase CDN load failed"));
        document.head.appendChild(s);
      });
      onlog("Supabase JS loaded ✓","ok");
    }
    return global.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnon);
  }

  async function listOrderFiles(sb) {
    let files = [];
    for (const prefix of CFG.ordersPrefixes) {
      let page=0, limit=1000, batch;
      try{
        do{
          const {data, error} = await sb.storage.from(CFG.bucket)
            .list(prefix, {limit, offset:page*limit, sortBy:{column:"name", order:"asc"}});
          if (error) { onlog(`List ${prefix}: ${error.message}`, "warn"); break; }
          const rows = (data||[]).filter(f=>/\.json$/i.test(f.name)).map(f=> `${prefix}/${f.name}`);
          files = files.concat(rows);
          batch = data;
          page++;
        } while (batch && batch.length===limit);
      }catch(e){
        onlog(`List ${prefix} exception: ${e.message}`, "warn");
      }
    }
    return files;
  }

  async function deleteFiles(sb, paths) {
    let del=0, fail=0;
    for (let i=0;i<paths.length;i+=100){
      const slice = paths.slice(i,i+100);
      const { error } = await sb.storage.from(CFG.bucket).remove(slice);
      if (error){ fail+=slice.length; onlog("Delete error: "+error.message,"err"); }
      else { del+=slice.length; onlog(`Deleted ${del}/${paths.length}`,"ok"); }
    }
    return {del, fail};
  }

  async function testDelete(sb){
    const probe = `orders/__probe_${Date.now()}.json`;
    const blob = new Blob([JSON.stringify({probe:true,ts:Date.now()})], {type:"application/json"});
    const up = await sb.storage.from(CFG.bucket).upload(probe, blob, {upsert:true, contentType:"application/json"});
    if (up.error) { onlog("TEST upload failed: "+up.error.message, "err"); return false; }
    const rm = await sb.storage.from(CFG.bucket).remove([probe]);
    if (rm.error) { onlog("TEST delete failed (policy?): "+rm.error.message, "err"); return false; }
    onlog("TEST delete OK — anon key can delete ✓", "ok");
    return true;
  }

  /* ---------- Public API ---------- */
  const ResetAll = {
    info: ()=>({ url: CFG.supabaseUrl, bucket: CFG.bucket, prefixes: CFG.ordersPrefixes.slice() }),

    async localOnly(){
      clearLocalEverything();
      await nukeSWCaches();
      return true;
    },

    async cloudAndLocal(){
      const sb = await sbClient();
      const canDel = await testDelete(sb);
      const files = await listOrderFiles(sb);
      onlog(`Found ${files.length} cloud file(s)`, files.length? "ok":"warn");
      if (canDel && files.length){
        await deleteFiles(sb, files);
      }
      clearLocalEverything();
      await nukeSWCaches();
      return true;
    },

    /** Optional: resequence clients to 001,002… and sync orders */
    resequenceClients({start=1, width=3}={}){
      try{
        if (global.FlowClients?.resequence) {
          const res = global.FlowClients.resequence({start, width});
          onlog(`Resequenced clients: ${res.clients} (next ${res.next})`,"ok");
          return res;
        }
        if (global.TepihaAuto?.resequenceClientCodes){
          const res = global.TepihaAuto.resequenceClientCodes({start, width, prefix:''});
          onlog(`Resequenced via TepihaAuto: ${res.clients} (next ${res.first}..${res.last})`,"ok");
          return res;
        }
        onlog("No resequence function exposed (FlowClients/TepihaAuto)","warn");
        return null;
      }catch(e){
        onlog("Resequence error: "+e.message,"err");
        return null;
      }
    }
  };

  global.TepihaResetAll = ResetAll;
  onlog("RESET-ALL ready ✓","ok");
})(window);