
(function(){
  function pick(txts){ const qs = Array.from(document.querySelectorAll('input,textarea,button,a')); const n=window.norm;
    for(const el of qs){ const h=n((el.placeholder||'')+' '+(el.textContent||'')+' '+(el.id||'')+' '+(el.name||'')); 
      for(const t of txts){ if(h.includes(n(t))) return el; } } return null; }

  const euro = pick(['€/m', 'cmim', '€/m²', 'euro']);
  const paid = pick(['dha', 'cash', 'paid']);
  const name = pick(['emri', 'name']);
  const phone = pick(['telefon', 'phone']);
  const cc    = document.querySelector('input[value="+383"]') || pick(['+383']);

  // Sum m2 from visible number inputs except money fields
  function sumM2(){
    const nums = Array.from(document.querySelectorAll('input[type=number]'));
    const skip=['eur','€/m','cmim','cmimi','dha','cash','paid'];
    let m2=0, pieces=0;
    for(const i of nums){
      const s=(i.placeholder||'')+' '+(i.id||'')+' '+(i.name||'');
      if(skip.some(k=> window.norm(s).includes(window.norm(k)))) continue;
      const v=Number(i.value||0); if(v>0){ m2+=v; pieces++; }
    }
    const stairs = pick(['shkallore','stairs','step']);
    if (stairs) m2 += Number(stairs.value||0) * 0.3;
    return {m2, pieces};
  }

  async function ensureCodeBadge(){
    const badge = document.querySelector('#kodi_badge, .kodi, [data-code]');
    if (!badge) return null;
    if (badge.dataset.ready==='1') return badge.dataset.code;
    const tmp={}; await Engine.assignCode(tmp);
    badge.textContent = 'KODI: '+tmp.code;
    badge.dataset.ready='1'; badge.dataset.code=tmp.code;
    return tmp.code;
  }

  async function assemble(){
    const code = await ensureCodeBadge();
    const s = sumM2();
    const order = {
      id: uid(), code, code_n:Number(code),
      name: name? name.value.trim() : '',
      phone: (cc?cc.value:'') + (phone?phone.value.trim():''),
      pieces: s.pieces, m2: Number(s.m2||0),
      price_per_m2: Number(euro && euro.value || 0),
      total: Number((euro && euro.value || 0) * (s.m2||0)),
      paid_upfront: paid ? Number(paid.value||0)>0 : false,
      paid_amount: Number(paid && paid.value || 0),
      status: Engine.STATUS.PASTRIM,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    return order;
  }

  function bind(){
    // buttons
    const save = Array.from(document.querySelectorAll('button,a,input')).find(el=> /ruaj/i.test(el.textContent||el.value||''));
    const next = Array.from(document.querySelectorAll('button,a,input')).find(el=> /(vazhdo|continue|next)/i.test(el.textContent||el.value||''));
    if (save) save.addEventListener('click', async e=>{ e.preventDefault(); try{
      const o = await assemble(); if(o.m2<=0) return toast('Shto m²');
      await Engine.clientLocks(o); await Engine.saveOrder(o); toast('U ruajt');
    }catch(err){ alert('Gabim: '+(err.message||err)); }});
    if (next) next.addEventListener('click', async e=>{ e.preventDefault(); try{
      const o = await assemble(); if(o.m2<=0) return toast('Shto m²');
      await Engine.clientLocks(o); await Engine.saveOrder(o); location.href='../pastrimi/index.html';
    }catch(err){ alert('Gabim: '+(err.message||err)); }});
    ensureCodeBadge();
  }

  document.addEventListener('DOMContentLoaded', bind);
})();