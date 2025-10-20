// Minimal shared payment panel logic
window.PaymentPanel = (function(){
  let order = null;
  async function openPayment(o){
    order = o || {};
    const host = document.body;
    if(!document.getElementById('payment-panel')){
      const html = await fetch('assets/payment.panel.html').then(r=>r.text());
      const tmp = document.createElement('div'); tmp.innerHTML = html;
      const node = tmp.firstElementChild; host.appendChild(node);
      wire(node);
    }
    const priceInput = document.getElementById('pp_price_m2');
    const paidInput = document.getElementById('pp_paid_amount');
    const m2Span = document.getElementById('pp_m2_total');
    const totalSpan = document.getElementById('pp_total');
    const debtSpan = document.getElementById('pp_debt');
    priceInput.value = (order.price_per_m2 ?? order.pricePerM2 ?? 0);
    paidInput.value = (order.paid_amount ?? order.paidAmount ?? 0);
    m2Span.textContent = (order.m2 ?? order.total_m2 ?? 0);
    const total = ((+priceInput.value||0) * (+m2Span.textContent||0));
    totalSpan.textContent = total.toFixed(2);
    debtSpan.textContent = (total - (+paidInput.value||0)).toFixed(2);
    document.getElementById('payment-panel').style.display = 'block';
  }
  function wire(root){
    const priceInput = root.querySelector('#pp_price_m2');
    const paidInput = root.querySelector('#pp_paid_amount');
    const m2Span = root.querySelector('#pp_m2_total');
    const totalSpan = root.querySelector('#pp_total');
    const debtSpan = root.querySelector('#pp_debt');
    function recalc(){
      const total = ((+priceInput.value||0) * (+m2Span.textContent||0));
      totalSpan.textContent = total.toFixed(2);
      const debt = total - (+paidInput.value||0);
      debtSpan.textContent = debt.toFixed(2);
    }
    priceInput.addEventListener('input', recalc);
    paidInput.addEventListener('input', recalc);
    root.querySelector('#pp_close').addEventListener('click', ()=>{
      root.style.display = 'none';
    });
    root.querySelector('#pp_save').addEventListener('click', async ()=>{
      try{
        order.price_per_m2 = +priceInput.value||0;
        order.paid_amount = +paidInput.value||0;
        order.total = +totalSpan.textContent||0;
        order.debt = +debtSpan.textContent||0;
        if(window.Tepiha && Tepiha.saveOrder){
          await Tepiha.saveOrder(order);
        } else if(window.saveOrder){
          await window.saveOrder(order);
        }
        alert('Pagesa u ruajt.');
        root.style.display = 'none';
      }catch(e){
        console.error(e);
        alert('Nuk u ruajt pagesa: '+(e && e.message ? e.message : e));
      }
    });
  }
  return { openPayment };
})();