
/* flow-bind.js — light DOM auto-wire for common buttons/labels */
(function(){
  function onReady(fn){ if (document.readyState!=='loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  function q(sel, root){ return (root||document).querySelector(sel); }
  function qAll(sel, root){ return Array.from((root||document).querySelectorAll(sel)); }
  function findByText(tag, regex){
    regex = (regex instanceof RegExp)? regex : new RegExp(regex, 'i');
    return qAll(tag).find(el => regex.test((el.textContent||'').trim()));
  }
  function getValByLikely(names){
    for (const n of names){
      // by id
      let el = q(`#${n}`);
      if (el && 'value' in el) return el.value;
      // by name
      el = q(`[name="${n}"]`);
      if (el && 'value' in el) return el.value;
      // by label text
      const label = Array.from(document.querySelectorAll('label')).find(l => (l.textContent||'').toLowerCase().includes(n.toLowerCase()));
      if (label){
        const forId = label.getAttribute('for');
        if (forId){
          const target = q(`#${forId}`);
          if (target && 'value' in target) return target.value;
        }
      }
    }
    return '';
  }

  onReady(function(){
    // PRANIMI — look for a save/continue button
    const pranimBtn = findByText('button, a, div', /(VAZHDO|RUAJ|SAVE|CONTINUE)/i);
    if (pranimBtn && !pranimBtn.dataset.flowBound){
      pranimBtn.dataset.flowBound = '1';
      pranimBtn.addEventListener('click', function(ev){
        try{
          const name = getValByLikely(['emri','name','klienti','clientName']);
          const phone = getValByLikely(['telefoni','phone','tel','clientPhone']);
          const total = getValByLikely(['total','totali','shuma']);
          const id = Date.now();
          const transport = true; // always on per user preference
          window.Flow && window.Flow.createFromPranim({id, name, phone, total, transport});
          console.log('[FLOW] PRANIMI→PASTRIMI', {id, name, phone, total});
        }catch(e){ console.warn('[FLOW] PRANIMI bind error', e); }
      }, {once:false});
    }

    // PASTRIMI — mark GATI
    const gatiBtn = findByText('button, a, div', /(GATI|BËJE GATI)/i);
    if (gatiBtn && !gatiBtn.dataset.flowBound){
      gatiBtn.dataset.flowBound = '1';
      gatiBtn.addEventListener('click', function(){
        const idText = getValByLikely(['orderId','id']);
        const id = idText || (window.currentOrderId || null);
        if (id) window.Flow && window.Flow.markGati(id);
      });
    }

    // GATI — pay & deliver → MARRJE SOT + ARKA
    const payBtn = findByText('button, a, div', /(PAGUAR|DORËZUAR|PAGUAR\s*&\s*DORËZUAR|DELIVER|PAY)/i);
    if (payBtn && !payBtn.dataset.flowBound){
      payBtn.dataset.flowBound = '1';
      payBtn.addEventListener('click', function(){
        const idText = getValByLikely(['orderId','id']);
        const id = idText || (window.currentOrderId || null);
        const amount = getValByLikely(['paguar','amount','paid','total','totali','shuma']) || 0;
        if (id) window.Flow && window.Flow.markPaidAndDeliver({id, amount, method:'cash'});
      });
    }
  });
})();