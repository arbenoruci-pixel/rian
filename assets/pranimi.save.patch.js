// /assets/pranimi.save.patch.js
// Save with (1) code hard-lock on edit, (2) 3-tier photo pipeline, (3) prev-photo fallback not to lose images.

(function () {
  // Buckets to try (first one wins)
  const BUCKETS = ['tapija-photos', 'tepiha-photos'];

  // --- small utils ---
  function $(s,r){ return (r||document).querySelector(s) }
  function $all(s,r){ return Array.from((r||document).querySelectorAll(s)) }
  function num(v){ const n=parseFloat(String(v??'').replace(',','.')); return isFinite(n)?n:0 }
  function nowISO(){ return new Date().toISOString() }
  function getPrice(){ try{ return Number(localStorage.getItem('price_per_m2')||0) }catch{ return 0 } }
  function digits(v){ return String(v==null?'':v).replace(/\D/g,'') }
  function qs(name){ const m=(location.search||'').match(new RegExp('[?&]'+name+'=([^&]+)')); return m?decodeURIComponent(m[1].replace(/\+/g,' ')):null }

  async function waitEnv(){
    const until = Date.now()+8000;
    while(!(window.rpc && window.insert && window.update && window.select && window.SUPABASE_URL && window.SUPABASE_ANON)){
      if(Date.now()>until) break; await new Promise(r=>setTimeout(r,40));
    }
  }

  // ---- totals ----
  function stairsM2(){ const q = Number(document.querySelector('#stairsQty')?.value || 0); return Math.max(0,q)*0.3; }
  function sumKind(kind){
    let m2=0,pieces=0;
    $all('#list-'+kind+' .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')?.value);
      if(v>0){ m2+=v; pieces++; }
    });
    return { m2, pieces };
  }
  function totals(){
    const t=sumKind('tepiha'), s=sumKind('staza'), stair=stairsM2(), p=getPrice();
    const m2 = t.m2 + s.m2 + stair;
    const pieces = t.pieces + s.pieces + (stair>0?1:0);
    return { price_per_m2:p, m2, pieces, total: m2*p };
  }

  // ---- collect snapshot from UI ----
  function readThumb(row){ try{ const img=row?.querySelector?.('img.thumb'); return (img && img.src && img.style.display!=='none') ? img.src : null; }catch{ return null } }
  function collectSnapshot(){
    const snap=[];
    $all('#list-tepiha .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')?.value); const ph=readThumb(row);
      if(v>0 || ph) snap.push({ kind:'tepiha', m2:v||0, photo:ph||null });
    });
    $all('#list-staza .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')?.value); const ph=readThumb(row);
      if(v>0 || ph) snap.push({ kind:'staza', m2:v||0, photo:ph||null });
    });
    const stairQty = Number(document.querySelector('#stairsQty')?.value || 0);
    const stairsM = stairQty*0.3;
    let stairsPhoto=null; try{ stairsPhoto = sessionStorage.getItem('stairs_photo_thumb') || null; }catch{}
    if(stairsM>0 || stairsPhoto) snap.push({ kind:'shkallore', m2:stairsM||0, photo:stairsPhoto||null });
    return snap;
  }

  // ---- order_items rebuild ----
  function collectItems(order_id, now){
    const p=getPrice(); const items=[];
    $all('#list-tepiha .piece-row').forEach(row=>{ const v=num(row.querySelector('.m2')?.value); if(v>0) items.push({ order_id, kind:'tepiha', m2:v, price:p, created_at:now }); });
    $all('#list-staza .piece-row').forEach(row=>{ const v=num(row.querySelector('.m2')?.value); if(v>0) items.push({ order_id, kind:'staza', m2:v, price:p, created_at:now }); });
    const m=stairsM2(); if(m>0) items.push({ order_id, kind:'shkallore', m2:m, price:p, created_at:now });
    return items;
  }
  async function delOrderItems(orderId){
    const url = `${window.SUPABASE_URL}/rest/v1/order_items?order_id=eq.${encodeURIComponent(orderId)}`;
    const headers = { apikey: window.SUPABASE_ANON, Authorization: `Bearer ${window.SUPABASE_ANON}` };
    const r = await fetch(url, { method:'DELETE', headers });
    if(!r.ok){ throw new Error(await r.text() || r.status); }
  }

  // ---- bucket + photo upload (3-tier) ----
  let SELECTED_BUCKET=null;
  function chooseBucket(){ SELECTED_BUCKET = SELECTED_BUCKET || BUCKETS[0]; return SELECTED_BUCKET; }

  // Tier A — REST public upload
  async function uploadREST(orderId, dataURI){
    try{
      const bucket = chooseBucket();
      const m = dataURI.match(/^data:(image\/[A-Za-z0-9+.\-]+);base64,/);
      const mime = m ? m[1] : 'image/jpeg';
      const base64 = dataURI.split(',')[1] || '';
      const bytes = Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
      const ext = (mime.split('/')[1]||'jpg').toLowerCase();
      const path = `${orderId}/${Date.now()}.${ext}`;
      const url = `${window.SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURIComponent(path)}`;
      const headers = { apikey: window.SUPABASE_ANON, Authorization:`Bearer ${window.SUPABASE_ANON}`, 'Content-Type': mime };
      const resp = await fetch(url, { method:'PUT', headers, body: bytes });
      if(!resp.ok) return null;
      return `${window.SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`;
    }catch{ return null }
  }
  // Tier B — client SDK
  async function uploadClient(orderId, dataURI){
    if(!window.supabase?.storage) return null;
    try{
      const m = dataURI.match(/^data:(image\/[A-Za-z0-9+.\-]+);base64,/);
      const mime = m ? m[1] : 'image/jpeg';
      const base64 = dataURI.split(',')[1] || '';
      const bytes = Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
      const ext = (mime.split('/')[1]||'jpg').toLowerCase();
      const path = `${orderId}/${Date.now()}.${ext}`;
      const bucket = chooseBucket();
      const { error } = await window.supabase.storage.from(bucket).upload(path, bytes, { contentType: mime });
      if(error) return null;
      return `${window.SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`;
    }catch{ return null }
  }

  // map UI snapshot -> URLs; keep previous URLs on edit if upload fails
  function normKind(k){ k=String(k||'').toLowerCase(); if(/staz/.test(k)) return 'staza'; if(/shk|stair/.test(k)) return 'shkallore'; return 'tepiha'; }
  function previousUrlFor(kind, index){
    const prev = Array.isArray(window.prevSnap) ? window.prevSnap : [];
    // pick nth of same kind
    let seen=0;
    for(const s of prev){
      if(normKind(s.kind)===kind){
        if(seen===index) return s.photo || s.photo_url || null;
        seen++;
      }
    }
    return null;
  }

  async function toUrlSnapshot(orderId, snap, isEdit){
    const out=[]; const byKindIndex={tepiha:0, staza:0, shkallore:0};
    for(const s of (snap||[])){
      const kind = normKind(s.kind);
      const idx = byKindIndex[kind]++; // stable index within that kind
      let url = s.photo || null;
      if(url && url.startsWith('data:')){
        url = await uploadREST(orderId, url) || await uploadClient(orderId, s.photo) || null;
      }
      if(!url && isEdit){
        // fallback: keep previous URL so photo doesn't disappear
        url = previousUrlFor(kind, idx);
      }
      out.push({ kind, m2:Number(s.m2||0), photo:url||null });
    }
    return out;
  }

  // ---- ensure code (create only) ----
  async function ensureCode(){
    if(window.assignedCode) return String(window.assignedCode);
    const r = await window.rpc('next_code_num', {});
    let code = r;
    if(Array.isArray(r)){ const it=r[0]; code=(it&&typeof it==='object')?(it.next_code||it.code||it.id):it; }
    else if(r && typeof r==='object'){ code = r.next_code || r.code || r.id; }
    window.assignedCode = String(code).replace(/\D/g,'');
    const b = document.querySelector('#ticketCode') || document.querySelector('.badge.kodi');
    if(b){ b.dataset.code=window.assignedCode; b.textContent='KODI: '+window.assignedCode; }
    return window.assignedCode;
  }

  // ================== SAVE ==================
  window.save = async function save(){
    await waitEnv();

    const name  = ($('#name')?.value||'').trim();
    const phone = ($('#phone')?.value||'').replace(/\D/g,'');
    if(!name)  throw new Error('Shkruaj emrin');
    if(!phone) throw new Error('Shkruaj telefonin');

    const t = totals();
    const now = nowISO();

    // Detect edit and lock code immediately
    const isEdit = Boolean(window.pranimiMode==='edit' || window.currentOrderId || qs('id') || qs('code'));
    if(isEdit){
      // LOCK: use badge/assignedCode/url code, never regenerate
      const badge = document.querySelector('#ticketCode') || document.querySelector('.badge.kodi');
      const badgeCode = (badge && badge.dataset && badge.dataset.code) ? String(badge.dataset.code) : '';
      if(badgeCode) window.assignedCode = badgeCode;
    }

    // ---------- EDIT MODE ----------
    if(isEdit && window.currentOrderId){
      const code = String(window.assignedCode||'');
      if(!code) throw new Error('Kodi mungon (edit)');

      await window.update('orders', {
        code, name, phone,
        price_per_m2: Number(t.price_per_m2||0),
        m2: Number(t.m2||0), pieces:Number(t.pieces||0), total:Number(t.total||0),
        status:'pastrim', updated_at: now
      }, { id: window.currentOrderId });

      try{ await delOrderItems(window.currentOrderId); }catch(e){ console.warn('delete items failed', e); }
      const items = collectItems(window.currentOrderId, now);
      if(items.length) await window.insert('order_items', items);

      const snap = collectSnapshot();
      const clean = await toUrlSnapshot(window.currentOrderId, snap, /*isEdit*/true);
      if(clean.length) await window.update('orders', { snap_items: clean, updated_at: nowISO() }, { id: window.currentOrderId });

      try{ sessionStorage.removeItem('client_photo_thumb'); sessionStorage.removeItem('stairs_photo_thumb'); }catch(_){}
      location.href = '/pastrimi/';
      return;
    }

    // ---------- CREATE MODE ----------
    for(let attempt=0; attempt<2; attempt++){
      const code = await ensureCode();
      try{
        const head = await window.insert('orders', {
          code, name, phone,
          price_per_m2: Number(t.price_per_m2||0),
          m2: Number(t.m2||0), pieces:Number(t.pieces||0), total:Number(t.total||0),
          status:'pastrim', created_at: now, updated_at: now
        });
        const row = Array.isArray(head)? head[0] : head;
        const order_id = row && (row.id || row.order_id || row.uuid);
        if(!order_id) throw new Error('Order ID mungon');

        const items = collectItems(order_id, now);
        if(items.length) await window.insert('order_items', items);

        const snap = collectSnapshot();
        const clean = await toUrlSnapshot(order_id, snap, /*isEdit*/false);
        if(clean.length) await window.update('orders', { snap_items: clean, updated_at: nowISO() }, { id: order_id });

        try{ sessionStorage.removeItem('client_photo_thumb'); sessionStorage.removeItem('stairs_photo_thumb'); }catch(_){}
        location.href = '/pastrimi/';
        return;
      }catch(err){
        const msg = (err && (err.message || err))+'';
        if(attempt===0 && /23505|duplicate key|unique/i.test(msg)){
          // race on code -> retry once with new code
          window.assignedCode = null; continue;
        }
        throw err;
      }
    }
  };

  window.pranimiSavePatched = true;
})();