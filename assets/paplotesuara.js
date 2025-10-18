// /assets/paplotesuara.js — Completed orders list (shows 'gati' and similar statuses)
// Works with /assets/supabase.js (window.select/update) OR direct supabase-js.
// Drop-in: add containers <div id="done_stats"></div><div id="done_list"></div> in your HTML.

(function(){
  // ---------- helpers ----------
  function $(s, r){ return (r||document).querySelector(s); }
  function $all(s, r){ return [].slice.call((r||document).querySelectorAll(s)); }
  function n2(v){ return Number(v||0).toFixed(2); }
  function fmtDate(iso){
    try { const d=new Date(iso); return d.toLocaleString(); } catch(_){ return iso||''; }
  }

  // statuses we consider "completed / ready"
  var COMPLETED_STATUSES = ['gati', 'marrje', 'marrje sot', 'perfunduar', 'arkiv', 'dorzuar', 'dorezuar', 'delivered', 'completed'];
  function isCompletedStatus(s){
    var x=String(s||'').toLowerCase();
    return COMPLETED_STATUSES.indexOf(x) >= 0;
  }

  // ---------- Supabase helpers (dual-mode) ----------
  async function sbSelect(table, query) {
    try {
      if (typeof window.select === 'function') {
        var res = await window.select(table, query||{});
        if (Array.isArray(res)) return res;
        if (res && Array.isArray(res.data)) return res.data;
        return [];
      }
    } catch(_) {}
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const url = window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL;
    const key = window.SUPABASE_ANON || window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sb  = createClient(url, key);
    var q = sb.from(table).select('*');
    if (query && query.order === 'created_at.desc') q = q.order('created_at', { ascending:false });
    const { data, error } = await q;
    if (error) throw error;
    return data||[];
  }

  async function sbUpdateOrder(id, patch) {
    try {
      if (typeof window.update === 'function') {
        return await window.update('orders', patch, { id:id });
      }
    } catch(_) {}
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const url = window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL;
    const key = window.SUPABASE_ANON || window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sb  = createClient(url, key);
    const { error } = await sb.from('orders').update(patch).eq('id', id);
    if (error) throw error;
  }

  // ---------- UI helpers ----------
  function banner(msg) {
    var el = $('#done_err'); 
    if (!el) {
      el = document.createElement('div');
      el.id = 'done_err';
      el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:#a40e0e;border:1px solid #c11;color:#fff;padding:8px 12px;border-radius:10px;font-weight:900';
      document.body.appendChild(el);
    }
    el.textContent = 'SUPABASE: ' + (msg||'ERR');
    el.style.display = 'block';
    setTimeout(function(){ el.style.display = 'none'; }, 3500);
  }

  // ---------- Row ----------
  function rowEl(o){
    var el = document.createElement('div');
    el.className = 'card done-row';
    el.style.cssText = 'border:1px solid #273143;background:#0c0f16;border-radius:14px;padding:10px;margin:10px 0';

    var status = String(o.status||'').toUpperCase();
    var html = '\
      <div class="head" style="display:grid;grid-template-columns:auto 1fr auto auto auto;gap:8px;align-items:center">\
        <span class="code" style="font-weight:1000;">'+(o.code||'')+'</span>\
        <span class="name">'+(String(o.name||'').slice(0,40))+'</span>\
        <span class="total">€'+n2(o.total||0)+'</span>\
        <span class="created" title="'+(o.created_at||'')+'">'+fmtDate(o.created_at||o.updated_at)+'</span>\
        <span class="status badge" style="background:#0b111d;border:1px solid #2c3a55;border-radius:999px;padding:6px 10px;font-weight:900;color:#e6f0ff">'+status+'</span>\
      </div>\
      <div class="actions" style="display:flex;gap:8px;margin-top:8px">\
        <button class="det" data-id="'+(o.id||'')+'" style="border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#0c0f20;color:#e6f0ff;border:1px solid #2b3956">📋 DETAJE</button>\
        <button class="undo" data-id="'+(o.id||'')+'" style="border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#9b1c1c;color:#fff;border:1px solid #b32626">↩︎ KTHE NË PROCES</button>\
      </div>';
    el.innerHTML = html;

    // wire buttons
    el.querySelector('.det').onclick = function(){
      try{ window.openClientById && window.openClientById(o.id); }catch(e){ console.warn(e); }
    };
    el.querySelector('.undo').onclick = async function(){
      try{
        await sbUpdateOrder(o.id, { status:'pastrim', stage:'radhe', stage_at: new Date().toISOString() });
        el.style.opacity = .4; setTimeout(function(){ el.remove(); }, 300);
      }catch(e){ console.error(e); banner('ERR'); }
    };
    return el;
  }

  // ---------- Render stats ----------
  function renderStats(rows){
    var sum = rows.reduce(function(s,x){ return s + Number(x.total||0); }, 0);
    var wrap = $('#done_stats'); 
    if (!wrap) { wrap = document.createElement('div'); wrap.id='done_stats'; document.body.prepend(wrap); }
    wrap.innerHTML = '';
    var bar = document.createElement('div');
    bar.style.cssText='display:flex;flex-wrap:wrap;gap:12px;margin:6px 0';
    bar.innerHTML = '\
      <div class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">✅ ' + rows.length + ' të përfunduara</div>\
      <div class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">€ ' + n2(sum) + ' total</div>\
      <input id="doneSearch" placeholder="Kërko: kod/emër/telefon" \
        style="flex:1;min-width:200px;background:#070a12;border:2px solid #2c3954;border-radius:12px;padding:8px 10px;color:#fff;font-weight:900">\
      <select id="doneRange" style="background:#070a12;border:2px solid #2c3954;border-radius:12px;padding:8px 10px;color:#fff;font-weight:900">\
        <option value="all">Krejt</option>\
        <option value="today">Sot</option>\
        <option value="7">7 ditë</option>\
        <option value="30">30 ditë</option>\
      </select>\
      <button id="doneRefresh" class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">↻</button>\
    ';
    wrap.appendChild(bar);
  }

  function inRange(iso, mode){
    if (!mode || mode==='all') return true;
    var d = new Date(iso); if (isNaN(d)) return false;
    var now = new Date();
    if (mode==='today'){
      return d.toDateString() === now.toDateString();
    }
    var days = Number(mode||0);
    if (!days) return true;
    var diff = (now - d) / 86400000;
    return diff <= days;
  }

  function matchesSearch(o, q){
    if (!q) return true;
    q = String(q).toLowerCase().trim();
    return String(o.code||'').toLowerCase().indexOf(q) >= 0 ||
           String(o.name||'').toLowerCase().indexOf(q) >= 0 ||
           String(o.phone||'').replace(/\D/g,'').indexOf(q.replace(/\D/g,'')) >= 0;
  }

  // ---------- Main render ----------
  async function renderDone(){
    try{
      var rows = await sbSelect('orders', { order:'created_at.desc' });
      if (!Array.isArray(rows)) rows = [];

      // only completed-like statuses
      rows = rows.filter(function(o){ return isCompletedStatus(o.status); });

      // read UI filters (create if missing)
      if (!$('#done_stats')) { var s=document.createElement('div'); s.id='done_stats'; document.body.prepend(s); }
      if (!$('#done_list'))  { var l=document.createElement('div'); l.id='done_list'; document.body.appendChild(l); }

      renderStats(rows);

      var q   = $('#doneSearch') ? $('#doneSearch').value : '';
      var rng = $('#doneRange') ? $('#doneRange').value : 'all';

      var filtered = rows.filter(function(o){
        return inRange(o.updated_at||o.created_at, rng) && matchesSearch(o, q);
      }).sort(function(a,b){
        return String(b.updated_at||b.created_at||'').localeCompare(String(a.updated_at||a.created_at||''));
      });

      var host = $('#done_list'); host.innerHTML = '';
      if (!filtered.length){
        var empty = document.createElement('div');
        empty.style.cssText = 'opacity:.7;padding:20px;text-align:center;border:1px dashed #2c3954;border-radius:12px';
        empty.textContent = 'S’ka porosi të përfunduara për këtë filtër.';
        host.appendChild(empty);
      } else {
        filtered.forEach(function(o){ host.appendChild(rowEl(o)); });
      }

      // wire after render
      var rf = $('#doneRefresh'); if (rf) rf.onclick = renderDone;
      var ds = $('#doneSearch');  if (ds) ds.oninput = function(){ renderDone(); };
      var dr = $('#doneRange');   if (dr) dr.onchange = function(){ renderDone(); };

    }catch(e){
      console.error(e);
      banner('ERR');
    }
  }

  document.addEventListener('DOMContentLoaded', function(){
    renderDone();
  });
})();