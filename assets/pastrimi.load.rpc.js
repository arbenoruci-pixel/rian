
// /assets/pastrimi.load.rpc.js — robust loader by id or code
(function(){
  'use strict';
  function $(s,r){ return (r||document).querySelector(s); }
  async function select(table, params){
    const url = window.SUPABASE_URL || (typeof SUPABASE_URL!=='undefined' && SUPABASE_URL) || 'https://vnidjrxidvusulinozbn.supabase.co';
    const key = window.SUPABASE_ANON_KEY || (typeof SUPABASE_ANON!=='undefined' && SUPABASE_ANON) || '';
    const qp = new URLSearchParams({ select:'*' });
    Object.keys(params||{}).forEach(function(k){ qp.append(k, 'eq.'+String(params[k])); });
    const r = await fetch(url + '/rest/v1/' + table + '?' + qp.toString(), { headers:{'apikey':key,'Authorization':'Bearer '+key} });
    if(!r.ok) throw new Error('select failed '+r.status);
    return await r.json();
  }
  function getParam(n){ return new URLSearchParams(location.search).get(n) || ''; }
  async function load(){
    let id = getParam('id') || localStorage.getItem('last_order_id') || '';
    let rows = [];
    if(id) rows = await select('orders', { id:id });
    if(!rows.length){
      const code = getParam('code') || localStorage.getItem('last_order_code') || '';
      if(code) rows = await select('orders', { code:code });
    }
    if(!rows.length) return;
    const o = rows[0];
    var em = $('#emri'); if(em) em.value = (o.name||'');
    var te = $('#tel');  if(te) te.value = (String(o.phone||'').replace(/^\+?383/, ''));
    if(typeof window.renderItems === 'function'){ try{ window.renderItems(o.items); }catch(_){ } }
    window.__active_order = o;
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
