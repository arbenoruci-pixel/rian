
window.ClientTemplate = (function(){
  let current = null;

  async function ensureOverlay(){
    if(document.getElementById('client-template')) return;
    const html =
      await fetch('../assets/client.template.html').then(r=>r.text()).catch(()=>null) ||
      await fetch('assets/client.template.html').then(r=>r.text());
    const div = document.createElement('div'); div.innerHTML = html.trim();
    document.body.appendChild(div.firstElementChild);
    wire();
  }

  function wire(){
    const root = document.getElementById('client-template');
    root.querySelector('#ct_close').addEventListener('click', ()=>root.style.display='none');
    root.querySelector('#ct_open_payment').addEventListener('click', ()=>{
      if(!current) return;
      if(window.PaymentPanel) PaymentPanel.openPayment(current.order);
    });
    root.querySelector('#ct_add_piece').addEventListener('click', addPiece);
    root.querySelector('#ct_save_note').addEventListener('click', saveNote);
    root.querySelector('#ct_go_pastrimi').addEventListener('click', ()=>nav('/pastrimi/'));
    root.querySelector('#ct_go_gati').addEventListener('click', ()=>nav('/gati/'));
    root.querySelector('#ct_go_marrje').addEventListener('click', ()=>nav('/marrje-sot/'));
  }

  function nav(path){
    const base = location.pathname.endsWith('/') ? location.pathname : location.pathname.substring(0, location.pathname.lastIndexOf('/')+1);
    location.href = path.startsWith('/') ? path : (base + path);
  }

  function render(order){
    const root = document.getElementById('client-template');
    root.style.display = 'block';
    current = { order };

    root.querySelector('#ct_code').textContent  = (order.code ?? '-');
    root.querySelector('#ct_name').textContent  = (order.name ?? '-');
    root.querySelector('#ct_phone').textContent = (order.phone ?? '-');

    root.querySelector('#ct_pieces').textContent = (order.pieces ?? 0);
    root.querySelector('#ct_m2').textContent     = (order.m2 ?? 0);
    const price = (order.price_per_m2 ?? order.pricePerM2 ?? 0);
    const total = price * (order.m2 ?? 0);
    const paid  = (order.paid_amount ?? order.paidAmount ?? 0);
    root.querySelector('#ct_total').textContent  = (order.total ?? total ?? 0).toFixed(2);
    root.querySelector('#ct_debt').textContent   = (total - paid).toFixed(2);

    root.querySelector('#ct_note').value = (order.note ?? '');

    const itemsBox = root.querySelector('#ct_items');
    const items = Array.isArray(order.items) ? order.items :
                  (order.order_items || order.items_list || []);
    if(!items || items.length===0){
      itemsBox.innerHTML = '<div style="padding:6px;color:#94a3b8">S’ka copë të regjistruara.</div>';
    }else{
      itemsBox.innerHTML = items.map((it,idx)=>{
        const img = it.photo_url ? `<img src="${it.photo_url}" style="width:58px;height:58px;object-fit:cover;border:1px solid #334155;border-radius:6px"/>` : '';
        return `<div style="display:flex;align-items:center;gap:10px;padding:6px;border-bottom:1px solid #2c3a55">
          <div>${idx+1}</div>
          <div>${(it.m2??0)} m²</div>
          <div>${img}</div></div>`;
      }).join('');
    }
  }

  async function addPiece(){
    if(!current) return;
    const root = document.getElementById('client-template');
    const m2 = +root.querySelector('#ct_new_m2').value || 0;
    const file = root.querySelector('#ct_new_photo').files[0] || null;
    const o = current.order;
    try{
      if(window.Tepiha?.addPieceToOrder){
        await Tepiha.addPieceToOrder(o.id, {m2, photo:file});
      } else {
        o.pieces = (o.pieces||0)+1;
        o.m2 = (o.m2||0)+m2;
        if(window.Tepiha?.saveOrder) await Tepiha.saveOrder(o);
        else if(window.saveOrder)     await window.saveOrder(o);
      }
      alert('Copë u shtua.');
      openByOrderId(o.id);
    }catch(e){ console.error(e); alert('Shtimi dështoi: '+e.message); }
  }

  async function saveNote(){
    if(!current) return;
    const root = document.getElementById('client-template');
    const note = root.querySelector('#ct_note').value || '';
    const o = current.order;
    try{
      o.note = note;
      if(window.Tepiha?.saveOrder) await Tepiha.saveOrder(o);
      else if(window.saveOrder)     await window.saveOrder(o);
      alert('Shënimi u ruajt.');
    }catch(e){ console.error(e); alert('Nuk u ruajt shënimi: '+e.message); }
  }

  async function openByOrderId(orderId){
    await ensureOverlay();
    let order = null;
    if(window.Tepiha?.getOrderById){
      order = await Tepiha.getOrderById(orderId);
    } else {
      try{ order = JSON.parse(localStorage.getItem('order_'+orderId)||'{}'); }catch{}
    }
    if(order) render(order);
  }

  async function openByCode(code){
    await ensureOverlay();
    let order = null;
    if(window.Tepiha?.getOrderByCode){
      order = await Tepiha.getOrderByCode(code);
    }
    if(!order){
      for(let i=0;i<localStorage.length;i++){
        const k=localStorage.key(i); if(!/^order_/.test(k)) continue;
        try{
          const o = JSON.parse(localStorage.getItem(k)||'{}');
          if((o.code||'').toString() === code.toString()){ order=o; break; }
        }catch{}
      }
    }
    if(order) render(order);
  }

  async function openByPhone(phone){
    await ensureOverlay();
    let order = null;
    if(window.Tepiha?.getLatestOrderByPhone){
      order = await Tepiha.getLatestOrderByPhone(phone);
    }
    if(!order){
      let best=null, bestAt=0;
      for(let i=0;i<localStorage.length;i++){
        const k=localStorage.key(i); if(!/^order_/.test(k)) continue;
        try{
          const o = JSON.parse(localStorage.getItem(k)||'{}');
          if(((o.phone||'')===phone) && o.created_at){
            const ts = Date.parse(o.created_at)||0;
            if(ts>bestAt){ best=o; bestAt=ts; }
          }
        }catch{}
      }
      order = best;
    }
    if(order) render(order);
  }

  return { openByOrderId, openByCode, openByPhone, ensureOverlay };
})();
