
// Reuse the same PRANIMI form but in EDIT mode.
// Requirements: the base PRANIMI fields exist with the same IDs (name, phone, pieces, m2, euro_m2, note, photo, total, etc.)
// This script loads an existing order by ?id or ?code, fills the fields, and on SAVE performs UPDATE instead of create.

(function(){
  const params = new URLSearchParams(location.search);
  const orderId = params.get('id');
  const codeParam = params.get('code');

  const $ = s=>document.querySelector(s);
  function num(v){ const n=parseFloat(String(v??'').replace(',','.')); return isFinite(n)?n:0; }
  function setVal(el, v){ if(!el) return; el.value = (v==null?'':v); }
  function text(el, v){ if(!el) return; el.textContent = (v==null||v==='')?'—':String(v); }
  function nowISO(){ return new Date().toISOString(); }

  const U = (window.SUPABASE_URL)||'YOUR_SUPABASE_URL';
  const K = (window.SUPABASE_ANON_KEY)||'YOUR_SUPABASE_ANON_KEY';
  const supa = (window.supabase && window.supabase.createClient) ? window.supabase.createClient(U,K) : null;

  const ui = {
    codeBadge: document.querySelector('.kodi'),
    name: $('#name'),
    phone: $('#phone'),
    pieces: $('#pieces'),
    m2: $('#m2'),
    euro_m2: $('#euro_m2'),
    note: $('#note'),
    photo: $('#photo'),
    total: $('#total'),
    saveBtn: document.querySelector('#save'),
  };

  let currentOrder = null;
  let currentId = orderId || null;

  async function fetchOrder(){
    // Try Supabase first
    if(supa){
      try{
        if(orderId){
          const { data, error } = await supa.from('orders').select('*').eq('id', orderId).single();
          if(!error && data) return data;
        }
        if(codeParam){
          const { data, error } = await supa.from('orders').select('*').eq('code', codeParam).order('created_at',{ascending:false}).limit(1);
          if(!error && data && data.length) return data[0];
        }
      }catch(e){}
    }
    // Fallback to local unified store
    try{
      const list = JSON.parse(localStorage.getItem('orders_v1')||'[]');
      if(orderId){
        const found = list.find(o=>o && (o.id===orderId || o.uuid===orderId));
        if(found) return found;
      }
      if(codeParam){
        const found = list.find(o=>String(o.code||o.code_n||'')===String(codeParam));
        if(found) return found;
      }
    }catch(e){}
    return null;
  }

  function recompute(){
    const tot = num(ui.m2 && ui.m2.value) * num(ui.euro_m2 && ui.euro_m2.value);
    if(ui.total) ui.total.value = (Math.round(tot*100)/100).toFixed(2);
  }

  function fillForm(o){
    if(!o) return;
    currentOrder = o;
    if(o.id) currentId = o.id;
    if(ui.codeBadge){
      text(ui.codeBadge, o.code || o.code_n || '—');
      ui.codeBadge.setAttribute('data-code', String(o.code||o.code_n||''));
    }
    setVal(ui.name, o.name || o.client_name || '');
    setVal(ui.phone, o.phone || o.client_phone || '');
    setVal(ui.pieces, o.pieces ?? o.cop ?? o.copa ?? o.items_count ?? '');
    setVal(ui.m2, o.m2_total ?? o.m2 ?? o.m2total ?? o.total_m2 ?? '');
    setVal(ui.euro_m2, o.euro_m2 ?? o.price_per_m2 ?? '');
    setVal(ui.note, o.note || o.notes || '');
    if(ui.total){
      const t = o.total ?? o.total_eur ?? o.amount ?? '';
      if(String(t).length) ui.total.value = t;
      else recompute();
    }
  }

  async function uploadPhotoIfAny(id){
    if(!supa || !ui.photo || !ui.photo.files || !ui.photo.files[0]) return null;
    const file = ui.photo.files[0];
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `orders/${id}/${Date.now()}.${ext}`;
    const { error } = await supa.storage.from('tepiha-photos').upload(path, file, { upsert: false });
    if(error){ console.warn('upload failed', error); return null; }
    const { data:pub } = supa.storage.from('tepiha-photos').getPublicUrl(path);
    return pub && pub.publicUrl ? pub.publicUrl : null;
  }

  async function saveEdit(){
    // gather
    const patch = {
      name: ui.name && ui.name.value || null,
      phone: ui.phone && ui.phone.value || null,
      pieces: ui.pieces && Number(ui.pieces.value||0),
      m2_total: ui.m2 && Number(ui.m2.value||0),
      euro_m2: ui.euro_m2 && Number(ui.euro_m2.value||0),
      total: ui.total && Number(ui.total.value||0),
      note: ui.note && ui.note.value || null,
      updated_at: nowISO(),
    };

    if(supa && currentId){
      const { error } = await supa.from('orders').update(patch).eq('id', currentId);
      if(error){ alert('S’u ruajt (DB).'); return; }
      // optional photo
      const photoUrl = await uploadPhotoIfAny(currentId);
      if(photoUrl){
        // attach to an array field if exists
        try{
          const { data:cur } = await supa.from('orders').select('photos').eq('id', currentId).single();
          const photos = Array.isArray(cur && cur.photos) ? cur.photos : [];
          photos.push(photoUrl);
          await supa.from('orders').update({ photos }).eq('id', currentId);
        }catch(e){}
      }
    }

    // mirror locally if exists
    try{
      const arr = JSON.parse(localStorage.getItem('orders_v1')||'[]').map(o=>{
        if(o && (o.id===currentId || String(o.code)===String(currentOrder && currentOrder.code))){
          return { ...o, ...patch };
        }
        return o;
      });
      localStorage.setItem('orders_v1', JSON.stringify(arr));
    }catch(e){}

    alert('U përditësua porosia.');
  }

  async function init(){
    if(!orderId && !codeParam){
      alert('S’ka ID apo kod për editim. Hap nga Pastrimi.');
      return;
    }
    const o = await fetchOrder();
    if(!o){ alert('Porosia nuk u gjet.'); return; }
    fillForm(o);
    recompute();

    // Change the SAVE button label to "RUAJ NDRYSHIMET"
    if(ui.saveBtn){
      ui.saveBtn.textContent = 'RUAJ NDRYSHIMET';
      ui.saveBtn.addEventListener('click', async (e)=>{
        e.preventDefault();
        await saveEdit();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();