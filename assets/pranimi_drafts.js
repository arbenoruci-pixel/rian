// /assets/pranimi_drafts.js — Incomplete PRANIMI orders (tailored for /assets/supabase.js REST helpers)
/*
  Reads via window.select() provided by your /assets/supabase.js.
  Server-side filter: status IN (pastrim, radhe, queue); newest first.
  Client-side filter: consider "incomplete" if total==0 OR m2==0 OR pieces==0.
  Each row has ▶ VAZHDO to reopen in PRANIMI (falls back to /pranimi/?id=<id>).
*/

(function(){
  function $(s, r){ return (r||document).querySelector(s); }
  function n2(v){ return Number(v||0).toFixed(2); }
  function fmtDate(iso){ try{ const d=new Date(iso); return d.toLocaleString(); } catch(_){ return iso||''; } }
  function banner(msg){
    var el = $('#drafts_err');
    if (!el){ el = document.createElement('div'); el.id='drafts_err';
      el.style.cssText='position:fixed;right:12px;bottom:12px;z-index:9999;background:#a40e0e;border:1px solid #c11;color:#fff;padding:8px 12px;border-radius:10px;font-weight:900';
      document.body.appendChild(el);
    }
    el.textContent='SUPABASE: ' + (msg||'ERR');
    el.style.display='block'; setTimeout(function(){ el.style.display='none'; }, 3000);
  }

  // --- what counts as "incomplete intake"
  function isIncomplete(o){
    var tot0 = Number(o.total||0)  <= 0.00001;
    var m20  = Number(o.m2||0)     <= 0.00001;
    var pc0  = Number(o.pieces||0) <= 0;
    return tot0 || m20 || pc0;
  }

  function row(o){
    var el = document.createElement('div');
    el.className='card';
    el.style.cssText='border:1px solid #273143;background:#0c0f16;border-radius:14px;padding:10px;margin:10px 0';

    el.innerHTML = '\
      <div class="head" style="display:grid;grid-template-columns:auto 1fr auto auto auto;gap:8px;align-items:center">\
        <span class="code" style="font-weight:1000">'+(o.code||'')+'</span>\
        <span class="name">'+String(o.name||'').slice(0,40)+'</span>\
        <span class="pieces">'+(o.pieces||0)+' copë</span>\
        <span class="m2">'+n2(o.m2||0)+' m²</span>\
        <span class="date" title="'+(o.created_at||'')+'">'+fmtDate(o.created_at)+'</span>\
      </div>\
      <div class="actions" style="display:flex;gap:8px;margin-top:8px">\
        <button class="open" style="border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#1e60ff;color:#fff">▶ VAZHDO</button>\
        <button class="details" style="border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#0c0f20;color:#e6f0ff;border:1px solid #2b3956">📋 DETAJE</button>\
      </div>';

    el.querySelector('.open').onclick = function(){
      try { if (typeof window.openClientById==='function') return window.openClientById(o.id); } catch(e){}
      try { location.href = '/pranimi/?id=' + encodeURIComponent(o.id); } catch(e){}
    };
    el.querySelector('.details').onclick = function(){
      try { window.openClientById && window.openClientById(o.id); } catch(e){}
    };
    return el;
  }

  function renderStats(rows){
    var wrap = $('#drafts_stats'); if (!wrap) { wrap=document.createElement('div'); wrap.id='drafts_stats'; document.body.prepend(wrap); }
    wrap.innerHTML='';
    var bar = document.createElement('div');
    bar.style.cssText='display:flex;flex-wrap:wrap;gap:12px;margin:6px 0';
    bar.innerHTML = '\
      <div class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">📝 <span id="cntDrafts">'+rows.length+'</span> pranimet e paplotesuara</div>\
      <input id="draftsSearch" placeholder="Kërko: kod/emër/telefon" style="flex:1;min-width:200px;background:#070a12;border:2px solid #2c3954;border-radius:12px;padding:8px 10px;color:#fff;font-weight:900">\
      <button id="draftsRefresh" class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">↻</button>\
    ';
    wrap.appendChild(bar);
  }

  function matches(o,q){
    if (!q) return true;
    q=String(q).toLowerCase().trim();
    return String(o.code||'').toLowerCase().indexOf(q)>=0 ||
           String(o.name||'').toLowerCase().indexOf(q)>=0 ||
           String(o.phone||'').replace(/\D/g,'').indexOf(q.replace(/\D/g,''))>=0;
  }

  async function fetchIntakes(){
    // Server-side filter using PostgREST params supported by your select()
    // status in (pastrim,radhe,queue), newest first
    var params = {
      select: '*',
      order:  'created_at.desc',
      status: 'in.(pastrim,radhe,queue)'
    };
    try {
      var rows = await (window.select ? window.select('orders', params) : []);
      if (!Array.isArray(rows)) rows = [];
      return rows;
    } catch(e){
      console.error(e); banner('ERR'); return [];
    }
  }

  async function render(){
    var rows = await fetchIntakes();
    // client-side "incomplete" check
    rows = rows.filter(isIncomplete).sort(function(a,b){
      return String(b.created_at||'').localeCompare(String(a.created_at||''));
    });

    if (!$('#drafts_stats')) { var s=document.createElement('div'); s.id='drafts_stats'; document.body.prepend(s); }
    if (!$('#drafts_list'))  { var l=document.createElement('div'); l.id='drafts_list'; document.body.appendChild(l); }

    renderStats(rows);

    var q = $('#draftsSearch') ? $('#draftsSearch').value : '';
    var filtered = rows.filter(function(o){ return matches(o,q); });

    var host = $('#drafts_list'); host.innerHTML = '';
    if (!filtered.length){
      var d=document.createElement('div'); d.style.cssText='opacity:.7;padding:20px;text-align:center;border:1px dashed #2c3954;border-radius:12px';
      d.textContent='S’ka pranimet e paplotesuara.'; host.appendChild(d);
    } else {
      filtered.forEach(function(o){ host.appendChild(row(o)); });
    }

    var rf=$('#draftsRefresh'); if (rf) rf.onclick = render;
    var ds=$('#draftsSearch');  if (ds) ds.oninput = function(){ render(); };
  }

  document.addEventListener('DOMContentLoaded', function(){ render(); });
})();
