// assets/gati.js
import { select, update } from '/assets/supabase.js';

function cls(ready_at){
  if(!ready_at) return '';
  const d=Math.floor((Date.now()-new Date(ready_at).getTime())/86400000);
  if(d<=0) return 'gati-today'; if(d==1) return 'gati-nextday'; return 'gati-old';
}

async function load(){
  const rows=await select('orders',{select:'*',status:'eq.gati',order:'ready_at.asc'});
  const list=document.querySelector('[data-gati-list]'); list.innerHTML='';
  if(!rows.length){ list.innerHTML='<div class="small">S’ka porosi në GATI</div>'; return; }
  rows.forEach(r=>{
    const d=document.createElement('div'); d.className='row '+cls(r.ready_at);
    d.innerHTML=`<div class="code badge">${r.code}</div>
                 <div class="info">${r.name||''} • ${r.pieces||0} copë • €${(r.total||0).toFixed(2)}</div>
                 <button class="btn ghost" data-client="${r.id}">📋 DETAJE</button>
                 <button class="btn" data-dorzim="${r.id}">PAGUAR & DORËZUAR</button>`;
    list.appendChild(d);
  });
}
document.addEventListener('click',async (e)=>{
  const id=e.target?.getAttribute('data-dorzim'); if(!id) return;
  await update('orders',{status:'dorzim',updated_at:new Date().toISOString(),picked_at:new Date().toISOString()},{id});
  await load();
});
window.addEventListener('DOMContentLoaded',load);


document.addEventListener('click', (e)=>{
  const cid = e.target?.getAttribute('data-client'); if(!cid) return;
  try{ window.openClientById && window.openClientById(cid); }catch(err){ console.warn(err); }
});
