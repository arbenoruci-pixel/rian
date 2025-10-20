/* /assets/pranimi.save.hotfix.js — robust save (duplicate-code retry + photo uploads)
   - No HTML/CSS changes
   - Works with your existing supabase.js helpers: rpc/insert/update/select
   - Uses your ensureCode() if present (and locked in edit mode)
*/

(function(){
  /* ---------- tiny utils ---------- */
  function $(s,r){ return (r||document).querySelector(s); }
  function num(v){ var n=parseFloat(String(v==null?'':v).replace(',','.')); return isFinite(n)?n:0; }
  function digits(v){ return String(v==null?'':v).replace(/\D/g,''); }
  function nowISO(){ return new Date().toISOString(); }
  async function waitReady(){
    const until=Date.now()+8000;
    while(!(window.rpc&&window.insert&&window.update)){
      if(Date.now()>until) throw new Error('Supabase helpers not ready');
      await new Promise(r=>setTimeout(r,40));
    }
  }

  /* ---------- code helpers ---------- */
  async function getCodeOnce(){
    // Respect edit lock if your main script set ensureCode()
    if (typeof window.ensureCode==='function'){
      const c = await window.ensureCode();
      if (c) return String(c);
    }
    // RPC fallback
    const r = await window.rpc('next_code_num', {});
    let code = r;
    if (Array.isArray(r)){
      const it=r[0]; code=(it&&typeof it==='object')?(it.next_code||it.code||it.id):it;
    } else if (r && typeof r==='object'){
      code = r.next_code || r.code || r.id;
    }
    return digits(code);
  }
  function setBadge(code){
    var b = $('#ticketCode') || document.querySelector('.badge.kodi');
    if (b){ b.dataset.code = code; b.textContent = 'KODI: '+code; }
    window.assignedCode = code;
  }

  /* ---------- totals / items / snapshot from current DOM ---------- */
  function recalcTotalsSafe(){
    try{ return (typeof window.recalcTotals==='function') ? window.recalcTotals() : {m2:0,pieces:0,price_general:0,price_stairs:0,euro_total:0}; }
    catch(_){ return {m2:0,pieces:0,price_general:0,price_stairs:0,euro_total:0}; }
  }
  function readRowPhoto(row){
    const img=row && row.querySelector && row.querySelector('img.thumb');
    return (img && img.src && img.style.display!=='none') ? img.src : null;
  }
  function collectItems(order_id, now){
    const items=[]; const general=(window.__TOTALS__&&window.__TOTALS__.price_general)||0;

    document.querySelectorAll('#list-tepiha .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')&&row.querySelector('.m2').value);
      if(v>0) items.push({ order_id, kind:'tepiha', m2:v, price:general, created_at:now });
    });
    document.querySelectorAll('#list-staza .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')&&row.querySelector('.m2').value);
      if(v>0) items.push({ order_id, kind:'staza', m2:v, price:general, created_at:now });
    });

    // stairs (qty * per)
    const qty = Number((document.querySelector('#stairsQty')||{}).value||0);
    const per = Number((document.querySelector('#stairsPer')||{}).value||0.3) || 0.3;
    const stM2 = Math.max(0, qty*per);
    const stPrice = (window.__TOTALS__&&window.__TOTALS__.price_stairs!=null) ? window.__TOTALS__.price_stairs : general;
    if(stM2>0) items.push({ order_id, kind:'shkallore', m2:stM2, price:stPrice, created_at:now });

    return items;
  }
  function collectSnapshot(){
    const snap=[];

    document.querySelectorAll('#list-tepiha .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')&&row.querySelector('.m2').value);
      const ph=readRowPhoto(row);
      if(v>0 || ph) snap.push({ kind:'tepiha', m2:v||0, photo:ph||null });
    });
    document.querySelectorAll('#list-staza .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')&&row.querySelector('.m2').value);
      const ph=readRowPhoto(row);
      if(v>0 || ph) snap.push({ kind:'staza', m2:v||0, photo:ph||null });
    });

    try{
      const stairsPhoto = sessionStorage.getItem('stairs_photo_thumb')||null;
      const qty = Number((document.querySelector('#stairsQty')||{}).value||0);
      const per = Number((document.querySelector('#stairsPer')||{}).value||0.3) || 0.3;
      const sm2 = Math.max(0, qty*per);
      if(sm2>0 || stairsPhoto) snap.push({ kind:'shkallore', m2:sm2||0, photo:stairsPhoto });
    }catch(_){}

    return snap;
  }

  /* ---------- storage uploads (public URL) ---------- */
  var PHOTO_BUCKETS=['tapija-photos','tepiha-photos'];
  var PHOTO_BUCKET=PHOTO_BUCKETS[0];

  async function uploadREST(orderId, dataURI){
    try{
      if(!dataURI || !dataURI.startsWith('data:')) return null;
      const m=dataURI.match(/^data:(image\/[\w.+-]+);base64,/);
      const mime=m?m[1]:'image/jpeg';
      const base64=dataURI.split(',')[1]||'';
      const bytes=Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
      const ext=(mime.split('/')[1]||'jpg').toLowerCase();
      const path=orderId+'/'+Date.now()+'.'+ext;

      const url=(window.SUPABASE_URL||'')+'/storage/v1/object/'+PHOTO_BUCKET+'/'+encodeURIComponent(path);
      const r=await fetch(url,{
        method:'PUT',
        headers:{apikey:window.SUPABASE_ANON,Authorization:'Bearer '+window.SUPABASE_ANON,'Content-Type':mime},
        body:bytes
      });
      if(!r.ok) return null;
      return (window.SUPABASE_URL||'')+'/storage/v1/object/public/'+PHOTO_BUCKET+'/'+encodeURIComponent(path);
    }catch(_){ return null; }
  }
  async function uploadClient(orderId, dataURI){
    const sb=window.supabase; if(!sb||!sb.storage) return null;
    try{
      const m=dataURI.match(/^data:(image\/[\w.+-]+);base64,/);
      const mime=m?m[1]:'image/jpeg';
      const base64=dataURI.split(',')[1]||'';
      const bytes=Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
      const ext=(mime.split('/')[1]||'jpg').toLowerCase();
      const path=orderId+'/'+Date.now()+'.'+ext;

      const up=await sb.storage.from(PHOTO_BUCKET).upload(path, bytes, {contentType:mime, upsert:true});
      if(up&&up.error) return null;
      const pub=sb.storage.from(PHOTO_BUCKET).getPublicUrl(path);
      return (pub&&pub.data&&pub.data.publicUrl) ? pub.data.publicUrl : null;
    }catch(_){ return null; }
  }
  async function toUrlSnapshot(orderId, snap){
    const out=[];
    for (const s of (snap||[])){
      let url = s.photo || null;
      if(url && url.startsWith('data:')){
        url = await uploadREST(orderId, url) || await uploadClient(orderId, s.photo) || null;
      }
      if(!url) url = s.photo || null; // keep inline if upload blocked
      out.push({ kind:s.kind, m2:Number(s.m2||0), photo:url||null });
    }
    return out;
  }

  /* ---------- main save with duplicate-code retry ---------- */
  async function saveFixed(){
    await waitReady();

    const name  = ($('#name')&&$('#name').value||'').trim();
    const phone = ($('#phone')&&$('#phone').value||'').replace(/\D/g,'');
    if(!name){ alert('Shkruaj emrin'); return; }
    if(!phone){ alert('Shkruaj telefonin'); return; }

    // try once; on duplicate key regenerate code and retry once more
    for (let attempt=0; attempt<2; attempt++){
      const code = await getCodeOnce();
      setBadge(code);

      const totals = recalcTotalsSafe();
      const now = nowISO();

      try{
        // 1) header
        const res = await insert('orders', {
          code, name, phone,
          price_per_m2:Number(totals.price_general||0),
          m2:Number(totals.m2||0),
          pieces:Number(totals.pieces||0),
          total:Number(totals.euro_total||0),
          status:'pastrim',
          created_at:now, updated_at:now
        });
        const row = Array.isArray(res) ? res[0] : res;
        const order_id = row && (row.id || row.order_id || row.uuid);
        if(!order_id) throw new Error('Order ID mungon');

        // 2) items
        const items = collectItems(order_id, now);
        if (items.length){ try{ await insert('order_items', items); }catch(_){ } }

        // 3) photos → URLs
        const snap = collectSnapshot();
        if (snap.length){
          const clean = await toUrlSnapshot(order_id, snap);
          try{ await update('orders', { snap_items: clean, updated_at: nowISO() }, { id: order_id }); }catch(_){}
        }

        // 4) clear session & redirect
        try{ sessionStorage.removeItem('client_photo_thumb'); sessionStorage.removeItem('stairs_photo_thumb'); }catch(_){}
        location.href = '/pastrimi/';
        return;
      }catch(err){
        const msg = (err && (err.message||err))+'';
        const isDup = /23505|duplicate key|orders_code_key|unique/i.test(msg);
        if (attempt===0 && isDup){
          // regenerate code and retry once
          try{
            window.assignedCode = null;
            const fresh = await getCodeOnce();
            setBadge(fresh);
            continue;
          }catch(e2){ alert('Gabim rifreskimi kodi'); throw e2; }
        }
        alert('Ruajtja dështoi:\n'+msg);
        throw err;
      }
    }
  }

  /* ---------- wire buttons (no design changes) ---------- */
  window.save = saveFixed;
  document.addEventListener('DOMContentLoaded', function(){
    var cont = $('#btnContinue');   if(cont) cont.onclick = function(e){ e.preventDefault(); saveFixed(); };
    var ruaj = $('#btnSaveDraft');  if(ruaj) ruaj.onclick  = function(e){ e.preventDefault(); saveFixed(); };
  });
})();