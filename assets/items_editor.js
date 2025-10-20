
// items_editor.js — reusable editor for order_items (pieces) tied to an order (by id or code)
// Usage: include this file on any page with window.P_ITEMS_MOUNT = '#items_mount';
// Requires supabase client + order id/code in URL (?id= or ?code=).

(function(){
  const qs = s=>document.querySelector(s);
  const qsa = s=>Array.from(document.querySelectorAll(s));
  const params = new URLSearchParams(location.search);
  const orderIdParam = params.get('id');
  const codeParam = params.get('code');

  const U = (window.SUPABASE_URL)||'YOUR_SUPABASE_URL';
  const K = (window.SUPABASE_ANON_KEY)||'YOUR_SUPABASE_ANON_KEY';
  const supa = (window.supabase && window.supabase.createClient) ? window.supabase.createClient(U,K) : null;

  const mountSel = window.P_ITEMS_MOUNT || '#items_mount';
  const root = qs(mountSel);
  if(!root){ console.warn('items_editor: mount not found', mountSel); return; }

  function num(v){ const n=parseFloat(String(v??'').replace(',','.')); return isFinite(n)?n:0; }
  function rid(){ return 'i_'+Math.random().toString(36).slice(2,9); }

  let orderId = null;
  let rows = []; // local working set

  async function resolveOrderId(){
    if(orderIdParam){ orderId = orderIdParam; return orderId; }
    if(!supa || !codeParam) return null;
    const { data, error } = await supa.from('orders').select('id').eq('code', codeParam).order('created_at',{ascending:false}).limit(1);
    if(!error && data && data.length) { orderId = data[0].id; return orderId; }
    return null;
  }

  function tplRow(r){
    return (
`<div class="item-row" data-rid="${r._rid||rid()}">
  <input class="piece" placeholder="TEPIH/STAŽA/SHKALLË" value="${r.piece_type||''}"/>
  <input class="qty" type="number" min="1" value="${r.qty||1}"/>
  <input class="m2" type="number" step="0.1" value="${r.m2||0}"/>
  <input class="eur" type="number" step="0.1" value="${r.price_per_m2||0}"/>
  <span class="sum">0.00</span>
  <button class="del">✖</button>
</div>`)
  }

  function recalcRow(el){
    const qty = num(el.querySelector('.qty').value)||1;
    const m2 = num(el.querySelector('.m2').value)||0;
    const eur = num(el.querySelector('.eur').value)||0;
    const sum = Math.round(qty*m2*eur*100)/100;
    el.querySelector('.sum').textContent = sum.toFixed(2);
    return sum;
  }

  function recalcAll(){
    let total = 0;
    qsa('.item-row').forEach(el=> total += recalcRow(el));
    const out = qs('#items_total');
    if(out) out.textContent = total.toFixed(2);
  }

  function bindRow(el){
    ['input','change'].forEach(ev=> el.addEventListener(ev, ()=>{ recalcRow(el); recalcAll(); }));
    el.querySelector('.del').addEventListener('click', ()=>{
      el.remove();
      recalcAll();
    });
  }

  function renderRows(){
    const wrap = qs('#items_rows');
    wrap.innerHTML = rows.map(tplRow).join('');
    qsa('.item-row').forEach(bindRow);
    recalcAll();
  }

  function addEmpty(){
    const wrap = qs('#items_rows');
    const html = tplRow({qty:1, m2:0, price_per_m2:0});
    const div = document.createElement('div');
    div.innerHTML = html;
    const el = div.firstChild;
    wrap.appendChild(el);
    bindRow(el);
    recalcAll();
  }

  async function loadItems(){
    if(!supa || !orderId) return;
    const { data, error } = await supa.from('order_items').select('*').eq('order_id', orderId).order('created_at',{ascending:true});
    rows = (data||[]).map(d=>({
      _rid: rid(),
      id: d.id,
      piece_type: d.piece_type||'',
      qty: d.qty||1,
      m2: d.m2||0,
      price_per_m2: d.price_per_m2||0,
    }));
    renderRows();
  }

  async function saveItems(){
    if(!supa || !orderId) { alert('S’ka lidhje me DB.'); return; }
    // collect from DOM
    const payload = qsa('.item-row').map(el=> ({
      piece_type: el.querySelector('.piece').value || null,
      qty: Number(el.querySelector('.qty').value||0),
      m2: Number(el.querySelector('.m2').value||0),
      price_per_m2: Number(el.querySelector('.eur').value||0),
    }));

    // 1) Delete removed items: simple strategy -> delete all then re-insert (safe + simple)
    await supa.from('order_items').delete().eq('order_id', orderId);

    // 2) Insert new set
    const rows = payload.map(p=> ({ order_id: orderId, ...p }));
    if(rows.length){
      const { error } = await supa.from('order_items').insert(rows);
      if(error){ alert('S’u ruajtën copat.'); return; }
    }

    // Optionally recompute order total on server side (if you have a trigger/RPC). For now leave it.
    alert('Copat u ruajtën.');
  }

  async function init(){
    const ok = await resolveOrderId();
    if(!ok){ root.innerHTML = '<div style="opacity:.7">S’u gjet ID/kod për copat.</div>'; return; }

    // UI shell
    root.innerHTML = `
      <div class="box">
        <div style="margin-bottom:8px;opacity:.9">COPAT</div>
        <div id="items_rows" class="items-rows"></div>
        <div style="display:flex;gap:10px;margin-top:10px">
          <button id="add_item">+ SHTO COPË</button>
          <button id="save_items">RUAJ COPAT</button>
          <div style="margin-left:auto">TOTAL nga copat: <b><span id="items_total">0.00</span> €</b></div>
        </div>
      </div>
      <style>
        .items-rows{display:flex;flex-direction:column;gap:8px}
        .item-row{display:grid;grid-template-columns:2fr .8fr .8fr .8fr .8fr auto;gap:8px;align-items:center;
          background:#13131a;border:1px solid #2d2d39;border-radius:8px;padding:8px}
        .item-row input{width:100%;padding:8px;border-radius:6px;border:1px solid #2d2d39;background:#0f0f15;color:#eaeaea}
        .item-row .del{background:#3a1515;border:1px solid #5c1e1e;color:#fff;border-radius:6px;padding:8px 10px;cursor:pointer}
      </style>
    `;

    qs('#add_item').addEventListener('click', addEmpty);
    qs('#save_items').addEventListener('click', saveItems);

    await loadItems();
    if(qs('#items_rows').children.length===0) addEmpty();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
