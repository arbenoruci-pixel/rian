
// MARRJE SOT list → REAKTIVIZO (back to PRANIM)
document.addEventListener('DOMContentLoaded', ()=>{
  const container = document.getElementById('engine-list') || (()=>{
    const sec = document.createElement('section'); sec.id='engine-list'; sec.style.margin='12px';
    const host = document.querySelector('#list, .list, main, body'); host.prepend(sec); return sec;
  })();

  function row(o){
    const wrap = document.createElement('div'); wrap.style.display='grid';
    wrap.style.gridTemplateColumns='100px 1fr auto'; wrap.style.gap='8px'; wrap.style.alignItems='center';
    wrap.style.padding='12px'; wrap.style.border='1px solid #234'; wrap.style.borderRadius='12px'; wrap.style.margin='8px 0';
    const left = document.createElement('div'); left.textContent = '#'+o.code;
    const mid = document.createElement('div'); mid.innerHTML = (o.name||'') + '<br><span style="opacity:.7">'+(o.pieces||0)+' copë • '+(o.m2||0)+' m² • €'+(o.total||0)+'</span>';
    const btn = document.createElement('button'); btn.textContent = 'REAKTIVIZO'; btn.style.padding='10px 12px'; btn.style.borderRadius='10px'; btn.style.border='1px solid #456'; btn.style.background='#18222e'; btn.style.color='#fff';
    btn.onclick = async ()=>{ await Engine.saveOrder(Object.assign(o,{status:Engine.STATUS.PRANIM})); load(); };
    const act = document.createElement('div'); act.appendChild(btn);
    wrap.append(left, mid, act); return wrap;
  }

  async function load(){
    container.innerHTML = '<div style="opacity:.6">Duke ngarkuar…</div>';
    try{
      const items = (await Engine.list(Engine.STATUS.DORZIM)) || [];
      container.innerHTML = '';
      if(!items.length){ container.innerHTML = '<div style="opacity:.7;padding:10px;border:1px solid #223;border-radius:12px">S’ka marrje sot.</div>'; return; }
      items.forEach(o=> container.appendChild(row(o)));
    }catch(e){
      container.innerHTML = '<div style="color:#f66">Gabim: '+(e.message||e)+'</div>';
    }
  }
  load();
});
