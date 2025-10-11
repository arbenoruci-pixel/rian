/* ===== Cloud sync (orders) — additive, non-breaking ===== */
(function(){
  const LS_STORE_KEY = "orders_v1";
  function loadStore(){ try{ return JSON.parse(localStorage.getItem(LS_STORE_KEY)||"{}"); }catch(e){ return {}; } }
  function saveStore(s){ localStorage.setItem(LS_STORE_KEY, JSON.stringify(s)); }

  async function cloudUpsert(order){
    const s = window.TepihaNet && window.TepihaNet.supa && window.TepihaNet.supa();
    if(!s) return null;
    const payload = {...order};
    if(!payload.id) delete payload.id; // let DB assign on insert
    // Don't send 'code' on insert; DB generates
    const { data, error } = await s.from('orders').upsert(payload).select().single();
    if(error){ console.warn('cloudUpsert error', error); return null; }
    return data;
  }

  async function cloudPullAll(){
    const s = window.TepihaNet && window.TepihaNet.supa && window.TepihaNet.supa();
    if(!s) return [];
    const { data, error } = await s.from('orders').select('*').order('created_at', { ascending:false });
    if(error){ console.warn('cloudPullAll error', error); return []; }
    return data || [];
  }

  function mergeCloudIntoLocal(rows){
    const store = loadStore();
    for(const r of rows){
      const local = store[r.id];
      const lu = local && new Date(local.updated_at||0).getTime() || 0;
      const ru = r && new Date(r.updated_at||0).getTime() || 0;
      if(!local || ru >= lu){
        store[r.id] = { ...(local||{}), ...(r||{}) };
      }
    }
    saveStore(store);
  }

  async function syncDownThenRender(renderFn){
    try{
      const rows = await cloudPullAll();
      mergeCloudIntoLocal(rows);
      if(typeof renderFn === 'function') renderFn();
    }catch(e){ console.warn('syncDownThenRender', e); }
  }

  function subscribeRealtime(onChange){
    const s = window.TepihaNet && window.TepihaNet.supa && window.TepihaNet.supa();
    if(!s) return { unsubscribe(){ } };
    const chan = s.channel('orders-changes')
      .on('postgres_changes', { event:'*', schema:'public', table:'orders' }, payload => {
        if(payload.new){ mergeCloudIntoLocal([payload.new]); }
        if(typeof onChange === 'function') onChange(payload);
      })
      .subscribe();
    return { unsubscribe(){ s.removeChannel(chan); } };
  }

  // Monkey-patch core if present
  const core = window.TepihaCore || {};
  const origCreate = core.createOrder;
  const origSet = core.setStatus;
  if(typeof origCreate === 'function'){
    core.createOrder = function(data){
      const order = origCreate(data);
      cloudUpsert(order).then(remote=>{
        if(remote){
          const s = loadStore();
          s[order.id] = { ...s[order.id], ...remote };
          saveStore(s);
        }
      });
      return order;
    }
  }
  if(typeof origSet === 'function'){
    core.setStatus = function(id, status, extra){
      origSet(id, status, extra);
      const s = loadStore(); const o = s[id];
      if(o){ cloudUpsert(o); }
    }
  }
  window.TepihaCore = core;
  window.TepihaSync = { cloudUpsert, cloudPullAll, mergeCloudIntoLocal, syncDownThenRender, subscribeRealtime };
})();