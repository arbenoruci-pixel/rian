// ================= PRANIMI — FULL ENGINE (safe, with photo preview + long-press + storage URLs) =================
// Keeps your design/flows; adds: photo preview on tap; long-press retake/remove; code retry on duplicate;
// saves order_items and orders.snap_items (photo URLs), and locks code in edit.

// -------- tiny helpers --------
function $(sel, root){ return (root||document).querySelector(sel); }
function $all(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }
function num(v){ var n = parseFloat(String(v==null?'':v).replace(',', '.')); return isFinite(n) ? n : 0; }
function digits(v){ return String(v==null?'':v).replace(/\D/g,''); }
function nowISO(){ return new Date().toISOString(); }
function qs(name){ var m=(location.search||'').match(new RegExp('[?&]'+name+'=([^&]+)')); return m?decodeURIComponent(m[1].replace(/\+/g,' ')):null; }

// -------- code handling --------
var assignedCode = null;
async function ensureCode(){
  // If editing, lock code from URL/badge
  var orderId = qs('id');
  if (orderId){
    var b = $('#ticketCode') || document.querySelector('.badge.kodi');
    var fromBadge = (b && b.dataset && b.dataset.code) ? b.dataset.code : '';
    var fromURL   = digits(qs('code')||'');
    var locked = String(fromBadge || assignedCode || fromURL || '');
    if (locked){ assignedCode=locked; if(b){b.dataset.code=locked; b.textContent='KODI: '+locked;} return assignedCode; }
  }
  if (assignedCode) return assignedCode;

  const r = await rpc('next_code_num', {});
  let code = r;
  if (Array.isArray(r)) {
    var it = r[0]; code = (it && typeof it==='object') ? (it.next_code || it.code || it.id) : it;
  } else if (r && typeof r==='object') {
    code = r.next_code || r.code || r.id;
  }
  assignedCode = digits(code);
  if (!assignedCode) throw new Error('Kodi nuk u gjenerua');
  var b = $('#ticketCode') || document.querySelector('.badge.kodi');
  if (b) { b.dataset.code = assignedCode; b.textContent = 'KODI: ' + assignedCode; }
  return assignedCode;
}

// -------- price storage --------
function getStoredPrice(){ var s=localStorage.getItem('price_per_m2'); return s==null?0:num(s); }
function setStoredPrice(v){ try{ localStorage.setItem('price_per_m2', String(num(v))); }catch(e){} }
function promptSetPrice(def){ var cur=getStoredPrice()||def||0; var v=prompt('Çmimi (€) për m²:', cur); if(v===null) return false; setStoredPrice(v); recalcTotals(); return true; }

// -------- pieces (tepiha/staza) rows --------
function makeRow(m2){
  var row=document.createElement('div');
  row.className='piece-row';
  row.innerHTML =
    '<div class="left">'+
      '<input class="piece-input m2" inputmode="decimal" placeholder="m²" value="'+(m2!=null?m2:'')+'">'+
      '<button class="cam-btn" type="button" title="Foto">📷</button>'+
      '<button class="rm" type="button" title="Hiq">✕</button>'+
    '</div>';
  wireCamButton(row.querySelector('.cam-btn'));
  row.querySelector('.rm').onclick=function(){ row.remove(); recalcTotals(); };
  return row;
}
function listHolder(kind){ return $('#list-'+kind); }

window.addRow=function(kind,m2){
  var h=listHolder(kind); if(!h) return;
  h.appendChild(makeRow(m2));
  recalcSection(kind); recalcTotals();
};
window.removeRow=function(kind){
  var h=listHolder(kind); if(h && h.lastElementChild) h.removeChild(h.lastElementChild);
  recalcSection(kind); recalcTotals();
};
function sectionSum(kind){
  var h=listHolder(kind); if(!h) return {m2:0,pieces:0};
  var sum=0, pcs=0;
  $all('.m2',h).forEach(function(inp){ var v=num(inp.value); if(v>0){ sum+=v; pcs++; } });
  return { m2:sum, pieces:pcs };
}
function recalcSection(kind){
  var s=sectionSum(kind), out=$('#tot-'+kind);
  if(out) out.textContent = s.m2.toFixed(2)+' m²';
}

// -------- chips --------
function parseM2Label(label){ var m=String(label).match(/([\d.]+)\s*m²/i); return m?num(m[1]):null; }
function wireChips(holderId,kind){
  var h=document.getElementById(holderId); if(!h) return;
  h.addEventListener('click', function(e){
    var btn=e.target.closest?e.target.closest('.chip'):null; if(!btn) return;
    var label=btn.textContent.trim();
    if(/manual/i.test(label)) { addRow(kind, null); return; }
    var v=parseM2Label(label); if(v!=null) addRow(kind,v);
  });
}

// -------- stairs --------
var stairs = { qty:0, per:0.3, price:null };
function stairsM2(){ return Math.max(0, (stairs.qty||0)*(stairs.per||0)); }
function wireStairs(){
  var qty=$('#stairsQty'), per=$('#stairsPer'), pr=$('#stairsPrice'); wireCamButton($('#stairsCamBtn'), 'stairs_photo_thumb');
  function sync(){
    stairs.qty   = Math.max(0, Math.floor(num(qty.value)));
    stairs.per   = Math.max(0, num(per.value||0.3));
    stairs.price = (pr.value===''?null:num(pr.value));
    var lbl=$('#stairsM2'); if(lbl) lbl.textContent = stairsM2().toFixed(2)+' m²';
    recalcTotals();
  }
  ['input','change'].forEach(function(ev){ qty.addEventListener(ev,sync); per.addEventListener(ev,sync); pr.addEventListener(ev,sync); });
  sync();
}

// -------- totals --------
function recalcTotals(){
  var t=sectionSum('tepiha'), s=sectionSum('staza'), stair=stairsM2();
  var m2Tot = t.m2 + s.m2 + stair;
  var m2El=$('#m2Total'); if(m2El) m2El.textContent=m2Tot.toFixed(2);
  var tt=$('#tot-tepiha'); if(tt) tt.textContent=t.m2.toFixed(2)+' m²';
  var ts=$('#tot-staza');  if(ts) ts.textContent=s.m2.toFixed(2)+' m²';

  var general = getStoredPrice() || 0;
  var stairPrice = (stairs.price==null ? general : stairs.price);
  var euro = (t.m2 + s.m2) * general + stair * stairPrice;
  var eurEl=$('#euroTotal'); if(eurEl) eurEl.textContent=euro.toFixed(2);

  window.__TOTALS__ = { m2:m2Tot, pieces: t.pieces + s.pieces + (stairs.qty||0), price_general:general, price_stairs:stairPrice, euro_total:euro };
  return window.__TOTALS__;
}
document.addEventListener('input', function(e){
  var t=e.target; if(!t?.classList?.contains('m2')) return;
  if (t.closest('#list-tepiha')) recalcSection('tepiha');
  if (t.closest('#list-staza'))  recalcSection('staza');
  recalcTotals();
});

// -------- client photo (next to name) --------
function wireClientPhoto(){ wireCamButton($('#clientCamBtn'), 'client_photo_thumb'); }

// =================== PHOTO INTERACTION (preview on tap; long-press retake/remove) ===================
function ensureThumb(btn){
  if(!btn) return null;
  var img = btn.querySelector('img.thumb');
  if(!img){
    img=document.createElement('img'); img.className='thumb'; img.alt='';
    img.style.position='absolute'; img.style.inset='0'; img.style.width='100%'; img.style.height='100%';
    img.style.objectFit='cover'; img.style.borderRadius='10px'; img.style.display='none'; img.style.zIndex='2';
    btn.style.position='relative'; btn.appendChild(img);
  }
  return img;
}
function showPreview(src){
  if(!src) return;
  var ov=document.createElement('div');
  ov.style='position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:99999;display:flex;align-items:center;justify-content:center';
  var img=new Image(); img.src=src; img.style.maxWidth='100%'; img.style.maxHeight='100%'; img.alt='';
  ov.appendChild(img);
  ov.addEventListener('click', function(){ ov.remove(); });
  document.body.appendChild(ov);
}
function retakeViaInput(cb){
  var input=document.createElement('input'); input.type='file'; input.accept='image/*;capture=camera'; input.setAttribute('capture','environment'); input.style.display='none';
  document.body.appendChild(input);
  input.onchange=function(){
    var f=input.files && input.files[0]; if(!f){ input.remove(); return; }
    var rd=new FileReader(); rd.onload=function(){ cb(String(rd.result||'')); input.remove(); };
    rd.readAsDataURL(f);
  };
  input.click();
}
function wireCamButton(btn, storageKey){
  if(!btn) return;
  var thumb = ensureThumb(btn);

  // restore from sessionStorage for persistent fields (client/stairs)
  if(storageKey){
    try{ var s=sessionStorage.getItem(storageKey); if(s){ thumb.src=s; thumb.style.display='block'; } }catch(_){}
  }

  var pressTimer=null, long=false;

  function startPress(){
    long=false; pressTimer=setTimeout(function(){ long=true; openSheet(); }, 600);
  }
  function endPress(){
    clearTimeout(pressTimer);
    if(!long){ if(thumb.style.display!=='none' && thumb.src){ showPreview(thumb.src); } else { // take new
      retakeViaInput(function(data){ thumb.src=data; thumb.style.display='block'; if(storageKey){ try{ sessionStorage.setItem(storageKey, data); }catch(_){} } });
    }}
  }

  function openSheet(){
    // Simple action sheet
    var sheet=document.createElement('div');
    sheet.style='position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center';
    sheet.innerHTML =
      '<div style="background:#0c0f16;border:1px solid #273143;border-radius:16px 16px 0 0;width:100%;max-width:520px;padding:12px">'+
        '<button id="actRetake" style="width:100%;min-height:46px;border:0;border-radius:10px;background:#1e60ff;color:#fff;font-weight:1000">📷 Zëvendëso fotografinë</button>'+
        '<button id="actRemove" style="width:100%;min-height:46px;border:1px solid #2c3a55;border-radius:10px;background:#0b111d;color:#e6f0ff;font-weight:1000;margin-top:10px">🗑️ Hiqe fotografinë</button>'+
        '<button id="actCancel" style="width:100%;min-height:46px;border:0;border-radius:10px;background:#0c0f16;color:#9fb3d7;font-weight:900;margin-top:6px">Mbyll</button>'+
      '</div>';
    document.body.appendChild(sheet);
    function close(){ sheet.remove(); }
    $('#actRetake',sheet).onclick=function(){ retakeViaInput(function(data){ thumb.src=data; thumb.style.display='block'; if(storageKey){ try{ sessionStorage.setItem(storageKey, data); }catch(_){} } close(); }); };
    $('#actRemove',sheet).onclick=function(){ thumb.src=''; thumb.style.display='none'; if(storageKey){ try{ sessionStorage.removeItem(storageKey); }catch(_){} } close(); };
    $('#actCancel',sheet).onclick=close;
    sheet.addEventListener('click', function(e){ if(e.target===sheet) close(); });
  }

  btn.addEventListener('touchstart', startPress, {passive:true});
  btn.addEventListener('mousedown', startPress);
  btn.addEventListener('touchend', endPress);
  btn.addEventListener('mouseup', endPress);
  btn.addEventListener('mouseleave', function(){ clearTimeout(pressTimer); });
}

// =================== snapshot builders (order_items + snap_items) ===================
function readRowPhoto(row){ var img=row?.querySelector('.thumb'); return (img && img.src && img.style.display!=='none') ? img.src : null; }
function collectItems(order_id, now){
  var items=[], general=getStoredPrice()||0;
  $all('#list-tepiha .piece-row').forEach(function(row){
    var v=num(row.querySelector('.m2')?.value); if(v>0) items.push({ order_id, kind:'tepiha', m2:v, price:general, created_at:now });
  });
  $all('#list-staza .piece-row').forEach(function(row){
    var v=num(row.querySelector('.m2')?.value); if(v>0) items.push({ order_id, kind:'staza', m2:v, price:general, created_at:now });
  });
  var stair=stairsM2();
  if(stair>0){
    var pr=(stairs.price==null ? general : stairs.price);
    items.push({ order_id, kind:'shkallore', m2:stair, price:pr, created_at:now });
  }
  return items;
}
function collectSnapshot(){
  var snap=[];
  $all('#list-tepiha .piece-row').forEach(function(row){
    var v=num(row.querySelector('.m2')?.value), ph=readRowPhoto(row);
    if(v>0 || ph) snap.push({ kind:'tepiha', m2:v||0, photo:ph||null });
  });
  $all('#list-staza .piece-row').forEach(function(row){
    var v=num(row.querySelector('.m2')?.value), ph=readRowPhoto(row);
    if(v>0 || ph) snap.push({ kind:'staza', m2:v||0, photo:ph||null });
  });
  try{
    var stairsPhoto = sessionStorage.getItem('stairs_photo_thumb')||null;
    var sm2 = stairsM2();
    if(sm2>0 || stairsPhoto) snap.push({ kind:'shkallore', m2:sm2||0, photo:stairsPhoto });
  }catch(_){}
  return snap;
}

// =================== Supabase storage upload (public URL) ===================
var PHOTO_BUCKETS=['tapija-photos','tepiha-photos']; var PHOTO_BUCKET=PHOTO_BUCKETS[0];

async function uploadREST(orderId, dataURI){
  try{
    if(!dataURI || !dataURI.startsWith('data:')) return null;
    var m=dataURI.match(/^data:(image\/[\w.+-]+);base64,/), mime=m?m[1]:'image/jpeg';
    var bytes=Uint8Array.from(atob(dataURI.split(',')[1]||''), function(c){return c.charCodeAt(0);});
    var ext=(mime.split('/')[1]||'jpg').toLowerCase();
    var path=orderId+'/'+Date.now()+'.'+ext;
    var url=(window.SUPABASE_URL||'')+'/storage/v1/object/'+PHOTO_BUCKET+'/'+encodeURIComponent(path);
    var r=await fetch(url,{method:'PUT',headers:{apikey:window.SUPABASE_ANON,Authorization:'Bearer '+window.SUPABASE_ANON,'Content-Type':mime},body:bytes});
    if(!r.ok) return null;
    return (window.SUPABASE_URL||'')+'/storage/v1/object/public/'+PHOTO_BUCKET+'/'+encodeURIComponent(path);
  }catch(_){ return null; }
}
async function uploadClient(orderId, dataURI){
  var sb=window.supabase; if(!sb?.storage) return null;
  try{
    var m=dataURI.match(/^data:(image\/[\w.+-]+);base64,/), mime=m?m[1]:'image/jpeg';
    var bytes=Uint8Array.from(atob(dataURI.split(',')[1]||''), function(c){return c.charCodeAt(0);});
    var ext=(mime.split('/')[1]||'jpg').toLowerCase();
    var path=orderId+'/'+Date.now()+'.'+ext;
    var up=await sb.storage.from(PHOTO_BUCKET).upload(path, bytes, {contentType:mime, upsert:true});
    if(up?.error) return null;
    var pub=sb.storage.from(PHOTO_BUCKET).getPublicUrl(path);
    return pub?.data?.publicUrl || null;
  }catch(_){ return null; }
}
async function toUrlSnapshot(orderId, snap){
  var out=[];
  for(var i=0;i<(snap||[]).length;i++){
    var s=snap[i], url=s.photo||null;
    if(url && url.startsWith('data:')){
      url = await uploadREST(orderId, url) || await uploadClient(orderId, s.photo) || null;
    }
    if(!url) url=s.photo||null; // fallback: keep dataURI so reopening still works if storage blocked
    out.push({ kind:s.kind, m2:Number(s.m2||0), photo:url||null });
  }
  return out;
}

// =================== SAVE (retry once on duplicate) ===================
async function save(){
  var name=($('#name')?.value||'').trim();
  var phone=($('#phone')?.value||'').replace(/\D/g,'');
  if(!name) throw new Error('Shkruaj emrin');
  if(!phone) throw new Error('Shkruaj telefonin');

  for (var attempt=0; attempt<2; attempt++){
    var code = await ensureCode();
    var t = recalcTotals(); var now = nowISO();

    try{
      // 1) insert order
      var res = await insert('orders',{
        code, name, phone,
        price_per_m2: Number(t?.price_general||getStoredPrice()||0),
        m2: Number(t?.m2||0),
        pieces: Number(t?.pieces||0),
        total: Number(t?.euro_total||0),
        status:'pastrim',
        created_at: now, updated_at: now
      });
      var row = Array.isArray(res)?res[0]:res;
      var order_id = row && (row.id || row.order_id || row.uuid);
      if(!order_id) throw new Error('Order ID mungon');

      // 2) order_items
      var items = collectItems(order_id, now);
      if(items.length){ try{ await insert('order_items', items); }catch(_){ } }

      // 3) snap_items (photos → URLs)
      var snap = collectSnapshot();
      if(snap.length){
        var clean = await toUrlSnapshot(order_id, snap);
        await update('orders', { snap_items: clean, updated_at: nowISO() }, { id: order_id });
      }

      // 4) clean session thumbs + go
      try{ sessionStorage.removeItem('client_photo_thumb'); sessionStorage.removeItem('stairs_photo_thumb'); }catch(_){}
      location.href='/pastrimi/';
      return;
    }catch(err){
      var msg = (err && (err.message||err))+'';
      if (attempt===0 && /23505|duplicate key|unique/i.test(msg)){ // regenerate and retry once
        assignedCode = null;
        continue;
      }
      throw err;
    }
  }
}

// =================== INIT ===================
document.addEventListener('DOMContentLoaded', function(){
  ensureCode().catch(function(e){ alert('Gabim kodi: '+(e?.message||e)); });

  wireChips('chips-tepiha','tepiha');
  wireChips('chips-staza','staza');
  wireStairs();
  wireClientPhoto();

  // main buttons
  var go=$('#btnContinue'); if(go) go.addEventListener('click', function(e){ e.preventDefault(); save().catch(function(err){ alert('Ruajtja dështoi:\n'+(err?.message||err)); }); });
  var draft=$('#btnSaveDraft'); if(draft) draft.addEventListener('click', function(e){ e.preventDefault(); save().catch(function(err){ alert('Ruajtja dështoi:\n'+(err?.message||err)); }); });

  // first paint
  recalcSection('tepiha'); recalcSection('staza'); recalcTotals();
});