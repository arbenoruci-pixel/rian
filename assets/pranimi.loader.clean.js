// Loads PRANIMI from orders.snap_items; no UI changes, no debug.

(function(){
  // --- tiny utils ---
  function $(s,r){ return (r||document).querySelector(s); }
  function digits(v){ return String(v==null?'':v).replace(/\D/g,''); }
  function num(v){ var n=Number(String(v||'').replace(',','.')); return isFinite(n)?n:0; }

  function getCodeFromURL(){
    var m = (location.search||'').match(/[?&]code=([^&]+)/);
    return m ? digits(decodeURIComponent(m[1])) : null;
  }
  function setBadgeCode(code){
    var b = $('#ticketCode'); if(!b) return;
    b.setAttribute('data-code', code);
    var txt = (b.textContent||'').replace(/\d+/, code);
    b.textContent = /KODI/i.test(txt) ? txt : ('KODI: ' + code);
    try { window.assignedCode = code; window.ensureCode = function(){ return Promise.resolve(code); }; } catch(_){}
  }

  // Supabase (your helpers from /assets/supabase.js)
  async function fetchOrderByCode(code){
    if (typeof window.select !== 'function') throw new Error('supabase helpers missing');
    var rows = await window.select('orders', { code:'eq.'+code, order:'created_at.desc' });
    rows = Array.isArray(rows) ? rows : (rows && rows.data) || [];
    if (!rows.length) return null;
    for (var i=0;i<rows.length;i++){
      if (String(rows[i].status||'').toLowerCase()!=='gati') return rows[i];
    }
    return rows[0];
  }

  // Rehydrate one row using your existing UI
  function setPiecePhoto(row, url){
    try{
      if (typeof window.setPiecePhoto === 'function'){ window.setPiecePhoto(row, url); return; }
      var img = row.querySelector('.thumb');
      if(!img){
        img = document.createElement('img');
        img.className = 'thumb';
        img.style.cssText='width:44px;height:44px;border-radius:10px;object-fit:cover;border:1px solid #2b3956';
        var left = row.querySelector('.left') || row.firstElementChild || row;
        left && left.insertBefore(img, left.firstChild);
      }
      img.src = url;
      img.style.display = 'inline-block';
      row.setAttribute('data-photo', url);
    }catch(_){}
  }
  function addItemToUI(kind, m2, photo){
    // Prefer your addRow so markup stays identical
    var listId = '#list-' + kind;
    if (typeof window.addRow === 'function') {
      try { window.addRow(kind, m2); }
      catch(_){ window.addRow(kind, null); }
      var list = $(listId);
      var row  = list && list.lastElementChild;
      if (!row) return;
      var inp = row.querySelector('input[type="number"], .piece-input, input');
      if (inp && (m2!=null)) inp.value = String(m2);
      if (photo) setPiecePhoto(row, photo);
      return;
    }

    // Fallback (only if addRow is missing) — minimal row, won’t break styling
    var list = $(listId);
    if (!list) return;
    var row = document.createElement('div');
    row.className = 'piece-row';
    row.innerHTML =
      '<div class="left">'+
        '<input class="input piece-input" type="number" step="0.01" value="'+(m2!=null?String(m2):'')+'"/>'+
      '</div>';
    list.appendChild(row);
    if (photo) setPiecePhoto(row, photo);
  }

  function normKind(k){
    k = String(k||'').toLowerCase();
    if (/staz/.test(k)) return 'staza';
    if (/shk|stair/.test(k)) return 'shkallore';
    return 'tepiha';
  }

  async function run(){
    var code = getCodeFromURL();
    if(!code) return;
    setBadgeCode(code);

    var order = await fetchOrderByCode(code);
    if(!order) return;

    // basics
    if ($('#name'))  $('#name').value  = order.name  || '';
    if ($('#phone')) $('#phone').value = order.phone || '';

    var ppm2 = Number(order.price_per_m2||0);
    if (ppm2>0){
      try{ localStorage.setItem('price_per_m2', String(ppm2)); }catch(_){}
      var hidden = $('#pricePerM2');
      if(!hidden){ hidden=document.createElement('input'); hidden.type='hidden'; hidden.id='pricePerM2'; document.body.appendChild(hidden); }
      hidden.value = String(ppm2);
    }

    // items from snap_items (jsonb or text)
    var snap = order.snap_items;
    if (typeof snap === 'string'){ try{ snap = JSON.parse(snap); }catch(_){ snap = []; } }
    if (!Array.isArray(snap)) snap = [];

    // build UI rows
    for (var i=0;i<snap.length;i++){
      var it = snap[i] || {};
      var kind = normKind(it.kind);
      var m2   = (it.m2!=null ? Number(it.m2) : null);
      var photo= it.photo || null;

      if (kind === 'shkallore'){
        var stairs = $('#stairsM2'); if (stairs) stairs.textContent = (m2!=null?m2:0).toFixed(2);
        try{ if(photo) sessionStorage.setItem('stairs_photo_thumb', photo); }catch(_){}
        continue;
      }
      addItemToUI(kind, m2, photo);
    }

    if (typeof window.recalcTotals === 'function') try{ window.recalcTotals(); }catch(_){}
  }

  document.addEventListener('DOMContentLoaded', function(){ run().catch(function(e){ console.warn(e); }); });
})();
