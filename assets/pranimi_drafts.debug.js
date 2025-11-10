// /assets/pranimi_drafts.debug.js — permissive: show ALL intakes in pastrim/radhe/queue
// Highlights incomplete (total==0 || m2==0 || pieces==0) with a yellow badge.

(function(){
  function $(s, r){ return (r||document).querySelector(s); }
  function n2(v){ return Number(v||0).toFixed(2); }
  function fmtDate(i){ try{ const d=new Date(i); return d.toLocaleString(); }catch(_){ return i||''; } }
  function banner(msg){
    var el=$('#drafts_err'); if(!el){ el=document.createElement('div'); el.id='drafts_err';
      el.style.cssText='position:fixed;right:12px;bottom:12px;background:#a40e0e;border:1px solid #c11;color:#fff;padding:8px 12px;border-radius:10px;font-weight:900;z-index:9999';
      document.body.appendChild(el);
    }
    el.textContent='SUPABASE: '+(msg||'ERR'); el.style.display='block'; setTimeout(function(){ el.style.display='none'; }, 3000);
  }
  function isIncomplete(o){
    return Number(o.total||0)<=0.00001 || Number(o.m2||0)<=0.00001 || Number(o.pieces||0)<=0;
  }
  function row(o){
    var el=document.createElement('div');
    el.className='card';
    el.style.cssText='border:1px solid #273143;background:#0c0f16;border-radius:14px;padding:10px;margin:10px 0';
    var badge = isIncomplete(o) ? '<span style="background:#725b09;color:#fff;border:1px solid #eab308;border-radius:999px;padding:4px 8px;font-weight:900">INCOMPLETE</span>'
                                : '<span style="background:#0b111d;color:#e6f0ff;border:1px solid #2c3a55;border-radius:999px;padding:4px 8px;font-weight:900">OK</span>';
    el.innerHTML = '\
      <div style="display:grid;grid-template-columns:auto 1fr auto auto auto auto;gap:8px;align-items:center">\
        <span class="code" style="font-weight:1000">'+(o.code||'')+'</span>\
        <span class="name">'+String(o.name||'').slice(0,40)+'</span>\
        <span class="pieces">'+(o.pieces||0)+' copë</span>\
        <span class="m2">'+n2(o.m2||0)+' m²</span>\
        <span class="total">€'+n2(o.total||0)+'</span>\
        '+badge+'\
      </div>\
      <div style="opacity:.7;margin-top:6px">'+fmtDate(o.created_at)+'</div>\
      <div class="actions" style="display:flex;gap:8px;margin-top:8px">\
        <button class="open" style="border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#1e60ff;color:#fff">▶ VAZHDO</button>\
        <button class="details" style="border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#0c0f20;color:#e6f0ff;border:1px solid #2b3956">📋 DETAJE</button>\
      </div>';
    el.querySelector('.open').onclick=function(){ try{ if (typeof window.openClientById==='function') return window.openClientById(o.id); }catch(e){} try{ location.href='/pranimi/?id='+encodeURIComponent(o.id);}catch(e){} };
    el.querySelector('.details').onclick=function(){ try{ window.openClientById && window.openClientById(o.id);}catch(e){} };
    return el;
  }
  async function fetchIntakes(){
    var params={ select:'*', order:'created_at.desc', status:'in.(pastrim,radhe,queue)' };
    try{
      var rows = await (window.select ? window.select('orders', params) : []);
      if (!Array.isArray(rows)) rows = [];
      return rows;
    }catch(e){ console.error(e); banner('ERR'); return []; }
  }
  async function render(){
    var rows = await fetchIntakes();
    if (!$('#drafts_stats')){ var s=document.createElement('div'); s.id='drafts_stats'; document.body.prepend(s); }
    if (!$('#drafts_list')) { var l=document.createElement('div'); l.id='drafts_list'; document.body.appendChild(l); }
    var st=$('#drafts_stats'); st.innerHTML='';
    var bar=document.createElement('div'); bar.style.cssText='display:flex;gap:12px;flex-wrap:wrap;margin:6px 0';
    var inc=rows.filter(isIncomplete).length;
    bar.innerHTML='\
      <div class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">🧾 '+rows.length+' intake</div>\
      <div class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">🟡 '+inc+' incomplete</div>\
      <button id="rf" class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">↻</button>';
    st.appendChild(bar);
    var host=$('#drafts_list'); host.innerHTML='';
    rows.forEach(function(o){ host.appendChild(row(o)); });
    var rf=$('#rf'); if (rf) rf.onclick=render;
  }
  document.addEventListener('DOMContentLoaded', function(){ render(); });
})();
