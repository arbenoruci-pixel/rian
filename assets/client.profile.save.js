// /assets/client.profile.save.js
// Client Profile: load by ?id=..., allow editing, and save:
// - UPDATE orders (same KODI), DELETE & INSERT order_items, upload photos to Storage (tapija-photos), save URLs in snap_items.

(function () {
  const BUCKET = 'tapija-photos';

  function qs(name) {
    const m = (location.search || '').match(new RegExp('[?&]' + name + '=([^&]+)'));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }
  function $ (s,r){ return (r||document).querySelector(s); }
  function $all(s,r){ return Array.from((r||document).querySelectorAll(s)); }
  function num(v){ const n=parseFloat(String(v??'').replace(',','.')); return isFinite(n)?n:0; }
  function nowISO(){ return new Date().toISOString(); }
  async function wait(){ const until=Date.now()+7000; while(!(window.select&&window.update&&window.insert&&window.rpc) && Date.now()<until){ await new Promise(r=>setTimeout(r,40)); } }
  function getPrice(){ try{ return Number(localStorage.getItem('price_per_m2')||0) }catch{ return 0 } }

  async function uploadBase64(orderId, dataURI){
    if(!dataURI || !dataURI.startsWith('data:') || !window.supabase?.storage) return null;
    try{
      const m = dataURI.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);
      const mime = m ? m[1] : 'image/jpeg';
      const base64 = dataURI.split(',')[1] || '';
      const buf = Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
      const ext = (mime.split('/')[1]||'jpg').toLowerCase();
      const filename = `${Date.now()}.${ext}`;
      const path = `${orderId}/${filename}`;
      const { error: upErr } = await window.supabase.storage.from(BUCKET).upload(path, buf, { contentType: mime });
      if(upErr) return null;
      const { data: signed, error: signErr } = await window.supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
      if(signErr || !signed) return null;
      return signed.signedUrl || null;
    }catch{ return null; }
  }

  async function delItemsREST(orderId){
    const url = `${window.SUPABASE_URL}/rest/v1/order_items?order_id=eq.${encodeURIComponent(orderId)}`;
    const headers = { apikey: window.SUPABASE_ANON, Authorization: `Bearer ${window.SUPABASE_ANON}` };
    const r = await fetch(url, { method:'DELETE', headers });
    if(!r.ok) throw new Error(await r.text() || r.status);
  }

  // ---------- LOAD ----------
  async function load(){
    await wait();
    const id = qs('id'); if(!id) return;

    // 1) fetch order
    let order=null;
    try{ const rows = await window.select('orders', { id:'eq.'+id, limit:'1' }); if(Array.isArray(rows)&&rows.length) order=rows[0]; }catch{}
    if(!order) return;

    // expose globals for engine compatibility
    window.currentOrderId = order.id;
    window.assignedCode = String(order.code||'');
    window.pranimiMode = 'edit';

    // UI
    const b = document.querySelector('#ticketCode');
    if(b && window.assignedCode){ b.dataset.code = window.assignedCode; b.textContent = 'KODI: '+window.assignedCode; }
    if($('#name'))  $('#name').value  = order.name||'';
    if($('#phone')) $('#phone').value = order.phone||'';
    try{ if(order.price_per_m2) localStorage.setItem('price_per_m2', String(order.price_per_m2)); }catch{}

    // 2) items
    let items=[];
    try{
      const it = await window.select('order_items', { order_id:'eq.'+id, order:'created_at.asc' });
      if(Array.isArray(it) && it.length){
        items = it.map(x => ({ kind: (/(staz)/i.test(x.kind)?'staza':(/shk/i.test(x.kind)?'shkallore':'tepiha')), m2:Number(x.m2||0), photo:null }));
      }
    }catch{}
    if(!items.length){
      let snap = order.snap_items || null;
      try{ if(typeof snap==='string') snap = JSON.parse(snap); }catch{}
      if(Array.isArray(snap) && snap.length) items = snap.map(x => ({ kind:x.kind, m2:Number(x.m2||0), photo:x.photo||null }));
    }

    // 3) render
    if(items.length){
      items.forEach(p=>{
        if(typeof window.addRow==='function') window.addRow(p.kind, p.m2||'');
        const list = document.querySelector('#list-'+p.kind);
        const row = list && list.lastElementChild;
        if(row){
          const inp=row.querySelector('.m2'); if(inp) inp.value = (p.m2||'');
          if(p.photo){
            const img = row.querySelector('img.thumb'); if(img){ img.src = p.photo; img.style.display='block'; }
          }
        }
      });
      if(typeof window.recalcTotals==='function') window.recalcTotals();
    }
  }

  // ---------- SAVE ----------
  async function saveProfile(){
    await wait();
    const id = qs('id'); if(!id) return;
    const name = ($('#name')?.value||'').trim();
    const phone = ($('#phone')?.value||'').replace(/\D/g,'');
    if(!name) throw new Error('Shkruaj emrin');
    if(!phone) throw new Error('Shkruaj telefonin');

    const price = getPrice();
    // totals
    let m2=0, pieces=0;
    ['tepiha','staza'].forEach(kind=>{
      $all('#list-'+kind+' .piece-row').forEach(row=>{
        const v=num(row.querySelector('.m2')?.value);
        if(v>0){ m2+=v; pieces++; }
      });
    });
    const stairsQty = Number(document.querySelector('#stairsQty')?.value || 0);
    if(stairsQty>0){ m2 += stairsQty*0.3; pieces += 1; }

    const now = nowISO();

    // 1) update orders head
    await window.update('orders', {
      name, phone,
      price_per_m2: Number(price||0),
      m2: Number(m2||0),
      pieces: Number(pieces||0),
      total: Number((m2||0) * (price||0)),
      updated_at: now
    }, { id });

    // 2) delete + insert items
    try{ await delItemsREST(id); }catch(e){ console.warn('delete items failed', e); }
    const items=[];
    $all('#list-tepiha .piece-row').forEach(row=>{ const v=num(row.querySelector('.m2')?.value); if(v>0) items.push({ order_id:id, kind:'tepiha', m2:v, price:price, created_at:now }); });
    $all('#list-staza .piece-row').forEach(row=>{ const v=num(row.querySelector('.m2')?.value); if(v>0) items.push({ order_id:id, kind:'staza', m2:v, price:price, created_at:now }); });
    const stairM2 = stairsQty * 0.3;
    if(stairM2>0) items.push({ order_id:id, kind:'shkallore', m2:stairM2, price:price, created_at:now });
    if(items.length) await window.insert('order_items', items);

    // 3) snapshot -> upload base64 -> URLs only
    const snap=[];
    $all('#list-tepiha .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')?.value);
      const img=row.querySelector('img.thumb'); const p=(img&&img.src)?img.src:null;
      if(v>0 || p) snap.push({ kind:'tepiha', m2:v||0, photo:p });
    });
    $all('#list-staza .piece-row').forEach(row=>{
      const v=num(row.querySelector('.m2')?.value);
      const img=row.querySelector('img.thumb'); const p=(img&&img.src)?img.src:null;
      if(v>0 || p) snap.push({ kind:'staza', m2:v||0, photo:p });
    });
    const stairsPhoto = sessionStorage.getItem('stairs_photo_thumb') || null;
    if(stairM2>0 || stairsPhoto) snap.push({ kind:'shkallore', m2:stairM2||0, photo:stairsPhoto });

    const clean=[];
    for(const s of snap){
      let url = s.photo || null;
      if(url && url.startsWith('data:')){
        url = await uploadBase64(id, url);
      }
      clean.push({ kind:s.kind, m2:s.m2, photo: url || null });
    }

    if(clean.length){
      await window.update('orders', { snap_items: clean, updated_at: nowISO() }, { id });
    }

    alert('U ruajt me sukses');
    location.href = '/pastrimi/';
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    load().catch(console.error);
    const btn = document.querySelector('#btnSaveProfile') || document.querySelector('#btnSaveDraft');
    if(btn) btn.addEventListener('click', async e => { e.preventDefault(); try{ await saveProfile(); }catch(err){ alert('Ruajtja dështoi: '+(err?.message||err)); } });
  });
})();