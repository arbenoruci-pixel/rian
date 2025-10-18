// Client Profile Overlay — requires a global `supabase` client (window.supabase)
(function(){
  const $ = (sel)=>document.querySelector(sel);
  const $$ = (sel)=>Array.from(document.querySelectorAll(sel));

  async function getSignedUrl(path){
    try{
      const { data, error } = await window.supabase.storage.from('tepiha-photos').createSignedUrl(path, 60*60);
      if(error) return null;
      return data.signedUrl;
    }catch(e){ return null; }
  }

  async function listPhotos(orderId){
    try{
      const { data, error } = await window.supabase.storage.from('tepiha-photos').list(String(orderId), { limit: 50 });
      if(error || !data) return [];
      const files = data.filter(x=>x.id || x.name);
      const items = [];
      for(const f of files){
        const path = `${orderId}/${f.name}`;
        const url = await getSignedUrl(path);
        if(url) items.push({name:f.name, url});
      }
      return items;
    }catch(e){ return []; }
  }

  async function fetchOrderByCode(code){
    const q = window.supabase.from('orders').select('id,code,name,phone,total,paid_amount,is_paid,status,m2,pieces,debt,notes,ready_at').eq('code', code).maybeSingle();
    const { data, error } = await q;
    if(error) throw error;
    return data;
  }

  async function fetchPieces(orderId){
    try{
      const { data, error } = await window.supabase.from('order_items').select('id,type,label,m2').eq('order_id', orderId);
      if(error || !data) return [];
      return data;
    }catch(e){ return []; }
  }

  function renderPieces(list){
    const host = $('#tpPiecesList');
    host.innerHTML = '';
    if(!list || !list.length){ host.innerHTML = '<div style="color:#9fb0c6">S’ka të dhëna për copët.</div>'; return; }
    list.forEach((it,i)=>{
      const row = document.createElement('div');
      row.className = 'tp-row';
      row.style.justifyContent = 'space-between';
      row.innerHTML = `<div><span class="tp-type">${(it.type||'TEPIHA').toUpperCase()}</span> • ${it.label || ('Copë '+(i+1))}</div>
                       <div class="tp-chip">${Number(it.m2||0).toFixed(2)} m²</div>`;
      host.appendChild(row);
    });
  }

  function renderPhotos(list){
    const host = $('#tpPhotos'); host.innerHTML = '';
    if(!list || !list.length){ host.innerHTML = '<div style="color:#9fb0c6">S’ka foto.</div>'; return; }
    list.forEach((ph,i)=>{
      const fig = document.createElement('figure'); fig.style.margin='0';
      const img = document.createElement('img'); img.src = ph.url; img.alt = ph.name;
      img.addEventListener('click', ()=>img.classList.toggle('enlarge'));
      const cap = document.createElement('figcaption'); cap.style.fontSize='.8rem'; cap.style.color='#9fb0c6'; cap.textContent = ph.name;
      fig.appendChild(img); fig.appendChild(cap); host.appendChild(fig);
    });
  }

  function showPanel(){ $('#tpPanel').classList.add('open'); }
  function hidePanel(){ $('#tpPanel').classList.remove('open'); }

  async function openByCode(code){
    const order = await fetchOrderByCode(code);
    if(!order){ alert('Porosia nuk u gjet'); return; }
    $('#tpPanel').dataset.orderId = order.id;
    $('#tpCode').textContent = order.code ?? '—';
    $('#tpName').textContent = order.name ?? '—';
    $('#tpPhone').textContent = order.phone ?? '—';
    $('#tpPieces').textContent = order.pieces ?? '—';
    $('#tpM2').textContent = (order.m2!=null? Number(order.m2).toFixed(2): '—');
    $('#tpTotal').textContent = (order.total!=null? Number(order.total).toFixed(2): '—');
    const debt = Number(order.total||0) - Number(order.paid_amount||0);
    $('#tpDebt').textContent = debt.toFixed(2);

    // Toggle return button only when currently GATI
    const isGati = (order.status === 'gati');
    $('#tpReturnBtn').style.display = isGati ? 'inline-block' : 'none';

    // Pieces + Photos
    const [items, photos] = await Promise.all([fetchPieces(order.id), listPhotos(order.id)]);
    renderPieces(items);
    renderPhotos(photos);
    showPanel();
  }

  async function setStatus(status){
    const orderId = $('#tpPanel').dataset.orderId;
    if(!orderId) return;
    const { error } = await window.supabase.from('orders').update({ status, ready_at: status==='gati' ? new Date().toISOString() : null }).eq('id', orderId);
    if(error){ alert('S’ruajt statusin'); return; }
    alert('Statusi u përditësua: '+status.toUpperCase());
  }

  // Payment
  function openPayment(){ $('#tpPayModal').classList.add('open'); }
  function closePayment(){ $('#tpPayModal').classList.remove('open'); }

  async function savePayment(){
    const orderId = $('#tpPanel').dataset.orderId;
    const amt = Number($('#tpPayAmount').value||0);
    const note = $('#tpPayNote').value||null;
    if(!orderId) return;
    // Update paid_amount (accumulate) and is_paid
    const { data: cur } = await window.supabase.from('orders').select('paid_amount,total').eq('id', orderId).maybeSingle();
    const newPaid = Number(cur?.paid_amount||0) + amt;
    const is_paid = newPaid >= Number(cur?.total||0);
    const { error } = await window.supabase.from('orders').update({ paid_amount:newPaid, is_paid, paid_at:new Date().toISOString(), notes: note }).eq('id', orderId);
    if(error){ alert('S’ruajt pagesën'); return; }
    closePayment();
    alert('Pagesa u ruajt');
  }

  // Notes quick-save (append)
  async function saveNote(){
    const orderId = $('#tpPanel').dataset.orderId;
    if(!orderId) return;
    const txt = prompt('Shënim i ri (shtohet në fund):'); if(!txt) return;
    const { data: cur } = await window.supabase.from('orders').select('notes').eq('id', orderId).maybeSingle();
    const next = (cur?.notes ? (cur.notes+'\n') : '') + `[${new Date().toLocaleString()}] ${txt}`;
    const { error } = await window.supabase.from('orders').update({ notes: next }).eq('id', orderId);
    if(error){ alert('S’ruajt shënimin'); return; }
    alert('Shënimi u ruajt');
  }

  // Return flow (GATI -> PASTRIMI) with reason + optional photo
  function openReturn(){ $('#tpReturnModal').classList.add('open'); }
  function closeReturn(){ $('#tpReturnModal').classList.remove('open'); }

  async function saveReturn(){
    const orderId = $('#tpPanel').dataset.orderId;
    const reason = $('#tpReturnReason').value?.trim() || null;
    const file = $('#tpReturnPhoto').files[0] || null;

    // 1) upload photo if present
    let photo_url = null;
    if(file){
      const ext = (file.name.split('.').pop()||'jpg').toLowerCase();
      const path = `${orderId}/return_${Date.now()}.${ext}`;
      const { error: upErr } = await window.supabase.storage.from('tepiha-photos').upload(path, file, { upsert:true });
      if(upErr){ alert('S’u ngarkua fotoja'); return; }
      // signed URL for quick reference
      const signed = await window.supabase.storage.from('tepiha-photos').createSignedUrl(path, 3600);
      photo_url = signed?.data?.signedUrl || null;
    }

    // 2) status -> pastrim
    const upd = await window.supabase.from('orders').update({ status:'pastrim' }).eq('id', orderId);
    if(upd.error){ alert('S’përditësua statusi'); return; }

    // 3) log event
    await window.supabase.from('order_events').insert({
      order_id: orderId,
      type: 'return_to_pastrimi',
      reason: reason,
      photo_url: photo_url
    });

    closeReturn();
    alert('Porosia u kthye në PASTRIMI');
  }

  // Public API
  window.tpClientProfile = {
    openByCode,
    setStatus,
    openPayment, closePayment, savePayment,
    saveNote,
    openReturn, closeReturn, saveReturn,
    close: hidePanel
  };

  // Helper: bind all .code-badge elements to open profile (call from pages after render)
  window.bindClientBadges = function(){
    $$('.code-badge,.badge-code,[data-code]').forEach(el=>{
      const code = el.dataset.code || el.textContent.trim();
      if(!code) return;
      el.addEventListener('click', ()=>openByCode(code));
    });
  };
})();

// injected: profile overlay helpers
(function(){
  function qs(sel,root){return (root||document).querySelector(sel);}
  function openByCode(code){
    // If your project has a function to fetch an order by code, call it here.
    // Fallback: put the code into the badge and open the overlay.
    try { if(window.fetchOrderByCode){ window.fetchOrderByCode(code).then(fillProfile).then(show); return; } } catch(e){}
    if(qs('.kodi')) qs('.kodi').textContent = String(code);
    show();
  }
  function show(){ var ov=qs('#clientProfileOverlay'); if(ov){ ov.classList.add('is-open'); } }
  function hide(){ var ov=qs('#clientProfileOverlay'); if(ov){ ov.classList.remove('is-open'); } }
  // Listen for a generic save button inside profile
  document.addEventListener('click', function(e){
    var t = e.target;
    if(t && (t.matches('.btn-save-payment') || t.matches('[data-action="save-profile"]'))){
      // perform whatever save is already wired, then close
      setTimeout(function(){
        hide();
        // tell pages to refresh
        window.dispatchEvent(new CustomEvent('profile:updated', {detail:{when:Date.now()}}));
      }, 300);
    }
    if(t && (t.matches('.btn-close') || t.matches('[data-action="close-profile"]'))){
      hide();
    }
  }, true);
  // expose globally
  window.openClientProfileByCode = openByCode;
  window.closeClientProfile = hide;
})();
