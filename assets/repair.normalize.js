// /assets/repair.normalize.js
// Normalizes old orders: derive pieces/m2/items from orders.snap_items and backfill order_items.
// Safe to run multiple times.
(async function(){
  try{
    const base = (window.SUPABASE_URL||'').replace(/\/$/,'');
    const headers = { 'apikey': window.SUPABASE_ANON, 'Authorization':'Bearer '+window.SUPABASE_ANON, 'Content-Type':'application/json' };

    async function rest(path, opts){ 
      const r = await fetch(base+path, Object.assign({headers}, opts||{})); 
      const t = await r.text(); if(!r.ok) throw new Error(t||r.status); 
      try{return JSON.parse(t)}catch{ return t } 
    }

    async function listOrdersNeedingFix(){
      const url = new URL(base+'/rest/v1/orders');
      url.searchParams.set('select', 'id,code,name,phone,pieces,m2,total,snap_items,created_at');
      url.searchParams.set('order', 'created_at.desc');
      // If already has items, skip:
      url.searchParams.set('or', 'and(pieces.eq.0,m2.eq.0),and(pieces.is.null,m2.is.null)');
      const r = await fetch(url, {headers});
      if(!r.ok) return [];
      return await r.json();
    }

    function deriveFromSnap(snap){
      let pieces=0, m2=0, items=[];
      if(!Array.isArray(snap)) return {pieces:0,m2:0,items:[]};
      for(const it of snap){
        const kind = (it.kind||it.type||'tepiha').toLowerCase();
        const area = Number(it.m2||it.m||it.area||0) || 0;
        const photo = it.photo || it.url || null;
        if(area>0 || photo){
          pieces += 1; m2 += area;
          items.push({type:kind, label:kind.toUpperCase(), m2:area, photo});
        }
      }
      return {pieces, m2, items};
    }

    async function upsertItems(orderId, items){
      for(const it of items){
        try{
          await rest('/rest/v1/order_items', {method:'POST', body:JSON.stringify({order_id:orderId, type:it.type, label:it.label, m2:it.m2, photo:it.photo}), headers});
        }catch(e){ /* ignore duplicates */ }
      }
    }

    async function patchOrder(orderId, patch){
      const url = new URL(base+'/rest/v1/orders');
      url.searchParams.set('id','eq.'+orderId);
      await fetch(url, {method:'PATCH', headers, body:JSON.stringify(patch)});
    }

    const bad = await listOrdersNeedingFix();
    if(!bad.length) return;
    for(const o of bad){
      const snap = (typeof o.snap_items==='string') ? JSON.parse(o.snap_items||'[]') : (o.snap_items||[]);
      const d = deriveFromSnap(snap);
      await upsertItems(o.id, d.items);
      await patchOrder(o.id, { pieces: d.pieces, m2: d.m2 });
    }
    console.log('[repair.normalize] fixed', bad.length, 'orders');
  }catch(e){ console.warn('[repair.normalize] skipped:', e.message); }
})();