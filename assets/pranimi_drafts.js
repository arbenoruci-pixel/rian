// /assets/pranimi_drafts.js — Show only newly saved *intake* orders that are incomplete
// Criteria (tweakable): status='pastrim' AND (total=0 OR pieces=0 OR m2=0).
// Goal: let staff re-open these and complete the details later.
// Works with /assets/supabase.js (window.select/update) OR direct supabase-js.

(function(){
  function $(s, r){ return (r||document).querySelector(s); }
  function n2(v){ return Number(v||0).toFixed(2); }
  function fmtDate(iso){ try{ const d=new Date(iso); return d.toLocaleString(); }catch(_){return iso||'';} }

  // ---------- Supabase helpers ----------
  async function sbSelect(table, query) {
    try {
      if (typeof window.select === 'function') {
        const res = await window.select(table, query||{});
        if (Array.isArray(res)) return res;
        if (res && Array.isArray(res.data)) return res.data;
        return [];
      }
    } catch(_) {}
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const url = window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL;
    const key = window.SUPABASE_ANON || window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sb  = createClient(url, key);
    let q = sb.from(table).select('*').order('created_at', { ascending:false });
    const { data, error } = await q;
    if (error) throw error;
    return data||[];
  }

  function banner(msg){
    var el = $('#drafts_err');
    if (!el){
      el = document.createElement('div');
      el.id='drafts_err';
      el.style.cssText='position:fixed;right:12px;bottom:12px;z-index:9999;background:#a40e0e;border:1px solid #c11;color:#fff;padding:8px 12px;border-radius:10px;font-weight:900';
      document.body.appendChild(el);
    }
    el.textContent = 'SUPABASE: ' + (msg||'ERR');
    el.style.display='block';
    setTimeout(function(){ el.style.display='none'; }, 3000);
  }

  // ---------- Filter logic for "incomplete" ----------
  function isIncomplete(o){
    const st = String(o.status||'').toLowerCase();
    if (st !== 'pastrim' && st !== 'radhe' && st !== 'queue') return false;  // only fresh intakes
    const tot0 = Number(o.total||0) <= 0.00001;
    const m20  = Number(o.m2||0)    <= 0.00001;
    const pc0  = Number(o.pieces||0) <= 0;
    // consider incomplete if no charge yet OR no pieces/m² entered
    return tot0 || m20 || pc0;
  }

  function row(o){
    const el = document.createElement('div');
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

    // open -> try client panel (uses same hook as pastrimi.js)
    el.querySelector('.open').onclick = function(){
      try {
        if (typeof window.openClientById === 'function') return window.openClientById(o.id);
      } catch(e){}
      // fallback: navigate to /pranimi/?id=...
      try { location.href = '/pranimi/?id=' + encodeURIComponent(o.id); } catch(e){}
    };
    el.querySelector('.details').onclick = function(){
      try { window.openClientById && window.openClientById(o.id); } catch(e){}
    };

    return el;
  }

  function renderStats(rows){
    var wrap = $('#drafts_stats'); if (!wrap) { wrap = document.createElement('div'); wrap.id='drafts_stats'; document.body.prepend(wrap); }
    wrap.innerHTML='';
    var bar = document.createElement('div');
    bar.style.cssText='display:flex;flex-wrap:wrap;gap:12px;margin:6px 0';
    bar.innerHTML = '\
      <div class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">📝 ' + rows.length + ' pranimet e paplotesuara</div>\
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

  async function render(){
    try{
      var rows = await sbSelect('orders', { order:'created_at.desc' });
      if (!Array.isArray(rows)) rows = [];
      rows = rows.filter(isIncomplete);

      // ensure containers
      if (!$('#drafts_stats')) { var s=document.createElement('div'); s.id='drafts_stats'; document.body.prepend(s); }
      if (!$('#drafts_list'))  { var l=document.createElement('div'); l.id='drafts_list'; document.body.appendChild(l); }

      renderStats(rows);

      var q = $('#draftsSearch') ? $('#draftsSearch').value : '';
      var filtered = rows.filter(function(o){ return matches(o,q); })
                         .sort(function(a,b){ return String(b.created_at||'').localeCompare(String(a.created_at||'')); });

      var host = $('#drafts_list'); host.innerHTML='';
      if (!filtered.length){
        var empty=document.createElement('div');
        empty.style.cssText='opacity:.7;padding:20px;text-align:center;border:1px dashed #2c3954;border-radius:12px';
        empty.textContent='S’ka pranimet e paplotesuara.';
        host.appendChild(empty);
      } else {
        filtered.forEach(function(o){ host.appendChild(row(o)); });
      }

      var rf = $('#draftsRefresh'); if (rf) rf.onclick = render;
      var ds = $('#draftsSearch');  if (ds) ds.oninput = function(){ render(); };
    }catch(e){
      console.error(e); banner('ERR');
    }
  }

  document.addEventListener('DOMContentLoaded', function(){
    render();
  });
})();
