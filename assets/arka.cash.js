// /assets/arka.cash.js — Open/Close cash day; expenses list
import { select, insert, update } from '/assets/supabase.js';

function startOfDayISO() { const d=new Date(); d.setHours(0,0,0,0); return d.toISOString(); }
function endOfDayISO()   { const d=new Date(); d.setHours(23,59,59,999); return d.toISOString(); }

async function loadCashUI(){
  const wrap = document.querySelector('#cashbox'); if(!wrap) return;
  wrap.innerHTML = '<div class="small">Duke lexuar…</div>';

  // 1) Find today's session (if any)
  const sessions = await select('cash_sessions', { select:'*', start_at: 'gte.'+startOfDayISO(), end_at: 'lte.'+endOfDayISO(), order:'start_at.desc' }).catch(()=>[]);
  const session = Array.isArray(sessions) && sessions.find(s=>s.start_at) || null;

  // 2) Sum today payments from orders (status=dorzim, picked_at today)
  const orders = await select('orders', { select:'id,total,picked_at,archived,status', status:'eq.dorzim', order:'picked_at.desc' });
  let paidToday = 0;
  for(const r of orders||[]){
    const d = r?.picked_at && new Date(r.picked_at);
    const n = new Date(); const same = d && d.getFullYear()==n.getFullYear() && d.getMonth()==n.getMonth() && d.getDate()==n.getDate();
    if(same){ paidToday += Number(r.total||0); }
  }

  // 3) Load expenses for today (linked to session if exists)
  let expenses = [];
  if (session) {
    expenses = await select('cash_expenses', { select:'*', session_id: 'eq.'+session.id, order:'created_at.desc' }).catch(()=>[]);
  }

  // Render
  const fmt = (n)=> '€'+Number(n||0).toFixed(2);
  const openBlock = !session ? `
    <div class="row">
      <div class="label">HAP DITËN ME CASH</div>
      <input id="cb_open_amount" class="input" type="number" step="0.01" placeholder="Shuma fillestare (€)"/>
      <button id="cb_open" class="btn">HAPE DITËN</button></div>` : '';

  const listExpenses = (expenses||[]).map(e=>`
    <div class="row">
      <div class="info">${e.note||''}</div>
      <div class="badge">${fmt(e.amount)}</div></div>`).join('') || '<div class="small">S’ka shpenzime sot</div>';

  const totalExpenses = (expenses||[]).reduce((a,b)=>a+Number(b.amount||0),0);
  const expected = (Number(session?.open_amount||0) + paidToday - totalExpenses);
  const closeBlock = session ? `
    <div class="section">
      <div class="row"><div><strong>KASA</strong></div></div>
      <div class="row"><div>Hapur:</div><div class="badge">${fmt(session.open_amount||0)}</div></div>
      <div class="row"><div>Pagesat sot:</div><div class="badge">${fmt(paidToday)}</div></div>
      <div class="row"><div>Shpenzime:</div><div class="badge">${fmt(totalExpenses)}</div></div>
      <div class="row"><div><strong>PRITET NË ARKË</strong></div><div class="badge">${fmt(expected)}</div></div>
      <div class="row">
        <div class="label">MBYLL DITËN</div>
        <input id="cb_close_amount" class="input" type="number" step="0.01" placeholder="Cash i numëruar (€)"/>
        <button id="cb_close" class="btn">MBYLLE</button></div></div>

    <div class="section">
      <div class="row"><div><strong>SHTO SHPENZIM</strong></div></div>
      <div class="row">
        <input id="cb_exp_note" class="input" placeholder="Përshkrimi i shpenzimit"/>
        <input id="cb_exp_amount" class="input" type="number" step="0.01" placeholder="Shuma (€)"/>
        <button id="cb_add_exp" class="btn">SHTO</button></div>
      <div id="cb_exp_list">${listExpenses}</div></div>
  ` : '';

  wrap.innerHTML = `
    <div class="section">
      <div class="row"><div><strong>KASA E DITËS</strong></div></div>
      ${openBlock}
      ${closeBlock}
  `;

  // Wire buttons
  wrap.querySelector('#cb_open')?.addEventListener('click', async ()=>{
    const amount = Number(document.querySelector('#cb_open_amount')?.value || 0);
    await insert('cash_sessions', { start_at: new Date().toISOString(), open_amount: amount });
    await loadCashUI();
  });

  wrap.querySelector('#cb_add_exp')?.addEventListener('click', async ()=>{
    const note = String(document.querySelector('#cb_exp_note')?.value || '').trim();
    const amount = Number(document.querySelector('#cb_exp_amount')?.value || 0);
    if(!note || !amount) return alert('Plotëso shënimin dhe shumën');
    await insert('cash_expenses', { session_id: session.id, note, amount, created_at: new Date().toISOString() });
    await loadCashUI();
  });

  wrap.querySelector('#cb_close')?.addEventListener('click', async ()=>{
    const counted = Number(document.querySelector('#cb_close_amount')?.value || 0);
    const diff = counted - expected;
    await update('cash_sessions', { end_at: new Date().toISOString(), close_amount: counted, expected_amount: expected, discrepancy: diff }, { id: session.id });
    await loadCashUI();
  });
}

window.addEventListener('DOMContentLoaded', () => {
  loadCashUI().catch(e=>console.error('[cashbox] failed', e));
});
