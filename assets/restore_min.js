<!-- assets/restore_min.js -->
<script>
(function(){
  // Guards to avoid duplicates
  if (window.__restore_min_ready) return; 
  window.__restore_min_ready = true;

  function q(s,b){ return (b||document).querySelector(s); }
  function qq(s,b){ return Array.from((b||document).querySelectorAll(s)); }
  function round2(x){ return Math.round((x + Number.EPSILON) * 100) / 100; }

  // ===== Core actions (define ONLY if missing) =====
  if (typeof window.addRow !== 'function') {
    window.addRow = function(section, value){
      const list = q('#list-'+section); if(!list) return;
      const row = document.createElement('div'); row.className = 'piece-row';

      const id = document.createElement('div'); id.className = 'piece-id';
      const idx = qq('.piece-row', list).length + 1;
      id.textContent = '#' + String(idx).padStart(2,'0');

      const inp = document.createElement('input');
      inp.className = 'input piece-input';
      inp.placeholder = 'm²';
      inp.inputMode = 'decimal';
      if (value != null) inp.value = value;

      const qty = document.createElement('input');
      qty.className = 'input piece-qty';
      qty.placeholder = 'copë';
      qty.inputMode = 'numeric';
      qty.value = '1';

      inp.addEventListener('input', computeTotalsSafe);
      qty.addEventListener('input', computeTotalsSafe);

      row.appendChild(id);
      row.appendChild(inp);
      row.appendChild(qty);
      list.appendChild(row);

      computeTotalsSafe();
    };
  }

  if (typeof window.removeRow !== 'function') {
    window.removeRow = function(section){
      const list = q('#list-'+section); if(!list) return;
      const rows = qq('.piece-row', list);
      if (rows.length){ rows[rows.length - 1].remove(); computeTotalsSafe(); }
    };
  }

  function sectionTotal(section){
    const list = q('#list-'+section); if(!list) return 0;
    const rows = qq('.piece-row', list);
    const total = round2(rows.reduce((s,row)=>{
      const m2 = parseFloat((row.querySelector('.piece-input')||{}).value||'0')||0;
      const qv = parseFloat((row.querySelector('.piece-qty')||{}).value||'1')||1;
      return s + (m2*qv);
    }, 0));
    const tgt = q('#tot-'+section); if (tgt) tgt.textContent = total.toFixed(2) + ' m²';
    return total;
  }

  function computeStairs(){
    const qty = parseFloat((q('#stairsQty')||{}).value||'0')||0;
    const per = parseFloat((q('#stairsPer')||{}).value||'0.3')||0;
    const m2 = round2(qty * per);
    const out = q('#stairsM2'); if (out) out.textContent = m2.toFixed(2) + ' m²';
    return m2;
  }

  // If the page already defines computeTotals, call it. Otherwise define a safe one.
  function computeTotalsSafe(){
    if (typeof window.computeTotals === 'function') return window.computeTotals();
    const tT = sectionTotal('tepiha');
    const tS = sectionTotal('staza');
    const tStairs = computeStairs();
    const totalM2 = round2(tT + tS + tStairs);
    const rateEl = q('#rate'); const rate = rateEl ? (parseFloat(rateEl.value||'0')||0) : 0;
    const euro = round2(totalM2 * rate);

    const m2El = q('#m2Total'); if (m2El) m2El.textContent = totalM2.toFixed(2);
    const m2F = q('#m2TotalFooter'); if (m2F) m2F.textContent = totalM2.toFixed(2);
    const eurEl = q('#euroTotal'); if (eurEl) eurEl.textContent = euro.toFixed(2);

    const paidToggle = q('#paidUpfront');
    const paidInput = q('#clientPaid');
    const debtOut = q('#debt');
    if (paidToggle && paidInput && debtOut){
      const enabled = !!paidToggle.checked;
      paidInput.disabled = !enabled;
      if(!enabled) paidInput.value = '';
      const paidVal = enabled ? (parseFloat(paidInput.value||'0')||0) : 0;
      const debt = Math.max(0, round2(euro - paidVal));
      debtOut.value = debt.toFixed(2);
    }
  }
  window.computeTotalsSafe = computeTotalsSafe;

  // ===== Wire events (idempotent) =====
  function wireChips(containerId, section){
    const box = q('#'+containerId); if(!box) return;
    if (box.__wired) return; box.__wired = true;
    qq('#'+containerId+' .chip').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const txt=(btn.textContent||'').trim();
        const num=parseFloat(txt.replace(/[^\d\.]/g,'')); 
        if(!isNaN(num)) addRow(section, num); else addRow(section, null);
      });
    });
  }

  function wireInputs(){
    [['#stairsQty','input'],['#stairsPer','input'],['#rate','input'],
     ['#paidUpfront','change'],['#clientPaid','input']].forEach(([sel,ev])=>{
      const el = q(sel); if(!el || el.__wired) return;
      el.addEventListener(ev, computeTotalsSafe);
      el.__wired = true;
    });
  }

  function init(){
    wireChips('chips-tepiha','tepiha');
    wireChips('chips-staza','staza');
    wireInputs();
    computeTotalsSafe();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {once:true});
  } else { init(); }
})();
</script>