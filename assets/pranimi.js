// ================= PRANIMI — FULL ENGINE (Supabase RPC code) =================
// Reads the ticket code strictly from Supabase (rpc: next_code_num), then
// handles chips, rows, stairs, client photo, totals, SMS/WA/Viber, payment,
// and finally save() which INSERTs a new order row.
// No ES module imports required — relies on /assets/supabase.js window shim:
//   window.rpc, window.insert, window.update, window.nowISO
// Compatible with older Safari/iOS (no optional chaining).

/* ----------------------------- helpers ------------------------------------ */
function $(sel, root){ return (root||document).querySelector(sel); }
function $all(sel, root){ return Array.prototype.slice.call((root||document).querySelectorAll(sel)); }
function num(v){ var n = parseFloat(String(v==null?'':v).replace(',', '.')); return isFinite(n) ? n : 0; }
function digits(v){ return String(v==null?'':v).replace(/\D/g,''); }
function nowISO(){ try{ return window.nowISO ? window.nowISO() : new Date().toISOString(); }catch(_){return new Date().toISOString();} }

/* ---- one-time visible error (handy while stabilizing; safe to remove) ----- */
window.addEventListener('error', function(e){
  var d=document.createElement('div');
  d.style='position:fixed;left:0;right:0;top:0;z-index:99999;background:#300;color:#fff;padding:8px;font:14px system-ui';
  d.textContent='[JS] '+(e.message || (e.error&&e.error.message) || 'unknown');
  document.body.appendChild(d);
},{once:true});

/* ---------------------------- CODE (from Supabase) ------------------------- */
// We ONLY fetch the code from Supabase RPC `next_code_num`. No local generation.
var assignedCode = null;
function ensureCode(){
  if (assignedCode) return Promise.resolve(assignedCode);

  // REQUIRE: your database function `next_code_num()` must return the next code.
  // It can return either a scalar or an object/array containing next_code/code/id.
  return rpc('next_code_num', {}).then(function(r){
    var code = r;
    if (Array.isArray(r)) {
      var it = r[0];
      code = (it && typeof it==='object') ? (it.next_code || it.code || it.id) : it;
    } else if (r && typeof r==='object') {
      code = r.next_code || r.code || r.id;
    }
    assignedCode = digits(code);
    if (!assignedCode) throw new Error('Kodi nuk u gjenerua nga Supabase');

    var b = $('#ticketCode') || $('.badge.kodi');
    if (b) { b.setAttribute('data-code', assignedCode); b.textContent = 'KODI: ' + assignedCode; }
    return assignedCode;
  });
}

/* --------------------------- CAMERA SQUARE (1:1) --------------------------- */
function setupCamSquare(btn, storageKey){
  if (!btn) return;
  var existing = btn.querySelector('img.thumb');
  var thumb = existing || document.createElement('img');
  thumb.className = 'thumb';
  thumb.alt = '';
  thumb.style.position='absolute'; thumb.style.inset='0';
  thumb.style.width='100%'; thumb.style.height='100%';
  thumb.style.objectFit='cover'; thumb.style.borderRadius='10px';
  thumb.style.display = existing ? existing.style.display : 'none';
  thumb.style.zIndex='2';
  if (!existing) btn.appendChild(thumb);
  if (!btn.style.position) btn.style.position='relative';

  if (storageKey) {
    try { var saved = sessionStorage.getItem(storageKey);
      if (saved) { thumb.src=saved; thumb.style.display='block'; }
    } catch(e){}
  }

  btn.addEventListener('click', function(e){
    e.preventDefault();
    var input=document.createElement('input');
    input.type='file'; input.accept='image/*;capture=camera'; input.setAttribute('capture','environment');
    input.style.display='none'; document.body.appendChild(input);
    input.addEventListener('change', function(){
      var f=input.files && input.files[0]; if(!f){ if(input.parentNode) input.parentNode.removeChild(input); return; }
      var rd=new FileReader();
      rd.onload=function(){
        var data=String(rd.result||''); thumb.src=data; thumb.style.display='block';
        if (storageKey){ try{ sessionStorage.setItem(storageKey, data); }catch(e){} }
        if(input.parentNode) input.parentNode.removeChild(input);
      };
      rd.readAsDataURL(f);
    });
    input.click();
  });
}

/* ---------------------------- CLIENT PHOTO --------------------------------- */
function wireClientPhoto(){
  var label=document.querySelector('label.cam-btn'); if(!label) return;
  setupCamSquare(label, 'client_photo_thumb'); // session-based to avoid leaking to next client
}

/* ---------------------------- ROWS (tepiha/staza) -------------------------- */
function makeRow(m2){
  var row=document.createElement('div');
  row.className='piece-row';
  row.innerHTML =
    '<div class="left">' +
      '<input class="input piece-input m2" inputmode="decimal" placeholder="m²" value="'+(m2!=null?m2:'')+'">' +
      '<div class="cam-holder" style="position:relative">' +
        '<button class="cam-btn" type="button" title="Foto">📷</button>' +
        '<img class="thumb" alt="" style="display:none">' +
      '</div>' +
    '</div>';
  return row;
}
function listHolder(kind){ return $('#list-'+kind); }

window.addRow=function(kind,m2){
  var h=listHolder(kind); if(!h) return;
  var row=makeRow(m2); h.appendChild(row);
  var camBtn=row.querySelector('.cam-btn'); if(camBtn) setupCamSquare(camBtn, null);
  recalcSection(kind); recalcTotals();
};
window.removeRow=function(kind){
  var h=listHolder(kind); if(h && h.lastElementChild) h.removeChild(h.lastElementChild);
  recalcSection(kind); recalcTotals();
};

function sectionSum(kind){
  var h=listHolder(kind); if(!h) return {m2:0,pieces:0};
  var sum=0, pcs=0;
  $all('.m2',h).forEach(function(i){ var v=num(i.value); if(v>0){ sum+=v; pcs++; } });
  return { m2:sum, pieces:pcs };
}
function recalcSection(kind){
  var out=$('#tot-'+kind), s=sectionSum(kind);
  if (out) out.textContent = s.m2.toFixed(2) + ' m²';
}

/* -------------------------------- SHKALLORE -------------------------------- */
var stairs = { qty:0, per:0.3, price:null, photo:null };
function stairsM2(){ return Math.max(0, (stairs.qty||0) * (stairs.per||0)); }
function openStairs(){
  var sec=$('#sec-shkallore'); if(!sec) return;
  var old=$('#stairsBox'); if(old && old.parentNode) old.parentNode.removeChild(old);
  var box=document.createElement('div');
  box.id='stairsBox';
  box.style.cssText='margin-top:10px;border:1px solid #273143;border-radius:12px;padding:10px;background:#0b111d';
  box.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;align-items:center">' +
      '<input id="stairsQty"  class="input" inputmode="numeric" placeholder="copë" value="'+(stairs.qty||'')+'" style="min-height:44px;border-width:1px">' +
      '<input id="stairsPer"  class="input" inputmode="decimal" placeholder="m²/copë p.sh. 0.3" value="'+(stairs.per||0.3)+'" style="min-height:44px;border-width:1px">' +
      '<input id="stairsPrice" class="input" inputmode="decimal" placeholder="€/m² (ops.)" value="'+(stairs.price==null?'':stairs.price)+'" style="min-height:44px;border-width:1px">' +
      '<button id="stairsCamBtn" class="cam-btn" type="button" title="Foto shkallore" style="position:relative">📷</button>' +
    '</div>' +
    '<div style="margin-top:8px;display:flex;gap:8px;align-items:center">' +
      '<div style="flex:1;opacity:.9">M² shkallore: <b id="stairsM2Lbl">'+stairsM2().toFixed(2)+'</b></div>' +
      '<button id="stairsClose" class="btn ghost" type="button" style="min-height:40px">Mbyll</button>' +
    '</div>';
  sec.appendChild(box);

  var qty=$('#stairsQty'), per=$('#stairsPer'), pr=$('#stairsPrice'), cam=$('#stairsCamBtn');
  if (cam) setupCamSquare(cam, 'stairs_photo_thumb');

  function sync(){
    stairs.qty   = Math.max(0, Math.floor(num(qty.value)));
    stairs.per   = Math.max(0, num(per.value));
    stairs.price = (pr.value==='' ? null : num(pr.value));
    var lbl=$('#stairsM2Lbl'); if (lbl) lbl.textContent=stairsM2().toFixed(2);
    var out=$('#stairsM2'); if (out) out.textContent=stairsM2().toFixed(2)+' m²';
    recalcTotals();
  }
  qty.addEventListener('input',sync); per.addEventListener('input',sync); pr.addEventListener('input',sync);
  $('#stairsClose').addEventListener('click', function(){ if(box.parentNode) box.parentNode.removeChild(box); });
}
function wireOpenStairs(){ var btn=$('#openStairs'); if(btn) btn.addEventListener('click', openStairs); }

/* ------------------------- €/m² storage + prompt --------------------------- */
function getStoredPrice(){
  var s = localStorage.getItem('price_per_m2');
  return s==null ? 0 : num(s);
}
function setStoredPrice(v){
  var n = num(v);
  try { localStorage.setItem('price_per_m2', String(n)); } catch(e){}
  var hidden = $('#pricePerM2'); if(!hidden){ hidden=document.createElement('input'); hidden.type='hidden'; hidden.id='pricePerM2'; document.body.appendChild(hidden); }
  hidden.value = String(n);
}
function promptSetPrice(defaultVal){
  var cur = getStoredPrice() || (defaultVal||0);
  var v = window.prompt('Çmimi (€) për m² (për tepiha & staza):', cur);
  if (v===null) return false;
  setStoredPrice(v);
  recalcTotals();
  return true;
}

/* -------------------------------- CHIPS ------------------------------------ */
function parseM2Label(label){ var m=String(label).match(/([\d.]+)\s*m²/i); return m ? num(m[1]) : null; }
function wireChips(holderId, kind){
  var h = document.getElementById(holderId); if(!h) return;
  h.addEventListener('click', function(e){
    var btn = e.target.closest ? e.target.closest('.chip') : null; if(!btn) return;
    var label = btn.textContent.trim();
    if (/manual/i.test(label)) { addRow(kind, null); return; }
    var v = parseM2Label(label); if (v!=null) addRow(kind, v);
  });
  $all('.chip',h).forEach(function(c){ c.style.pointerEvents='auto'; });
}

/* -------------------------------- TOTALS ----------------------------------- */
function recalcTotals(){
  var t = sectionSum('tepiha');
  var s = sectionSum('staza');
  var stair = stairsM2();

  var m2Total = t.m2 + s.m2 + stair;
  var m2TotEl = $('#m2Total'); if (m2TotEl) m2TotEl.textContent = m2Total.toFixed(2);
  var tt = $('#tot-tepiha'); if (tt) tt.textContent = t.m2.toFixed(2) + ' m²';
  var ts = $('#tot-staza');  if (ts) ts.textContent = s.m2.toFixed(2) + ' m²';
  var sm = $('#stairsM2');   if (sm) sm.textContent = stair.toFixed(2) + ' m²';

  var priceInp = $('#pricePerM2');
  if (!priceInp) { priceInp=document.createElement('input'); priceInp.type='hidden'; priceInp.id='pricePerM2'; document.body.appendChild(priceInp); }
  if (!priceInp.value && localStorage.getItem('price_per_m2')) priceInp.value = localStorage.getItem('price_per_m2');
  var general = num(priceInp.value);

  var stairPrice = (stairs.price==null ? general : stairs.price);
  var euro = (t.m2 + s.m2) * general + stair * stairPrice;
  var eurEl = $('#euroTotal'); if (eurEl) eurEl.textContent = euro.toFixed(2);

  window.__TOTALS__ = {
    m2: m2Total,
    pieces: t.pieces + s.pieces + (stairs.qty||0),
    price_general: general,
    price_stairs: stairPrice,
    euro_total: euro
  };
  return window.__TOTALS__;
}
window.recalcTotals = recalcTotals;

// live recalcs
document.addEventListener('input', function(e){
  var t = e.target || e.srcElement;
  if (t && t.classList && t.classList.contains('m2')) {
    if (t.closest && t.closest('#list-tepiha')) recalcSection('tepiha');
    if (t.closest && t.closest('#list-staza'))  recalcSection('staza');
    recalcTotals();
  }
});

/* --------------------------- SMS / WA / Viber ------------------------------ */
function buildClientMessage(d){
  return 'Përshëndetje '+(d.name||'')+',\n'+
'Procesi i pastrimit ka filluar.\n'+
'Ju keni '+(d.pieces)+' copë me gjithsej '+Number(d.m2).toFixed(2)+' m².\n'+
'Totali: '+Number(d.total).toFixed(2)+'€.\n'+
'Kodi: '+d.code+'.\n'+
'Do t’ju njoftojmë kur të jenë gati për marrje.\n'+
'Faleminderit!';
}
function wireSmsButtons(){
  var btn = $('#btnSms'); if(!btn) return;
  var timer=null, longPressed=false;
  function start(){ longPressed=false; timer=setTimeout(function(){ longPressed=true; openAlt(); },450); }
  function end(){ clearTimeout(timer); if(!longPressed) openSms(); }
  btn.addEventListener('touchstart', start, {passive:true});
  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchend', end);
  btn.addEventListener('mouseup', end);
  btn.addEventListener('mouseleave', function(){ clearTimeout(timer); });
  function getData(){
    return ensureCode().then(function(code){
      var name=($('#name')&&$('#name').value||'').trim();
      var phone=($('#phone')&&$('#phone').value||'').replace(/\D/g,'');
      var t=recalcTotals()||{m2:0,pieces:0,euro_total:0};
      return { name:name, phone:phone, code:code, pieces:(t.pieces||0), m2:Number(t.m2||0), total:Number(t.euro_total||0) };
    });
  }
  function openSms(){ getData().then(function(d){ if(!d.phone){ alert('Shkruaj telefonin'); return; } var body=buildClientMessage(d); location.href='sms:'+d.phone+'?&body='+encodeURIComponent(body); }); }
  function openAlt(){ getData().then(function(d){ if(!d.phone){ alert('Shkruaj telefonin'); return; } var text=encodeURIComponent(buildClientMessage(d)); var wa='whatsapp://send?phone='+d.phone+'&text='+text; var vb='viber://chat?number='+d.phone+'&text='+text; location.href=wa; setTimeout(function(){ try{ location.href=vb; }catch(e){} },600); }); }
}

/* ----------------------------- PAYMENT UI --------------------------------- */
var payState = { isPaid:false, amount:0, method:'cash', note:'' };

function ensurePayOverlay(){
  var ex=$('#pay-ov'); if(ex) return ex;
  var wrap=document.createElement('div'); wrap.id='pay-ov';
  wrap.innerHTML =
'<style id="pay-css">#pay-ov{position:fixed;inset:0;background:rgba(3,6,12,.88);backdrop-filter:blur(6px);display:none;align-items:flex-start;justify-content:center;padding:12px;z-index:9999}'+
'#pay-card{background:#0c0f16;border:1px solid #273143;border-radius:16px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.55);width:min(860px,100%);max-height:calc(100vh - 24px);overflow:auto;color:#fff;font-family:ui-rounded,system-ui,-apple-system,Segoe UI,Roboto,Arial}'+
'#pay-card .row{display:grid;grid-template-columns:2fr 1fr;gap:12px}@media (max-width:740px){#pay-card .row{grid-template-columns:1fr}}'+
'#pay-card .pill{display:flex;justify-content:space-between;align-items:center;background:#0b111d;border:1px solid #273143;border-radius:12px;padding:12px 14px;font-weight:1000}'+
'#pay-card .chips{display:flex;flex-wrap:wrap;gap:12px;margin-top:10px}'+
'#pay-card .chip{border:2px solid transparent;border-radius:999px;padding:12px 16px;min-height:44px;font-weight:1000;cursor:pointer;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.4)}'+
'#pay-close{border:2px solid #2b3956;background:#0c1220;color:#e6f0ff;min-height:40px;border-radius:12px;padding:8px 12px;font-weight:1000}'+
'#pay-confirm{background:#1e60ff;color:#fff;border:0;border-radius:14px;padding:14px 18px;min-height:48px;font-weight:1000}'+
'.kthimOK{color:#d7ffe7}.mungese{color:#ffb3b3}'+
'.chip[data-add="5"]{background:#9ea4aa;color:#000}.chip[data-add="10"]{background:#e14b4b;color:#fff}.chip[data-add="20"]{background:#3a7ee1;color:#fff}.chip[data-add="50"]{background:#e08b39;color:#000}.chip[data-add="100"]{background:#2bb673;color:#fff}.chip[data-exact]{background:#1e60ff;color:#fff}.chip[data-clear]{background:#0b111d;color:#e6f0ff;border:2px solid #2c3a55}</style>'+
'<div id="pay-shell" style="position:relative;display:flex;align-items:flex-start;justify-content:center">'+
  '<div id="pay-card">'+
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;position:sticky;top:0;background:#0c0f16;z-index:1">'+
      '<div style="font-size:22px;font-weight:1000">Pagesa</div>'+
      '<button id="pay-close">Mbyll</button>'+
    '</div>'+
    '<div class="pill" style="margin-bottom:10px"><b>Detyrim:</b> <span id="pay-due" style="font-size:1.5rem">€0.00</span></div>'+
    '<div class="row">'+
      '<div>'+
        '<div style="background:#0c0f16;border:1px solid #273143;border-radius:16px;padding:12px">'+
          '<div style="font-weight:900;margin-bottom:8px;opacity:.85">Sa dha klienti</div>'+
          '<div id="pay-given"  class="pill" style="font-size:1.2rem;margin-bottom:8px"><b>Dha:</b><span>€0.00</span></div>'+
          '<div id="pay-change" class="pill" style="font-size:1.2rem"><b>Kthim:</b><span>€0.00</span></div>'+
          '<div id="pay-chips" class="chips">'+
            '<button class="chip" data-add="5">+€5</button>'+
            '<button class="chip" data-add="10">+€10</button>'+
            '<button class="chip" data-add="20">+€20</button>'+
            '<button class="chip" data-add="50">+€50</button>'+
            '<button class="chip" data-add="100">+€100</button>'+
            '<button class="chip" data-exact="1">SAKTË</button>'+
            '<button class="chip" data-clear="1">PASTRO</button>'+
          '</div>'+
        '</div>'+
      '</div>'+
      '<div>'+
        '<div style="background:#0c0f16;border:1px solid #273143;border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:10px">'+
          '<div style="font-weight:900;opacity:.85">Metoda</div>'+
          '<div class="chips"><div class="chip" style="outline:3px solid rgba(52,211,153,.5)">Cash</div></div>'+
          '<textarea id="pay-note" placeholder="Shënim (opsionale)" style="height:100px;background:#070a12;border:2px solid #2c3954;border-radius:14px;padding:12px 14px;font-size:1.05rem;font-weight:900;color:#fff;outline:none"></textarea>'+
          '<button id="pay-confirm">✅ E paguar në fillim (cash)</button>'+
          '<div style="font-size:.9rem;color:#b9c4da">Dritare miqësore për celularë.</div>'+
        '</div>'+
      '</div>'+
    '</div>'+
  '</div>'+
'</div>';
  document.body.appendChild(wrap);
  return wrap;
}

function showPayOverlay(){
  var ov=ensurePayOverlay();

  // Ensure €/m² exists on phones (localStorage can be empty)
  var totalsBefore = recalcTotals();
  if ((totalsBefore && totalsBefore.m2 || 0) > 0 && (!getStoredPrice() || getStoredPrice()<=0)) {
    promptSetPrice(5); recalcTotals();
  }

  var dueLbl=$('#pay-due', ov), givenLbl=$('#pay-given span', ov), changeLbl=$('#pay-change span', ov), changeB=$('#pay-change b', ov);
  var t=recalcTotals(); var due=Number((t&&t.euro_total)||0); var given=0;

  function fmt(n){ return '€'+Number(n||0).toFixed(2); }
  function render(){
    if(dueLbl) dueLbl.textContent=fmt(due);
    if(givenLbl) givenLbl.textContent=fmt(given);
    var diff=given-due;
    if(diff>=0){ if(changeB) changeB.textContent='Kthim:'; if(changeLbl){ changeLbl.textContent=fmt(diff); changeLbl.className='kthimOK'; } }
    else { if(changeB) changeB.textContent='Mungesë:'; if(changeLbl){ changeLbl.textContent=fmt(-diff); changeLbl.className='mungese'; } }
  }

  var chips=$('#pay-chips', ov); if (chips) chips.onclick=function(e){
    var c=e.target.closest?e.target.closest('.chip'):null; if(!c) return;
    if(c.dataset && c.dataset.add) given+=Number(c.dataset.add);
    else if(c.dataset && c.dataset.exact) given=due;
    else if(c.dataset && c.dataset.clear) given=0;
    render();
  };
  var cbtn=$('#pay-close', ov); if (cbtn) cbtn.onclick=function(){ ov.style.display='none'; };
  var conf=$('#pay-confirm', ov); if (conf) conf.onclick=function(){
    payState.isPaid=true; payState.amount=given; payState.method='cash';
    var noteEl=$('#pay-note', ov); payState.note=noteEl?(noteEl.value||'').trim():'';
    ov.style.display='none';
    var el=document.createElement('div'); el.textContent='✅ E paguar në fillim: '+fmt(given);
    el.style='position:fixed;left:50%;transform:translateX(-50%);bottom:90px;background:#0c1220;border:1px solid #2b3956;padding:8px 12px;border-radius:10px;color:#d7ffe7;font-weight:900;z-index:99999';
    document.body.appendChild(el); setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); },1600);
  };

  render(); ov.style.display='flex';
}

/* --------------- wire € (tap=open overlay, long-press=set €/m²) ------------ */
function wireEuro(){
  var btn=$('#openPay'); if(!btn) return;
  var timer=null,longPressed=false;
  function start(){ longPressed=false; timer=setTimeout(function(){ longPressed=true; promptSetPrice(getStoredPrice()||5); },600); }
  function end(){ clearTimeout(timer); if(!longPressed){ recalcTotals(); showPayOverlay(); } }
  btn.addEventListener('touchstart', start, {passive:true});
  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchend', end);
  btn.addEventListener('mouseup', end);
  btn.addEventListener('mouseleave', function(){ clearTimeout(timer); });
}

/* --------------------------------- SAVE ------------------------------------ */
// Insert a brand-new order row (AFTER we have the Supabase code from RPC).
function save(){
  var name=($('#name')&&$('#name').value||'').trim();
  var phone=($('#phone')&&$('#phone').value||'').replace(/\D/g,'');
  return ensureCode().then(function(c){
    var code=digits(c);
    if(!name) throw new Error('Shkruaj emrin');
    if(!phone) throw new Error('Shkruaj telefonin');
    if(!/^\d+$/.test(code)) throw new Error('Kodi pritet numer');

    var t=recalcTotals(), now=nowISO();
    return insert('orders', {
      code:code, name:name, phone:phone,
      price_per_m2: Number((t&&t.price_general) || getStoredPrice() || 0),
      m2: Number((t&&t.m2)||0),
      pieces: Number((t&&t.pieces)||0),
      total: Number((t&&t.euro_total)||0),
      status:'pastrim',
      is_paid: !!payState.isPaid,
      paid_amount: payState.isPaid ? Number(payState.amount||0) : 0,
      paid_method: payState.isPaid ? 'cash' : null,
      paid_note: payState.isPaid ? (payState.note || null) : null,
      created_at: now, updated_at: now
    }).then(function(){
      try{ sessionStorage.removeItem('client_photo_thumb'); sessionStorage.removeItem('stairs_photo_thumb'); }catch(e){}
      location.href='/pastrimi/';
    });
  });
}

/* --------------------------------- INIT ------------------------------------ */
document.addEventListener('DOMContentLoaded', function(){
  // Show code from Supabase ASAP
  ensureCode().catch(function(e){
    var b=$('#ticketCode')||$('.badge.kodi');
    if(b) b.textContent='KODI: ?';
    alert('Gabim kodi (Supabase): '+(e&&e.message?e.message:e));
  });

  wireChips('chips-tepiha','tepiha');
  wireChips('chips-staza','staza');
  wireOpenStairs();

  wireClientPhoto();
  document.addEventListener('click', function(e){
    var cam=e.target.closest?e.target.closest('.piece-row .cam-btn'):null;
    if(cam && !cam.__wired__){ setupCamSquare(cam, null); cam.__wired__=true; }
  });

  wireSmsButtons();
  wireEuro();

  var go=$('#btnContinue');
  if(go) go.addEventListener('click', function(e){ e.preventDefault(); save().catch(function(err){ alert('Ruajtja dështoi:\n'+(err&&err.message?err.message:err)); }); });

  recalcSection('tepiha'); recalcSection('staza'); recalcTotals();
});