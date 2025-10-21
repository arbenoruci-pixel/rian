// /assets/arka.js — show today’s picked orders (payments)
import { select } from '/assets/supabase.js';

function startOfDayISO() {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.toISOString();
}

async function load() {
  const list = document.querySelector('#list');
  const sum  = document.querySelector('#sum');
  if (list) list.innerHTML = '<div class="small">Duke lexuar…</div>';
  if (sum)  sum.textContent = 'Total sot: €0.00';

  const rows = await select('orders', {
    select: '*',
    order: 'picked_at.desc',
    'picked_at': 'gte.' + startOfDayISO()
  });

  if (list) list.innerHTML = '';
  if (!rows.length) {
    if (list) list.innerHTML = '<div class="small">S’ka pagesa sot</div>';
    return;
  }

  let total = 0;
  for (const r of rows) {
    total += Number(r.total || 0);
    const d = document.createElement('div');
    d.className = 'row';
    d.innerHTML = `
      <div class="badge">${r.code || ''}</div>
      <div>${(r.name || '').trim()}<div class="small">${r.phone || ''}</div></div>
      <div>€${Number(r.total || 0).toFixed(2)}</div>
    `;
    list && list.appendChild(d);
  }
  if (sum) sum.textContent = `Total sot: €${total.toFixed(2)}`;
}

window.addEventListener('DOMContentLoaded', () => {
  load().catch(err => {
    console.error('[ARKA] load failed:', err);
    const list = document.querySelector('#list');
    if (list) list.innerHTML = `<div class="small">Gabim: ${String(err.message || err)}</div>`;
  });
});


import { listArchived, restoreOrder } from '/assets/archive.js';

async function loadArchive(){
  const list = document.querySelector('#archive-list'); if(!list) return;
  list.innerHTML = '<div class="small">Duke lexuar…</div>';
  const rows = await listArchived();
  list.innerHTML = '';
  if(!rows.length){ list.innerHTML = '<div class="small">Arkiva është bosh</div>'; return; }
  for(const r of rows){
    const d = document.createElement('div'); d.className='row';
    d.innerHTML = `<div class="badge code" data-client="${r.id}">${r.code || ''}</div>
                   <div class="info">${r.name||''} • €${Number(r.total||0).toFixed(2)}</div>
                   <button class="btn" data-restore="${r.id}">KTHE</button>`;
    list.appendChild(d);
  }
}

document.addEventListener('click', async (e)=>{
  const id = e.target?.getAttribute('data-restore'); if(!id) return;
  await restoreOrder(id);
  await loadArchive();
});

// Extend existing load() if present: call both
(() => {
  const _old = (typeof load === 'function') ? load : null;
  async function loadBoth(){ if(_old) await _old(); await loadArchive(); }
  window.addEventListener('DOMContentLoaded', loadBoth, {once:true});
})();
