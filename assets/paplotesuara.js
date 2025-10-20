// /assets/paplotesuara.js — PASRTRIM-ONLY list (orders saved in PRANIMI, not finished yet)
(function(){
  // helpers
  function $(s, r){ return (r||document).querySelector(s); }
  function n2(v){ return Number(v||0).toFixed(2); }
  function fmtDate(iso){ try{ const d=new Date(iso); return d.toLocaleString(); }catch(_){ return iso||''; } }

  // Supabase select (use your window.select helper if present)
  async function sbSelectPastrim(){
    try{
      if (typeof window.select === 'function'){
        return await window.select('orders', {
          select:'*',
          order:'created_at.desc',
          status:'eq.pastrim'
        });
      }
    }catch(_){}
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const url = window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL;
    const key = window.SUPABASE_ANON || window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sb  = createClient(url, key);
    const { data, error } = await sb
      .from('orders')
      .select('*')
      .eq('status', 'pastrim')
      .order('created_at', { ascending:false });
    if (error) throw error;
    return data || [];
  }

  function rowEl(o){
    const el=document.createElement('div');
    el.className='card';
    el.style.cssText='border:1px solid #273143;background:#0c0f16;border-radius:14px;padding:10px;margin:10px 0';
    el.innerHTML =
      '<div class="head" style="display:grid;grid-template-columns:auto 1fr auto auto auto;gap:8px;align-items:center">'+
        // ⬇️ IMPORTANT: make code clickable & carry the order id
        formatCodeCell(o) +
        '<span class="name">'+String(o.name||'').slice(0,40)+'</span>'+
        '<span class="m2">'+n2(o.m2||0)+' m² · '+(o.pieces||0)+' copë</span>'+
        '<span class="created" title="'+(o.updated_at||o.created_at||'')+'">'+fmtDate(o.updated_at||o.created_at)+'</span>'+
        '<span class="status badge" style="background:#1f2937;border:1px solid #2c3a55;border-radius:999px;padding:6px 10px;font-weight:900;color:#e6f0ff">PASTRIM</span>'+
      '</div>'+
      '<div class="actions" style="display:flex;gap:8px;margin-top:8px">'+
        // keep the “continue” button opening by id (safe)
        '<a class="btn" href="../pranimi/?id='+o.id+'" style="text-decoration:none;border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#1e60ff;color:#fff;border:1px solid #2b3956">▶ VAZHDO NË PRANIMI</a>'+
        '<button class="det" style="border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#0c0f20;color:#e6f0ff;border:1px solid #2b3956">📋 DETAJE</button>'+
      '</div>';
    el.querySelector('.det').onclick = function(){ try{ window.openClientById && window.openClientById(o.id); }catch(e){} };
    return el;
  }

  function renderStats(rows){
    let wrap = $('#done_stats'); if(!wrap){ wrap=document.createElement('div'); wrap.id='done_stats'; document.body.prepend(wrap); }
    wrap.innerHTML='';
    const bar=document.createElement('div'); bar.style.cssText='display:flex;gap:12px;align-items:center;margin:6px 0;flex-wrap:wrap';
    bar.innerHTML =
      '<div class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">🟡 '+rows.length+' të paplotësuara</div>'+
      '<button id="refreshBtn" class="pill" style="background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000">↻ Rifresko</button>';
    wrap.appendChild(bar);
    $('#refreshBtn').onclick = render;
  }

  async function render(){
    try{
      const rows = await sbSelectPastrim();
      if (!$('#done_stats')) { const s=document.createElement('div'); s.id='done_stats'; document.body.prepend(s); }
      if (!$('#done_list'))  { const l=document.createElement('div'); l.id='done_list';  document.body.appendChild(l); }
      renderStats(rows);
      const host = $('#done_list'); host.innerHTML='';
      if (!rows.length){
        const empty=document.createElement('div');
        empty.style.cssText='opacity:.7;padding:20px;text-align:center;border:1px dashed #2c3954;border-radius:12px';
        empty.textContent='S’ka pranime në pastrim (të paplotësuara).';
        host.appendChild(empty);
      } else {
        rows.forEach(o => host.appendChild(rowEl(o)));
      }
    }catch(e){
      console.error(e);
      // inline banner
      let el = document.getElementById('done_err'); if(!el){ el=document.createElement('div'); el.id='done_err';
        el.style.cssText='position:fixed;right:12px;bottom:12px;z-index:9999;background:#a40e0e;border:1px solid #c11;color:#fff;padding:8px 12px;border-radius:10px;font-weight:900';
        document.body.appendChild(el);
      }
      el.textContent='SUPABASE: ERR';
      el.style.display='block'; setTimeout(()=>{ el.style.display='none'; }, 3500);
    }
  }

  document.addEventListener('DOMContentLoaded', render);
})();

/* === Code tap → open client profile (in Pastrimi) === */
document.addEventListener('click', function(e){
  const el = e.target.closest('.code-link');
  if(!el) return;
  const id = el.dataset.id || el.getAttribute('data-id');
  if(!id){ alert('S’gjej ID për këtë porosi.'); return; }
  location.href = '/pranimi/?id=' + encodeURIComponent(id); // open by ID (prevents code regeneration)
});

/* Render helper to ensure code cell is clickable */
function formatCodeCell(o){
  const id = (o && (o.id||o.order_id||o.uuid)) || '';
  const code = (o && o.code) ? String(o.code) : '—';
  // button renders like the old span but is clickable
  return `<button class="code-link" data-id="${id}" data-code="${code}" title="Hap ${code}"
    style="all:unset;cursor:pointer;font-weight:1000;background:#0b111d;border:1px solid #273143;border-radius:10px;padding:6px 10px;display:inline-block;color:#e6f0ff">
    ${code}
  </button>`;
}