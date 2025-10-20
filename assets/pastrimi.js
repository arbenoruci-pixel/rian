// /assets/pastrimi.js — stable loader (no UI changes)
// Reads orders via window.select (from /assets/supabase.js) with REST fallback.
// Shows all non-"gati" orders, newest first. Click any code/name → /pranimi/?id=...&code=...

/* ---------- small helpers ---------- */
var $  = function(s,r){ return (r||document).querySelector(s); };
var $$ = function(s,r){ return [].slice.call((r||document).querySelectorAll ? (r||document).querySelectorAll(s) : []); };
var n2 = function(v){ return Number(v||0).toFixed(2); };


// Fallback: open client profile by ID if panel function is missing
window.openClientById = window.openClientById || function(orderId){
  if(!orderId){ alert('S’gjej ID për këtë porosi.'); return; }
  location.href = '/client_profile.html?id=' + encodeURIComponent(orderId);
};
function banner(msg){
  var el = $('#sb_err');
  if(!el){
    el = document.createElement('div');
    el.id='sb_err';
    el.style.cssText='position:fixed;right:12px;bottom:12px;z-index:9999;background:#a40e0e;border:1px solid #c11;color:#fff;padding:8px 12px;border-radius:10px;font-weight:900';
    document.body.appendChild(el);
  }
  el.textContent = 'SUPABASE: ' + (msg||'ERR');
  el.style.display = 'block';
  setTimeout(function(){ el.style.display = 'none'; }, 3500);
}

function daysAgo(iso){
  if(!iso) return 999;
  var d = new Date(iso);
  return Math.floor((Date.now() - d.getTime())/86400000);
}
function ageClass(iso){
  var d = daysAgo(iso);
  if(d<=0) return 'good';
  if(d===1) return 'warn';
  return 'bad';
}
function stageLabel(v){
  var s = String(v||'').toLowerCase();
  if(s==='laj' || s==='wash') return 'LAJ';
  if(s==='thaj' || s==='dry') return 'THAJ';
  if(s==='pako' || s==='pack') return 'PAKO';
  if(s==='radhe' || s==='queue' || s==='ne radhe') return 'RADHË';
  return 'RADHË';
}

/* ---------- Supabase helpers (window.select / window.update with REST fallback) ---------- */
async function sbSelect(table, params){
  try{
    if(typeof window.select === 'function'){
      var d = await window.select(table, params||{});
      if(Array.isArray(d)) return d;
      if(d && Array.isArray(d.data)) return d.data;
      return [];
    }
  }catch(_){}

  // REST fallback
  try{
    var base = (window.SUPABASE_URL||'').replace(/\/$/,'');
    var anon = window.SUPABASE_ANON||'';
    if(!base || !anon) return [];
    var url = new URL(base + '/rest/v1/' + table);
    Object.keys(params||{}).forEach(function(k){ url.searchParams.set(k, params[k]); });
    var r = await fetch(String(url), {
      headers: { apikey:anon, Authorization:'Bearer '+anon, Accept:'application/json' }
    });
    if(!r.ok) return [];
    return await r.json();
  }catch(e){
    console.error(e); return [];
  }
}

async function sbUpdate(table, patch, match){
  try{
    if(typeof window.update === 'function'){
      return await window.update(table, patch, match||{});
    }
  }catch(_){}
  // REST fallback
  try{
    var base = (window.SUPABASE_URL||'').replace(/\/$/,'');
    var anon = window.SUPABASE_ANON||'';
    if(!base || !anon) throw new Error('No Supabase keys');
    var url = new URL(base + '/rest/v1/' + table);
    Object.keys(match||{}).forEach(function(k){ url.searchParams.set(k, 'eq.'+String(match[k])); });
    var r = await fetch(String(url), {
      method:'PATCH',
      headers: {
        apikey:anon, Authorization:'Bearer '+anon,
        'Content-Type':'application/json', Prefer:'return=representation'
      },
      body: JSON.stringify(patch||{})
    });
    if(!r.ok) throw new Error('REST update '+r.status);
    return await r.json();
  }catch(e){
    console.error(e); banner('ERR'); throw e;
  }
}

/* ---------- row renderer ---------- */
function rowEl(o){
  var el = document.createElement('div');
  el.className = 'card';
  el.setAttribute('data-order-id', o.id||'');
  el.setAttribute('data-code', o.code||'');

  var label = stageLabel(o.stage);
  el.innerHTML =
    '<div class="head">'+
      // code + name are rendered as spans, we’ll attach a global click handler
      '<span class="code" data-code="'+(o.code||'')+'">'+(o.code||'')+'</span>'+
      '<span class="name">'+(o.name||'')+'</span>'+
      '<span class="pieces">'+(o.pieces||0)+' copë</span>'+
      '<span class="m2">'+n2(o.m2||0)+' m²</span>'+
      '<span class="total">€'+n2(o.total||0)+'</span>'+
      '<button class="stage badge">'+label+'</button>'+
      '<span class="age '+ageClass(o.stage_at||o.created_at)+'"></span>'+
    '</div>'+
    '<div class="actions">'+
      '<button class="det" data-client="'+(o.id||'')+'">📋 DETAJE</button>'+
      '<button class="sms">SMS</button>'+
      '<button class="go">▶ GATI</button>'+
    '</div>';

  // make code/name look clickable
  var codeEl = el.querySelector('.head .code');
  var nameEl = el.querySelector('.head .name');
  if(codeEl){ codeEl.style.cursor='pointer'; codeEl.title='Hap PRANIMI'; }
  if(nameEl){ nameEl.style.cursor='pointer'; nameEl.title='Hap PRANIMI'; }

  // tiny style touches (respect your CSS)
  $$('.badge', el).forEach(function(b){ b.style.cssText='background:#0b111d;border:1px solid #2c3a55;border-radius:999px;padding:6px 10px;font-weight:900;color:#e6f0ff'; });
  $$('.actions button', el).forEach(function(b){ b.style.cssText='border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#0c0f20;color:#e6f0ff;border:1px solid #2b3956'; });
  var go = el.querySelector('.go'); if(go) go.style.background = '#1e60ff';

  // DETAJE → open client panel (if you have it)
  var det = el.querySelector('.det');
  if(det) det.onclick = function(){ try{ window.openClientById && window.openClientById(o.id); } catch(e){} };

  // SMS
  var smsBtn = el.querySelector('.sms');
  if(smsBtn){
    smsBtn.onclick = function(){
      var phone = String(o.phone||'').replace(/\D/g,'');
      if(!phone) { alert('S’ka telefon'); return; }
      var txt = 'Përshëndetje '+(o.name||'')+', tepihet me kod '+(o.code||'')+' janë gati. Totali: €'+n2(o.total||0)+'.';
      location.href = 'sms:' + phone + '?&body=' + encodeURIComponent(txt);
    };
  }

  // GATI
  if(go){
    go.onclick = async function(){
      try{
        await sbUpdate('orders', { status:'gati', stage:'pako', stage_at: new Date().toISOString() }, { id:o.id });
        el.style.opacity = .4; setTimeout(function(){ el.remove(); }, 300);
      }catch(_){ banner('ERR'); }
    };
  }

  return el;
}

/* ---------- stats ---------- */
function renderStats(rows){
  var sumM2 = rows.reduce(function(s,x){ return s + Number(x.m2||0); }, 0);
  var bar = document.createElement('div');
  bar.style.cssText='display:flex;flex-wrap:wrap;gap:12px;margin:6px 0';
  bar.innerHTML =
    '<div class="pill">🧾 '+rows.length+' porosi</div>'+
    '<div class="pill">📐 '+n2(sumM2)+' m²</div>'+
    '<div class="pill">Radhë: '+rows.filter(function(x){ return /radhe|queue/i.test(String(x.stage)); }).length+'</div>'+
    '<div class="pill">Laj: '+rows.filter(function(x){ return /laj|wash/i.test(String(x.stage)); }).length+'</div>'+
    '<div class="pill">Thaj: '+rows.filter(function(x){ return /thaj|dry/i.test(String(x.stage)); }).length+'</div>'+
    '<div class="pill">Pako: '+rows.filter(function(x){ return /pako|pack/i.test(String(x.stage)); }).length+'</div>'+
    '<button id="btnRefresh" class="pill">↻ Rifresko</button>';
  var host = $('#stats'); if(host){ host.innerHTML=''; host.appendChild(bar); }
  var btn = $('#btnRefresh'); if(btn) btn.onclick = render;
}

/* ---------- main render ---------- */
async function render(){
  try{
    // 1) fetch newest orders
    var rows = await sbSelect('orders', { select:'*', order:'created_at.desc' });
    if(!Array.isArray(rows)) rows = [];

    // 2) show all NOT gati (so you still see pastrim + anything in progress)
    rows = rows.filter(function(o){ return String(o.status||'').toLowerCase() !== 'gati'; });

    // 3) fallback: if nothing, at least show latest 50 so page isn't empty
    if(!rows.length){
      rows = await sbSelect('orders', { select:'*', order:'created_at.desc', limit:'50' });
      if(!Array.isArray(rows)) rows = [];
    }

    renderStats(rows);

    var host = $('#list');
    if(!host) return;
    host.innerHTML = '';
    rows.forEach(function(o){
      var el = rowEl(o);
      // set data attributes for global click handler
      el.setAttribute('data-order-id', o.id||'');
      el.setAttribute('data-code', o.code||'');
      host.appendChild(el);
    });

  }catch(e){
    console.error(e);
    banner('ERR');
  }
}

/* ---------- boot ---------- */
document.addEventListener('DOMContentLoaded', function(){
  if(!$('#stats')){ var s=document.createElement('div'); s.id='stats'; document.body.prepend(s); }
  if(!$('#list')){ var l=document.createElement('div'); l.id='list'; document.body.appendChild(l); }
  render();
});

/* ---------- open PRANIMI when clicking code or name ---------- */
document.addEventListener('click', function(e){
  var t = e.target.closest('.head .code, .head .name');
  if(!t) return;
  var card = t.closest('.card');
  if(!card) return;
  var id   = card.getAttribute('data-order-id') || '';
  var code = card.getAttribute('data-code') || '';
  if(!id){ alert('S’gjej ID për këtë porosi.'); return; }
  // Open by ID (safe) and include code as a hint for the badge
  location.href = '/client_profile.html?id=' + encodeURIComponent(id) + (code ? '&code=' + encodeURIComponent(code) : '');
});