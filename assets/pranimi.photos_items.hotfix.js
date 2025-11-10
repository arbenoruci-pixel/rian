/* Hotfix: after we insert the order header, also:
   - insert order_items (tepiha/staza/shkallore)
   - upload row/stairs photos to Storage
   - save public URLs in orders.snap_items
   Works with your existing window.insert/update/select/rpc helpers.
*/
(function(){
  function $(s,r){ return (r||document).querySelector(s); }
  function num(v){ var n=parseFloat(String(v==null?'':v).replace(',','.')); return isFinite(n)?n:0; }
  function nowISO(){ return new Date().toISOString(); }

  // ---- read UI ----
  function readRowPhoto(row){
    var img=row && row.querySelector && row.querySelector('img.thumb');
    return (img && img.src && img.style.display!=='none') ? img.src : null;
  }
  function collectItems(order_id, now){
    var items=[];
    document.querySelectorAll('#list-tepiha .piece-row').forEach(function(row){
      var v=num(row.querySelector('.m2') && row.querySelector('.m2').value);
      if(v>0) items.push({ order_id, kind:'tepiha', m2:v, created_at:now });
    });
    document.querySelectorAll('#list-staza .piece-row').forEach(function(row){
      var v=num(row.querySelector('.m2') && row.querySelector('.m2').value);
      if(v>0) items.push({ order_id, kind:'staza', m2:v, created_at:now });
    });
    // stairs from qty * per
    var qty = Number((document.querySelector('#stairsQty')||{}).value||0);
    var per = Number((document.querySelector('#stairsPer')||{}).value||0.3) || 0.3;
    var m2 = Math.max(0, qty*per);
    if(m2>0) items.push({ order_id, kind:'shkallore', m2:m2, created_at:now });
    return items;
  }
  function collectSnapshot(){
    var snap=[];
    document.querySelectorAll('#list-tepiha .piece-row').forEach(function(row){
      var v=num(row.querySelector('.m2') && row.querySelector('.m2').value);
      var p=readRowPhoto(row);
      if(v>0 || p) snap.push({ kind:'tepiha', m2:v||0, photo:p||null });
    });
    document.querySelectorAll('#list-staza .piece-row').forEach(function(row){
      var v=num(row.querySelector('.m2') && row.querySelector('.m2').value);
      var p=readRowPhoto(row);
      if(v>0 || p) snap.push({ kind:'staza', m2:v||0, photo:p||null });
    });
    try{
      var stairsPhoto = sessionStorage.getItem('stairs_photo_thumb')||null;
      var qty = Number((document.querySelector('#stairsQty')||{}).value||0);
      var per = Number((document.querySelector('#stairsPer')||{}).value||0.3) || 0.3;
      var m2 = Math.max(0, qty*per);
      if(m2>0 || stairsPhoto) snap.push({ kind:'shkallore', m2:m2||0, photo:stairsPhoto });
    }catch(_){}
    return snap;
  }

  // ---- storage upload (public URL) ----
  var BUCKET = 'tapija-photos';
  async function uploadDataUri(orderId, dataURI){
    if(!dataURI || !/^data:/.test(dataURI)) return null;
    var m = dataURI.match(/^data:(image\/[\w.+-]+);base64,/);
    var mime = m ? m[1] : 'image/jpeg';
    var base64 = dataURI.split(',')[1]||'';
    var bytes = Uint8Array.from(atob(base64), c=>c.charCodeAt(0));
    var ext = (mime.split('/')[1]||'jpg').toLowerCase();
    var path = `${orderId}/${Date.now()}.${ext}`;

    // REST (works with anon key)
    var url = `${window.SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`;
    var r = await fetch(url, {
      method: 'PUT',
      headers: {
        apikey: window.SUPABASE_ANON,
        Authorization: `Bearer ${window.SUPABASE_ANON}`,
        'Content-Type': mime
      },
      body: bytes
    });
    if(!r.ok) return null;
    return `${window.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(path)}`;
  }

  async function toPublicUrls(orderId, snap){
    var out=[];
    for (var i=0;i<snap.length;i++){
      var s=snap[i], url=s.photo||null;
      if(url && /^data:/.test(url)){
        url = await uploadDataUri(orderId, url);
      }
      out.push({ kind:s.kind, m2:Number(s.m2||0), photo:url||null });
    }
    return out;
  }

  // ---- public API: call after header insert ----
  window.__afterOrderHeaderSaved = async function(orderRow){
    try{
      var order_id = orderRow && (orderRow.id || orderRow.order_id || orderRow.uuid);
      if(!order_id) return;

      var now = nowISO();

      // 1) items
      var items = collectItems(order_id, now);
      if(items.length){
        try{ await window.insert('order_items', items); }catch(e){ console.warn('order_items insert', e); }
      }

      // 2) photos → URLs → snap_items
      var snap = collectSnapshot();
      if(snap.length){
        var withUrls = await toPublicUrls(order_id, snap);
        try{ await window.update('orders', { snap_items: withUrls, updated_at: nowISO() }, { id: order_id }); }catch(e){ console.warn('snap_items update', e); }
      }

      // clean local thumbs
      try{
        sessionStorage.removeItem('stairs_photo_thumb');
        sessionStorage.removeItem('client_photo_thumb');
      }catch(_){}
    }catch(err){
      console.error('afterOrderHeaderSaved', err);
    }
  };
})();