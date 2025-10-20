
(function(){
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const orderId = params.get('id');
  const codeParam = params.get('code');
  const back = $('#back');

  // Use central supabase config if present
  const U = (window.SUPABASE_URL)||'YOUR_SUPABASE_URL';
  const K = (window.SUPABASE_ANON_KEY)||'YOUR_SUPABASE_ANON_KEY';
  const supa = (window.supabase && window.supabase.createClient) ? window.supabase.createClient(U,K) : null;

  function digits(v){ return String(v??'').replace(/\D/g,''); }
  function num(v){ const n = parseFloat(String(v??'').replace(',','.')); return isFinite(n)?n:0; }


  // Editable inputs
  const inp = {
    name: $('#name_inp'), phone: $('#phone_inp'), pieces: $('#pieces_inp'),
    m2: $('#m2_inp'), euro_m2: $('#euro_m2_inp'), total: $('#total_inp'),
    status: $('#status_inp'), note: $('#note_inp'),
    fileUp: $('#fileUp'),
    btnSave: $('#btnSave'),
    btnDelete: $('#btnDelete')
  };

  const ui = {
    code: $('#code'), name: $('#name'), phone: $('#phone'),
    status: $('#status'), pieces: $('#pieces'), m2: $('#m2'),
    total: $('#total'), note: $('#note'), photos: $('#photos'),
    markReady: $('#markReady')
  };

  function set(k, v){ ui[k].textContent = (v==null||v==='')?'—':String(v); }
  function tryJSON(s){ try{return JSON.parse(s)}catch(_){return null} }
  function lsGet(k){ try{return localStorage.getItem(k)}catch(_){return null} }
  function lsObj(k){ const s = lsGet(k); return s ? (tryJSON(s)||{}) : {}; }

  async function fetchOrder(){
    // 1) Try Supabase by id or code
    if(supa){
      try{
        if(orderId){
          const { data, error } = await supa
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .single();
          if(!error && data) return data;
        }
        if(codeParam){
          const { data, error } = await supa
            .from('orders')
            .select('*')
            .eq('code', codeParam)
            .order('created_at', { ascending:false })
            .limit(1);
          if(!error && data && data.length) return data[0];
        }
      }catch(e){ /* ignore and fallback */ }
    }
    // 2) Fallback to unified local store
    const orders_v1 = tryJSON(lsGet('orders_v1')) || [];
    if(orderId){
      const byId = orders_v1.find(o=>o && (o.id===orderId || o.uuid===orderId));
      if(byId) return byId;
    }
    if(codeParam){
      const byCode = orders_v1.find(o=>String(o.code||o.code_n||'')===String(codeParam));
      if(byCode) return byCode;
    }
    // 3) Legacy single-order mirror
    if(orderId){
      const o = lsObj('order_'+orderId);
      if(o && (o.id||o.code)) return o;
    }
    return null;
  }

  async function loadPhotos(order){
    // Strategy: prefer explicit fields; else try storage list under orders/<id>/
    ui.photos.innerHTML = '';
    const urls = [];

    // common fields
    const guessFields = ['photo_url','photo','image_url','image','photos'];
    for(const f of guessFields){
      if(order && order[f]){
        if(Array.isArray(order[f])) urls.push(...order[f].filter(Boolean));
        else urls.push(order[f]);
      }
    }
    // legacy nested
    if(order && order.meta && order.meta.photos){
      if(Array.isArray(order.meta.photos)) urls.push(...order.meta.photos.filter(Boolean));
    }

    // If none found and we have supabase + id => list the storage folder
    if(urls.length===0 && supa && order && order.id){
      try{
        // Public bucket strategy: tepiha-photos under path orders/<id>/
        const pathPrefix = `orders/${order.id}`;
        const { data, error } = await supa.storage.from('tepiha-photos').list(pathPrefix, { limit: 100 });
        if(!error && Array.isArray(data)){
          for(const f of data){
            if(!f || !f.name) continue;
            const { data:pub, error:pubErr } = supa
              .storage.from('tepiha-photos')
              .getPublicUrl(`${pathPrefix}/${f.name}`);
            if(!pubErr && pub && pub.publicUrl) urls.push(pub.publicUrl);
          }
        }
      }catch(e){ /* ignore */ }
    }

    // Render
    if(urls.length===0){
      ui.photos.innerHTML = '<div style="opacity:.6">S’ka foto të lidhura.</div>';
      return;
    }
    urls.forEach(u=>{
      const img = document.createElement('img');
      img.src = u;
      ui.photos.appendChild(img);
    });
  }

  async function populate(){
    const order = await fetchOrder();
    if(!order){
      document.body.innerHTML = '<div style="padding:20px">Nuk u gjet porosia. Kontrollo ID apo kodin.</div>';
      return;
    }
    set('code', order.code || order.code_n || '—');
    set('name', order.name || order.client_name || '—');
    set('phone', order.phone || order.client_phone || '—');
    set('status', order.status || '—');
    const pieces = order.pieces ?? order.cop ?? order.copa ?? order.items_count;
    set('pieces', pieces ?? '—');
    const m2 = order.m2_total ?? order.m2 ?? order.m2total ?? order.total_m2;
    set('m2', m2 ?? '—');
    const total = order.total ?? order.total_eur ?? order.amount ?? order.sum;
    set('total', total ?? '—');
    set('note', order.note || order.notes || (order.meta && order.meta.note) || '—');
    await loadPhotos(order);

    // Hook actions
    back.addEventListener('click', (e)=>{
      e.preventDefault();
      history.length>1 ? history.back() : (location.href='pastrimi/index.html');
    });

    ui.markReady.addEventListener('click', async (e)=>{
      e.preventDefault();
      try{
        if(supa && (order.id || codeParam)){
          let targetId = order.id;
          if(!targetId && codeParam){
            const { data } = await supa.from('orders').select('id').eq('code', codeParam).order('created_at',{ascending:false}).limit(1);
            if(data && data.length) targetId = data[0].id;
          }
          if(targetId){
            await supa.from('orders').update({ status: 'gati', ready_at: new Date().toISOString() }).eq('id', targetId);
          }
        }
      }catch(_){}
      // Update local mirrors if present
      try{
        const orders_v1 = (JSON.parse(localStorage.getItem('orders_v1'))||[]).map(o=>{
          if(o && (o.id===order.id || String(o.code)===String(order.code))) return { ...o, status:'gati', ready_at:new Date().toISOString() };
          return o;
        });
        localStorage.setItem('orders_v1', JSON.stringify(orders_v1));
      }catch(_){}
      alert('U kalua në GATI.');
    });
  }

  populate();
})();
