// Reads current PRANIMI rows + photos and updates orders.snap_items when you press 💾 RUAJ.

(function(){
  function $(s,r){ return (r||document).querySelector(s); }
  function $all(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)||[]); }
  function digits(v){ return String(v==null?'':v).replace(/\D/g,''); }
  function num(v){ var n=Number(String(v||'').replace(',','.')); return isFinite(n)?n:0; }
  function nowISO(){ return new Date().toISOString(); }

  function getCode(){
    var b = $('#ticketCode'); if(!b) return null;
    var dc = b.getAttribute('data-code');
    if(dc) return digits(dc);
    return digits(b.textContent||'');
  }

  // Build snapshot using your DOM (keeps your layout)
  function getPiecesSnapshot(){
    var out = [];

    // tepiha
    $all('#list-tepiha .piece-row').forEach(function(row){
      var inp = row.querySelector('input[type="number"], .piece-input, input');
      var m2  = num(inp ? inp.value : '');
      var photo = (function(){
        var img = row.querySelector('.thumb, img'); if (img && img.src) return img.src;
        var dp = row.getAttribute('data-photo'); if (dp) return dp;
        var holder = row.querySelector('[data-photo]'); if(holder && holder.getAttribute('data-photo')) return holder.getAttribute('data-photo');
        return null;
      })();
      if (m2>0 || photo) out.push({ kind:'tepiha', m2:m2, photo:photo });
    });

    // staza
    $all('#list-staza .piece-row').forEach(function(row){
      var inp = row.querySelector('input[type="number"], .piece-input, input');
      var m2  = num(inp ? inp.value : '');
      var photo = (function(){
        var img = row.querySelector('.thumb, img'); if (img && img.src) return img.src;
        var dp = row.getAttribute('data-photo'); if (dp) return dp;
        var holder = row.querySelector('[data-photo]'); if(holder && holder.getAttribute('data-photo')) return holder.getAttribute('data-photo');
        return null;
      })();
      if (m2>0 || photo) out.push({ kind:'staza', m2:m2, photo:photo });
    });

    // shkallore (optional summary)
    var stairsM2 = $('#stairsM2') ? num($('#stairsM2').textContent) : 0;
    if (stairsM2>0){
      var sPhoto = null;
      try{ sPhoto = sessionStorage.getItem('stairs_photo_thumb') || null; }catch(_){}
      out.push({ kind:'shkallore', m2:stairsM2, photo:sPhoto });
    }

    return out;
  }

  async function upsertOrderWithSnapshot(){
    if (typeof window.select !== 'function' || typeof window.update !== 'function' || typeof window.insert !== 'function'){
      alert('Supabase helpers not loaded'); return;
    }

    var code  = getCode();
    var name  = ($('#name') && $('#name').value || '').trim();
    var phone = ($('#phone') && $('#phone').value || '').replace(/\D/g,'');
    if(!code){ alert('S’ka KOD'); return; }
    if(!name){ alert('Shkruaj emrin'); return; }
    if(!phone){ alert('Shkruaj telefonin'); return; }

    var t = { m2:0, pieces:0, euro_total:0, price_general:0 };
    try{ if (typeof window.recalcTotals==='function') t = window.recalcTotals() || t; }catch(_){}

    var snap = getPiecesSnapshot();

    var patch = {
      code: code, name: name, phone: phone,
      price_per_m2: Number(t.price_general||0),
      m2: Number(t.m2||0),
      pieces: Number(t.pieces||0),
      total: Number(t.euro_total||0),
      status: 'pastrim',
      snap_items: snap,
      updated_at: nowISO()
    };

    // upsert-by-code
    var rows = await window.select('orders', { code:'eq.'+code, order:'created_at.desc' });
    rows = Array.isArray(rows) ? rows : (rows && rows.data) || [];
    var order = null;
    if (rows.length){
      for (var i=0;i<rows.length;i++){
        if (String(rows[i].status||'').toLowerCase()!=='gati'){ order = rows[i]; break; }
      }
      if(!order) order = rows[0];
      await window.update('orders', patch, { id: order.id });
    } else {
      patch.created_at = nowISO();
      var ins = await window.insert('orders', patch);
      order = Array.isArray(ins) ? ins[0] : ins;
    }

    alert('U ruajt ✔  ('+snap.length+' artikuj)');
  }

  // Bind your existing “💾 RUAJ” button
  function bindSave(){
    var b = $('#btnSaveDraft');
    if(!b) return;
    b.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      upsertOrderWithSnapshot().catch(function(e){ alert('Gabim: '+(e && e.message ? e.message : e)); });
    }, true);
  }

  document.addEventListener('DOMContentLoaded', bindSave);
})();
