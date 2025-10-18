// /assets/marrje-sot.js
import { select } from '/assets/supabase.js';
import { archiveOrder, isArchivedRow } from '/assets/archive.js';

function isToday(ts){
  if(!ts) return false;
  const d=new Date(ts);
  const n=new Date(); const same = d.getFullYear()==n.getFullYear() && d.getMonth()==n.getMonth() && d.getDate()==n.getDate();
  return same;
}

async function load(){
  const list=document.querySelector('#list'); list.innerHTML='<div class="small">Duke lexuar…</div>';
  const rows=await select('orders',{select:'*',status:'eq.dorzim',order:'picked_at.desc'});
  const filtered=[];
  for(const r of rows){ if(isToday(r.picked_at) && !(await isArchivedRow(r))) filtered.push(r); }
  list.innerHTML='';
  if(!filtered.length){ list.innerHTML='<div class="small">S’ka porosi për t’u shfaqur sot</div>'; return; }
  for(const r of filtered){
    const d=document.createElement('div'); d.className='row';
    d.innerHTML=`<div class="badge code">${r.code}</div>
                 <div class="info">${r.name||''} • ${r.pieces||0} copë • €${(r.total||0).toFixed(2)}</div>
                 <button class="btn arkivo" data-arkivo="${r.id}">ARKIVO</button>`;
    list.appendChild(d);
  }
}

document.addEventListener('click', async (e)=>{
  const id=e.target?.getAttribute('data-arkivo'); if(!id) return;
  await archiveOrder(id);
  // Hide instantly
  const row=e.target.closest('.row'); if(row) row.remove();
});

window.addEventListener('DOMContentLoaded', load);
