// PRANIMI bridge — uses your existing UI functions, no layout changes.
// Loads/saves items+photos into orders.snap_items for ?code=XXXX

(function(){
  // ----- tiny utils -----
  function $(s,r){return (r||document).querySelector(s);}
  function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s)||[]);}
  function digits(v){return String(v==null?'':v).replace(/\D/g,'');}
  function num(v){var n=Number(String(v||'').replace(',','.'));return isFinite(n)?n:0;}
  function nowISO(){return new Date().toISOString();}

  // ----- code badge helpers -----
  function getCode(){
    var b = $('#ticketCode');
    if(!b) return null;
    var dc = b.getAttribute('data-code');
    if(dc) return digits(dc);
    return digits(b.textContent||'');
  }
  function setCode(code){
    var b=$('#ticketCode'); if(!b) return;
    b.setAttribute('data-code', code);
    var txt=(b.textContent||'').replace(/\d+/, code);
    b.textContent=/KODI/i.test(txt)?txt:('KODI: '+code);
    try{ window.assignedCode = code; }catch(_){}
  }

  // ----- Supabase helpers (your /assets/supabase.js) -----
  async function sbSelectOrdersByCode(code){
    if(typeof window.select==='function'){
      const r = await window.select('orders', { code:'eq.'+code, order:'created_at.desc' });
      return Array.isArray(r) ? r : (r && r.data) || [];
    }
    throw new Error('window.select missing (load /assets/supabase.js first)');
  }
  async function sbUpdateOrder(id, patch){
    if(typeof window.update==='function'){
      return window.update('orders', patch, { id:id });
    }
    throw new Error('window.update missing');
  }
  async function sbInsertOrder(row){
    if(typeof window.insert==='function'){
      return window.insert('orders', row);
    }
    throw new Error('window.insert missing');
  }

  // ----- Snapshot from UI (prefer your function if present) -----
  function buildSnapshotFromDOM(){
    // Try your helper first
    if (typeof window.getPiecesSnapshot === 'function') {
      try {
        const snap = window.getPiecesSnapshot();
        if (Array.isArray(snap)) return snap;
      } catch(_){}
    }

    // Fallback DOM scan matching your markup
    const out = [];
    // tepiha
    $$('#list-tepiha .piece-row').forEach(function(row){
      const m2 = readRowM2(row);
      const photo = readRowPhoto(row);
      if (m2>0 || photo) out.push({ kind:'tepiha', m2:m2, photo:photo });
    });
    // staza
    $$('#list-staza .piece-row').forEach(function(row){
      const m2 = readRowM2(row);
      const photo = readRowPhoto(row);
      if (m2>0 || photo) out.push({ kind:'staza', m2:m2, photo:photo });
    });
    // shkallore summary (optional)
    const stairsM2 = num($('#stairsM2') ? $('#stairsM2').textContent : 0);
    if (stairsM2>0) {
      let photo = null;
      try{ photo = sessionStorage.getItem('stairs_photo_thumb') || null; }catch(_){}
      out.push({ kind:'shkallore', m2:stairsM2, photo:photo });
    }
    return out;

    function readRowM2(row){
      const inp = row.querySelector('input[type="number"], .piece-input, input');
      return num(inp ? inp.value : '');
    }
    function readRowPhoto(row){
      const img = row.querySelector('.thumb, img');
      if (img && img.src) return img.src;
      const bg = row.getAttribute('data-photo');
      if (bg) return bg;
      const holder = row.querySelector('[data-photo]');
      if (holder && holder.getAttribute('data-photo')) return holder.getAttribute('data-photo');
      return null;
    }
  }

  // ----- Rehydration (prefer your addRow / setPiecePhoto) -----
  function addItemToUI(kind, m2, photo){
    // Use your native addRow if present to keep layout
    if (typeof window.addRow === 'function') {
      try {
        // Try (kind, m2) signature first
        window.addRow(kind, m2);
      } catch(_) {
        // Fallback to (kind) then set input
        window.addRow(kind, null);
      }
      const list = $('#list-'+kind);
      const row  = list && list.lastElementChild;
      if (!row) return;
      const inp = row.querySelector('input[type="number"], .piece-input, input');
      if (inp && (m2!=null)) inp.value = String(m2);
      if (photo) {
        if (typeof window.setPiecePhoto === 'function') {
          try{ window.setPiecePhoto(row, photo); }catch(_){}
        } else {
          // minimal fallback
          let img = row.querySelector('.thumb');
          if(!img){
            img = document.createElement('img');
            img.className = 'thumb';
            img.style.cssText='width:44px;height:44px;border-radius:10px;object-fit:cover;border:1px solid #2b3956';
            const left = row.querySelector('.left') || row.firstElementChild || row;
            left && left.insertBefore(img, left.firstChild);
          }
          img.src = photo;
          img.style.display='inline-block';
          row.setAttribute('data-photo', photo);
        }
      }
      return;
    }

    // If addRow doesn’t exist, do nothing (we won’t touch your layout)
  }

  // ----- Save hook (binds your 💾 RUAJ button) -----
  async function handleSave(){
    const code = getCode();
    const name = ($('#name') && $('#name').value || '').trim();
    const phone= ($('#phone') && $('#phone').value || '').replace(/\D/g,'');
    if(!code){ alert('S’ka KOD. Hape nga lista ose gjenero kod.'); return; }
    if(!name){ alert('Shkruaj emrin'); return; }
    if(!phone){ alert('Shkruaj telefonin'); return; }

    // totals (prefer your recalcTotals)
    let t = { m2:0, pieces:0, euro_total:0, price_general:0 };
    try{
      if (typeof window.recalcTotals === 'function') t = window.recalcTotals() || t;
    }catch(_){}

    const snap = buildSnapshotFromDOM();

    const patch = {
      code: code,
      name: name,
      phone: phone,
      price_per_m2: Number(t.price_general||0),
      m2: Number(t.m2||0),
      pieces: Number(t.pieces||0),
      total: Number(t.euro_total||0),
      status: 'pastrim',
      snap_items: snap,
      updated_at: nowISO()
    };

    // upsert-by-code
    const exist = await sbSelectOrdersByCode(code);
    let order = null;
    if (exist && exist.length){
      for (let i=0;i<exist.length;i++){
        if (String(exist[i].status||'').toLowerCase()!=='gati'){ order=exist[i]; break; }
      }
      if(!order) order = exist[0];
      await sbUpdateOrder(order.id, patch);
    } else {
      patch.created_at = nowISO();
      const ins = await sbInsertOrder(patch);
      order = Array.isArray(ins) ? ins[0] : ins;
    }

    // quick verification round-trip
    const check = await sbSelectOrdersByCode(code);
    const latest = (check && check[0]) || null;
    let savedCount = 0;
    if (latest){
      let si = latest.snap_items;
      if (typeof si === 'string') { try{ si = JSON.parse(si); }catch(_){ si = []; } }
      savedCount = Array.isArray(si) ? si.length : 0;
    }
    alert('U ruajt ✔  (artikuj: '+(snap.length)+' / në DB: '+savedCount+')');
  }

  // ----- Load on ?code= ---
  async function loadIfCode(){
    const m = (location.search||'').match(/[?&]code=([^&]+)/);
    const code = m ? digits(decodeURIComponent(m[1])) : null;
    if(!code) return;
    setCode(code);

    const rows = await sbSelectOrdersByCode(code);
    if(!rows || !rows.length) return;
    let order = null;
    for (let i=0;i<rows.length;i++){
      if (String(rows[i].status||'').toLowerCase()!=='gati'){ order=rows[i]; break; }
    }
    if(!order) order = rows[0];

    if ($('#name'))  $('#name').value  = order.name || '';
    if ($('#phone')) $('#phone').value = order.phone || '';

    // price_per_m2 -> totals cache
    const ppm2 = Number(order.price_per_m2||0);
    if (ppm2>0){
      try{ localStorage.setItem('price_per_m2', String(ppm2)); }catch(_){}
      let hidden = $('#pricePerM2'); if(!hidden){ hidden=document.createElement('input'); hidden.type='hidden'; hidden.id='pricePerM2'; document.body.appendChild(hidden); }
      hidden.value = String(ppm2);
    }

    // hydrate from snap_items (no structural changes)
    let snap = order.snap_items;
    if (typeof snap === 'string'){ try{ snap = JSON.parse(snap); }catch(_){ snap = []; } }
    if (Array.isArray(snap)){
      snap.forEach(function(it){
        const kind = (function(k){
          k = String(k||'').toLowerCase();
          if(/staz/.test(k)) return 'staza';
          if(/shk|stair/.test(k)) return 'shkallore';
          return 'tepiha';
        })(it && it.kind);

        if (kind === 'shkallore'){
          // write to summary if present
          const el = $('#stairsM2'); if (el) el.textContent = Number(it.m2||0).toFixed(2);
          return;
        }
        addItemToUI(kind, it && it.m2, it && it.photo);
      });
    }

    try{ if (typeof window.recalcTotals==='function') window.recalcTotals(); }catch(_){}
  }

  // ----- wire up Save button (don’t fight your existing handlers) -----
  function wireSaveButton(){
    const b = $('#btnSaveDraft');
    if (!b) return;
    // Replace click with our handler (your button is only “draft save”)
    b.addEventListener('click', function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      handleSave().catch(function(e){ alert('Gabim: '+(e && e.message ? e.message : e)); });
    }, true);
  }

  // ----- boot -----
  document.addEventListener('DOMContentLoaded', function(){
    wireSaveButton();
    loadIfCode().catch(function(e){ console.warn('loadIfCode error', e); });
  });
})();
