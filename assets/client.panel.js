
// /assets/client.panel.js — controls the Client Template panel on all pages
import { select } from '/assets/supabase.js';

function $(s,r=document){ return r.querySelector(s); }

async function ensureTemplate(){
  if ($('#client-template')) return;
  try {
    const r = await fetch('/assets/client.template.html');
    const t = await r.text();
    const d = document.createElement('div'); d.innerHTML = t;
    document.body.appendChild(d);
  } catch(e){ console.warn('[client.panel] template load failed', e); }
}

export async function openClientById(id){
  await ensureTemplate();
  const panel = $('#client-template'); if (!panel) return;
  panel.style.display = 'block'; panel.setAttribute('data-order-id', String(id));

  // Load order
  let row = null;
  try {
    const rows = await select('orders', { select:'*', id: 'eq.'+id, limit: '1' });
    row = Array.isArray(rows) ? rows[0] : null;
  } catch(e){ console.error('[client.panel] select failed', e); }

  if (!row){
    $('#ct_code').textContent = '(?)';
    $('#ct_name').textContent = '';
    $('#ct_phone').textContent = '';
    $('#ct_pieces').textContent = '0';
    $('#ct_m2').textContent = '0';
    $('#ct_total').textContent = '0.00';
    $('#ct_debt').textContent = '0.00';
  } else {
    $('#ct_code').textContent = row.code || '';
    $('#ct_name').textContent = row.name || '';
    $('#ct_phone').textContent = row.phone || '';
    $('#ct_pieces').textContent = row.pieces || 0;
    $('#ct_m2').textContent = Number(row.m2||0).toFixed(2);
    $('#ct_total').textContent = Number(row.total||0).toFixed(2);
    const paid = Number(row.paid_amount||0);
    const debt = Number(row.total||0) - paid;
    $('#ct_debt').textContent = debt.toFixed(2);
    // Photos
    const ph = $('#ct_photos'); if (ph){ ph.innerHTML = ''; (row.photos||[]).forEach(url=>{
      const img = document.createElement('img'); img.className='avatar-thumb'; img.src = url; ph.appendChild(img);
    }); }
    // Notes
    const nt = $('#ct_note'); if (nt){ nt.value = row.note || ''; }
  }

  $('#ct_close')?.addEventListener('click', ()=>{ panel.style.display='none'; }, {once:true});
}

// Global shim
try{
  if (typeof window !== 'undefined' && !window.__CLIENT_PANEL__){
    window.__CLIENT_PANEL__ = true;
    window.openClientById = openClientById;
  }
}catch{}


function fmt(n){ return Number(n||0).toFixed(2); }

async function handlePaymentApply(orderId){
  const amtEl = document.querySelector('#ct_pay_amount');
  const msg = document.querySelector('#ct_pay_msg');
  if(!amtEl) return;
  const add = Number(amtEl.value||0);
  if(!add || add <= 0){ if(msg) msg.textContent='Shkruaj shumën'; return; }
  try{
    const rows = await select('orders', { select:'id,total,paid_amount', id:'eq.'+orderId, limit:'1' });
    const row = Array.isArray(rows) ? rows[0] : null;
    const currentPaid = Number(row?.paid_amount||0);
    const newPaid = currentPaid + add;

    const { update } = await import('/assets/supabase.js');
    await update('orders', { paid_amount: newPaid, updated_at: new Date().toISOString() }, { id: orderId });

    const total = Number(row?.total||0);
    const debt = total - newPaid;
    const debtEl = document.querySelector('#ct_debt');
    const totalEl = document.querySelector('#ct_total');
    if(debtEl) debtEl.textContent = fmt(debt);
    if(totalEl) totalEl.textContent = fmt(total);

    if(msg){ msg.textContent='U ruajt'; setTimeout(()=> msg.textContent='', 1500); }
    amtEl.value = '';
  }catch(e){
    console.error('[client.panel] pagesa dështoi', e);
    if(msg){ msg.textContent='Dështoi'; setTimeout(()=> msg.textContent='', 2000); }
  }
}

document.addEventListener('click', (e)=>{
  if(e.target && e.target.id === 'ct_pay_btn'){
    const panel = document.querySelector('#client-template');
    const oid = panel && panel.getAttribute('data-order-id');
    if(oid) handlePaymentApply(oid);
  }
});

document.addEventListener('click', (e)=>{
  if(e.target && (e.target.id === 'ct_close' || e.target.id === 'ct_close_x')){
    const panel = document.querySelector('#client-template'); if(panel) panel.style.display='none';
  }
});
