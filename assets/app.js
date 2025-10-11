/* ===========================================
   Tepiha AUTO-HEAL / STORAGE V2 — drop-in
   =========================================== */
(function(){
  const V = '5.0.0';
  const KEYS = {
    orders: 'orders_v2',
    clients: 'clients_v2',
    meta: 'app_meta_v5'
  };

  function jget(k, fb){ try{ return JSON.parse(localStorage.getItem(k)||''); }catch{ return fb; } }
  function jset(k,v){ localStorage.setItem(k, JSON.stringify(v)); }
  function jrm(k){ localStorage.removeItem(k); }

  const badName = s => (s||'').toLowerCase().includes('test');
  const badPhone = p => !p || p === '+383' || p === '+1' || p === '+' || p === '0';
  const badCode = c => !c || /^-|^X-/i.test(c);
  const pad3 = n => String(n).padStart(3,'0');

  function nextClientCodeFrom(list){
    let max = 0;
    for (const c of list||[]) {
      const m = (c.code||'').match(/^#(\d{3,})$/);
      if (m) max = Math.max(max, parseInt(m[1],10));
    }
    return '#'+pad3(max+1);
  }

  function migrateOnce(){
    const meta = jget(KEYS.meta, {});
    if (meta.version === V && meta.migrated) return;

    // read legacy (best effort)
    const oldClients = jget('clients_v1', []) || [];
    const oldOrders  = jget('orders_v1',  []) || jget('order_list_v1', []) || [];

    // filter/clean clients
    const cleanC = [];
    for (const c of oldClients){
      if (!c) continue;
      if (badName(c.name) || badPhone(c.phone)) continue;
      cleanC.push({
        id: c.id || Date.now()+Math.random(),
        name: c.name, phone: c.phone,
        code: badCode(c.code) ? null : (c.code||null),
        created_at: c.created_at || Date.now()
      });
    }
    // assign missing codes
    let seed=[...cleanC];
    for (const c of cleanC){
      if (!c.code){ c.code = nextClientCodeFrom(seed); seed.push(c); }
    }

    // filter/clean orders
    const allowedStage = new Set(['pranim','pastrim','gati','dorezuar']);
    const cleanO = [];
    for (const o of oldOrders){
      if (!o) continue;
      if (badName(o.client_name) || badPhone(o.phone)) continue;
      const c = cleanC.find(x => x.id===o.client_id || (x.phone && x.phone===o.phone));
      if (!c) continue;
      let stage = allowedStage.has(o.stage) ? o.stage : 'pastrim';
      cleanO.push({
        id: o.id || Date.now()+Math.random(),
        client_id: c.id,
        client_name: c.name,
        phone: c.phone,
        client_code: c.code,
        items: Array.isArray(o.items)?o.items:[],
        euroPerM2: o.euroPerM2 || o.euro_per_m2 || 0,
        totalM2: o.totalM2 || o.total_m2 || 0,
        total: o.total || 0,
        upfrontCash: o.upfrontCash || 0,
        note: o.note || '',
        stage, paid: !!o.paid,
        pickup_at: o.pickup_at || null,
        created_at: o.created_at || Date.now()
      });
    }

    // save to V2 and nuke obvious legacy keys
    jset(KEYS.clients, cleanC);
    jset(KEYS.orders,  cleanO);
    Object.keys(localStorage).forEach(k=>{
      if (k==='clients_v1' || k==='orders_v1' || k==='order_list_v1' || k.startsWith('order_') || k.startsWith('client_') || k.startsWith('photo_client_') || k.startsWith('Xcode_') || k.startsWith('legacy_') || k.startsWith('cache_')) jrm(k);
    });

    jset(KEYS.meta, { version: V, migrated: true, lastClean: Date.now() });
  }

  // public V2 store (used by the rest of the app)
  const StoreV2 = {
    allOrders(){ return jget(KEYS.orders, []); },
    saveOrders(v){ jset(KEYS.orders, v||[]); },
    allClients(){ return jget(KEYS.clients, []); },
    saveClients(v){ jset(KEYS.clients, v||[]); }
  };

  async function init(){
    migrateOnce();

    // defense in depth on every boot
    const cs = StoreV2.allClients().filter(c=>!badName(c.name)&&!badPhone(c.phone));
    let seed=[...cs];
    for (const c of cs) if (badCode(c.code)){ c.code=null; }
    for (const c of cs) if (!c.code){ c.code = nextClientCodeFrom(seed); seed.push(c); }
    StoreV2.saveClients(cs);

    const allowedStage = new Set(['pranim','pastrim','gati','dorezuar']);
    const os = StoreV2.allOrders().filter(o=>allowedStage.has(o.stage||''));
    // rebind client_code from client record
    for (const o of os){
      const c = cs.find(x => x.id === o.client_id);
      if (c && o.client_code !== c.code) o.client_code = c.code;
    }
    StoreV2.saveOrders(os);

    // mark version
    const meta = jget(KEYS.meta, {});
    jset(KEYS.meta, { ...meta, version: V });
  }

  // expose
  window.TepihaAuto = { init, Store: StoreV2 };
})();