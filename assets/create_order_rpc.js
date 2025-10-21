
// /assets/create_order_rpc.js — atomic order creation via RPC
(function(){
  'use strict';
  function $(s,r){ return (r||document).querySelector(s); }
  function $all(s,r){ return Array.from((r||document).querySelectorAll(s)); }
  function n(v){ var x=parseFloat(String(v||'').replace(',', '.')); return isFinite(x)?x:0; }

  async function rpc(fn, args){
    const url = window.SUPABASE_URL || (typeof SUPABASE_URL!=='undefined' && SUPABASE_URL) || 'https://vnidjrxidvusulinozbn.supabase.co';
    const key = window.SUPABASE_ANON_KEY || (typeof SUPABASE_ANON!=='undefined' && SUPABASE_ANON) || '';
    const r = await fetch(url + '/rest/v1/rpc/' + fn, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey': key, 'Authorization':'Bearer '+key },
      body: JSON.stringify(args||{})
    });
    if(!r.ok) throw new Error('RPC '+fn+' failed '+r.status+' '+await r.text());
    try { return await r.json(); } catch(_){ return null; }
  }

  function buildItemsFromUI(){
    const rows = $all('[data-piece-row]');
    const items = [];
    rows.forEach(function(row){
      var t = row.getAttribute('data-type') || 'tepiha';
      var m2 = n( ( $('input[type=number], input.m2', row) || {} ).value );
      if(m2>0) items.push({type:t, m2:m2, photos:[]});
    });
    if(!items.length){
      var nums = $all('input[type=number]');
      var sum = 0; nums.forEach(function(inp){ sum += n(inp.value); });
      if(sum>0) items.push({type:'tepiha', m2:sum, photos:[]});
    }
    return items;
  }
  function calcTotalFromUI(){
    var totalEl = document.getElementById('euroTotal');
    if(totalEl) return n(totalEl.textContent);
    var sum = 0; $all('.price, .total').forEach(function(el){ sum += n(el.textContent||el.value); });
    return sum;
  }

  async function createOrderFromPranim(){
    try{
      const name  = ($('#emri')||{}).value ? $('#emri').value.trim() : ( ($('#name')||{}).value||'' ).trim();
      const phone = ('+383' + ((($('#tel')||{}).value||'').match(/\d+/g)||[]).join('')).trim();
      const items = buildItemsFromUI();
      const total = calcTotalFromUI();
      if(!name) throw new Error('Vendos emrin.');
      const r = await rpc('create_order_with_next_code', { p_name:name, p_phone:phone, p_items: JSON.stringify(items), p_total: total });
      const order = Array.isArray(r) ? r[0]: r;
      if(!order || !order.id) throw new Error('Krijimi dështoi.');
      localStorage.setItem('last_order_id', order.id);
      localStorage.setItem('last_order_code', String(order.code||''));
      window.location.href = '/pastrimi/?id='+encodeURIComponent(order.id);
    }catch(err){
      alert('Ruajtja dështoi: ' + (err && err.message ? err.message : String(err)));
    }
  }

  function wire(){
    const c = document.getElementById('btnContinue');
    if(c){ c.removeAttribute('href'); c.addEventListener('click', function(e){ e.preventDefault(); createOrderFromPranim(); }, false); }
    const s = document.getElementById('btnSaveDraft');
    if(s){ s.addEventListener('click', function(e){ e.preventDefault(); createOrderFromPranim(); }, false); }
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.createOrderFromPranim = createOrderFromPranim;
})();
