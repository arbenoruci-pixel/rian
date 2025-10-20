
(function(){
  const BTN_ID = 'global-search-btn';

  function installButton(){
    if(document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = 'KËRKO';
    btn.style.position='fixed';
    btn.style.right='10px';
    btn.style.top='10px';
    btn.style.zIndex='9998';
    btn.style.padding='6px 10px';
    btn.style.border='1px solid #1e60ff';
    btn.style.background='#1e60ff';
    btn.style.color='#fff';
    btn.style.borderRadius='8px';
    btn.style.fontWeight='600';
    btn.style.fontSize='12px';
    btn.style.opacity='0.9';
    btn.style.letterSpacing='0.6px';
    btn.addEventListener('click', open);
    document.body.appendChild(btn);
  }

  async function ensureOverlay(){
    if(document.getElementById('global-search')) return;
    let html=null;
    try{ html = await fetch('../assets/search.panel.html').then(r=>r.text()); }catch(e){}
    if(!html){ html = await fetch('assets/search.panel.html').then(r=>r.text()); }
    const div = document.createElement('div'); div.innerHTML = html.trim();
    document.body.appendChild(div.firstElementChild);
    wire();
  }

  function wire(){
    const root = document.getElementById('global-search');
    root.querySelector('#gs_close').addEventListener('click', close);
    const q = root.querySelector('#gs_query');
    let t=null;
    q.addEventListener('input', ()=>{
      clearTimeout(t);
      t = setTimeout(()=>doSearch(q.value.trim()), 180);
    });
  }

  async function open(){
    await ensureOverlay();
    const root = document.getElementById('global-search');
    root.style.display = 'block';
    const q = document.getElementById('gs_query');
    q.value=''; document.getElementById('gs_results').innerHTML='';
    q.focus();
  }
  function close(){ const root=document.getElementById('global-search'); if(root) root.style.display='none'; }

  async function doSearch(query){
    const box = document.getElementById('gs_results');
    if(!query){ box.innerHTML=''; return; }
    try{
      let results = [];
      if(window.Tepiha?.searchClients){
        results = await Tepiha.searchClients(query); // expects [{name, phone, code, order_id}]
      }else{
        results = localSearch(query);
      }
      renderResults(results||[]);
    }catch(e){
      console.error(e);
      box.innerHTML = '<div style="padding:8px;color:#f87171">Gabim gjatë kërkimit.</div>';
    }
  }

  function localSearch(query){
    const q = query.toLowerCase();
    const list = [];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(!/^order_/.test(k)) continue;
      try{
        const o = JSON.parse(localStorage.getItem(k)||'{}');
        const code = (o.code||'').toString();
        const name = (o.name||'').toLowerCase();
        const phone= (o.phone||'').toLowerCase();
        if(code.includes(q) || name.includes(q) || phone.includes(q)){
          list.push({ name:o.name, phone:o.phone, code:o.code, order_id:o.id });
        }
      }catch{}
    }
    return list;
  }

  function renderResults(results){
    const box = document.getElementById('gs_results');
    if(!results.length){ box.innerHTML = '<div style="padding:8px;color:#94a3b8">S’ka rezultate.</div>'; return; }
    box.innerHTML = results.map((r,i)=>{
      const name = r.name || '(pa emër)';
      const phone = r.phone || '-';
      const code = (r.code!=null) ? r.code : '';
      return `<div class="res" data-id="${r.order_id||''}" data-code="${code}" data-phone="${phone}" style="padding:8px;border-bottom:1px solid #2c3a55;cursor:pointer">
        <div style="font-weight:700">${name}</div>
        <div style="opacity:.8">tel: ${phone} • kod: ${code}</div></div>`;
    }).join('');
    box.querySelectorAll('.res').forEach(el=>{
      el.addEventListener('click', async ()=>{
        const id = el.dataset.id;
        const code = el.dataset.code;
        const phone = el.dataset.phone;
        if(window.ClientTemplate){
          if(id) await ClientTemplate.openByOrderId(id);
          else if(code) await ClientTemplate.openByCode(code);
          else if(phone) await ClientTemplate.openByPhone(phone);
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    installButton();
    ensureOverlay();
    if(window.ClientTemplate?.ensureOverlay) ClientTemplate.ensureOverlay();
  });
})();
