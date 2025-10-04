// assets/diag_autofix.js — Smart diagnostics + one‑click fixes (non-destructive)
(function(){
  const ID="diag-overlay-rian"; if(document.getElementById(ID)) return;
  const css=`#${ID}{position:fixed;right:12px;bottom:12px;z-index:2147483000;font-family:ui-rounded,system-ui,-apple-system,Segoe UI,Roboto}
  #${ID} .btn{background:#111827;color:#e5e7eb;border:1px solid #374151;padding:10px 14px;border-radius:10px;cursor:pointer;font-size:14px}
  #${ID}.open .panel{display:block}
  #${ID} .panel{display:none;position:fixed;right:12px;bottom:60px;width:360px;max-height:72vh;overflow:auto;background:#0b1220;color:#eaf1ff;border:1px solid #2b3956;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5)}
  #${ID} .panel header{padding:12px 14px;border-bottom:1px solid #1f2e46;font-weight:700;display:flex;align-items:center;justify-content:space-between}
  #${ID} .panel .body{padding:10px 14px;font-size:13px}
  .sec{margin:10px 0;padding:10px;border:1px solid #2b3956;border-radius:10px;background:#101a31}
  .kv{display:flex;justify-content:space-between;gap:10px;margin:6px 0}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  .row button{background:#1e60ff;border:1px solid #15419e;color:#fff;border-radius:8px;padding:8px 10px;font-size:12px;cursor:pointer}
  .row button.warn{background:#c78a2a;border-color:#8a5f16}
  .row button.danger{background:#ef4444;border-color:#b91c1c}
  .ok{color:#16a34a}.warn{color:#c78a2a}.err{color:#ef4444}.mono{font-family:ui-monospace,Menlo,Consolas,monospace}`;
  const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
  const box=document.createElement('div');box.id=ID;box.innerHTML=`<div class="panel"><header><div>DIAGNOSTICS • AUTO-FIX</div><div>${new Date().toLocaleString()}</div></header><div class="body" id="diag-body"></div></div><button class="btn" id="diag-toggle">DIAG</button>`;document.body.appendChild(box);
  document.getElementById('diag-toggle').onclick=()=>{box.classList.toggle('open'); if(box.classList.contains('open')) runAll();};

  const el=(t,c,h)=>{const e=document.createElement(t); if(c) e.className=c; if(h!=null) e.innerHTML=h; return e;};
  const kv=(k,v,cls='')=>{const d=el('div','kv '+cls); d.append(el('span','',k)); d.append(el('span','mono',v)); return d;};
  const J=(k,f)=>{try{const v=localStorage.getItem(k); return v?JSON.parse(v):f;}catch(e){return f;}};
  const W=(k,v)=>localStorage.setItem(k, JSON.stringify(v));
  const page=()=>{const p=location.pathname.toLowerCase(); if(p.includes('pranimi'))return'PRANIMI'; if(p.includes('pastrimi'))return'PASTRIMI'; if(p.includes('gati'))return'GATI'; if(p.includes('marrje'))return'MARRJE SOT'; if(p.includes('arka'))return'ARKA'; return'INDEX';};

  function codeStats(){
    let counter=+(localStorage.getItem('code_counter')||0);
    const orders=J('orders_v1',[]);
    let maxN=0, legacy=0, badFmt=0;
    orders.forEach(o=>{
      const c=o&&o.code;
      if(typeof c==='string' && /^-\d+$/.test(c)){ const n=+c.slice(1); if(n>maxN) maxN=n; }
      else if(c!=null){ if(/^(#|x)/i.test(String(c))) legacy++; else badFmt++; }
    });
    return {counter,maxN,legacy,badFmt,total:orders.length};
  }
  function rebuildFromLegacy(){
    const ids=J('order_list_v1',[]); const out=J('orders_v1',[]); const seen=new Set(out.map(x=>x&&String(x.id)));
    let rebuilt=0; ids.forEach(id=>{ const o=J('order_'+id,null); if(o && !seen.has(String(o.id))){ out.push(o); rebuilt++; } });
    W('orders_v1', out); return {rebuilt};
  }
  function convertAllCodes(){
    const list=J('orders_v1',[]); let changed=0;
    list.forEach(o=>{ if(!o) return; const c=o.code;
      if(typeof c==='string' && /^-\d+$/.test(c)){ o.code_n=+c.slice(1); return; }
      const n=Number(String(c||'').replace(/[^\d]/g,'')); if(Number.isFinite(n)){ o.code='-'+n; o.code_n=n; changed++; }
    }); W('orders_v1', list); return {changed};
  }
  function normalizeStatuses(){
    const list=J('orders_v1',[]); let fixed=0,addedReady=0;
    list.forEach(o=>{ if(!o) return; const m={pranim:'pranim',pastrim:'pastrim',gati:'gati',dorzim:'dorzim','dorëzim':'dorzim','delivered':'dorzim'};
      o.status=m[o.status]||o.status||'pranim';
      if(o.status==='gati' && !o.ready_at){ o.ready_at=new Date().toISOString(); addedReady++; }
    }); W('orders_v1', list); return {fixed,addedReady};
  }
  function ensureShims(){
    const missing=[]; const want={
      saveDraftLocal:function(o){ try{ const L=J('orders_v1',[]); L.push(o||{}); W('orders_v1',L);}catch(e){}},
      mirrorToUnifiedStore:function(o){ try{ let L=J('orders_v1',[]); const i=L.findIndex(x=>x&&String(x.id)===String(o.id)); if(i>=0) L[i]=o; else L.push(o); W('orders_v1',L);}catch(e){}},
      setStatus:function(id,st){ try{ let L=J('orders_v1',[]); const i=L.findIndex(x=>x&&String(x.id)===String(id)); if(i>=0){L[i].status=st; if(st==='gati'&&!L[i].ready_at) L[i].ready_at=new Date().toISOString(); W('orders_v1',L);} }catch(e){}},
      fetchOrdersByStatus:function(st){ try{ return J('orders_v1',[]).filter(x=>x&&x.status===st);}catch(e){return [];} }
    };
    Object.keys(want).forEach(k=>{ if(typeof window[k] !== 'function'){ window[k]=want[k]; missing.push(k); } });
    return {shims:missing};
  }
  function nukeLegacy(){
    const keys=[]; for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(/^order_\d+$/.test(k)) keys.push(k); }
    keys.forEach(k=>localStorage.removeItem(k)); localStorage.removeItem('order_list_v1'); return {removed:keys.length};
  }

  function runAll(){
    const body=document.getElementById('diag-body'); body.textContent='';
    const sec1=el('div','sec'); sec1.append(kv('Page',page())); sec1.append(kv('URL',location.href)); body.append(sec1);

    const cs=codeStats();
    const sec2=el('div','sec'); sec2.append(kv('code_counter',String(cs.counter)));
    sec2.append(kv('max code_n',String(cs.maxN)));
    sec2.append(kv('legacy codes',String(cs.legacy), cs.legacy?'warn':''));
    sec2.append(kv('bad formats',String(cs.badFmt), cs.badFmt?'warn':''));
    const r2=el('div','row');
    const b0=el('button','danger','Reset code_counter → 0'); b0.onclick=()=>{localStorage.setItem('code_counter','0'); alert('code_counter → 0'); runAll();};
    const b1=el('button','warn','Set code_counter = max(existing)'); b1.onclick=()=>{ const t=Math.max(cs.counter,cs.maxN); localStorage.setItem('code_counter',String(t)); alert('code_counter → '+t); runAll(); };
    const b2=el('button','','Convert all codes to -<n>'); b2.onclick=()=>{ const r=convertAllCodes(); alert('Converted '+r.changed+' codes.'); runAll(); };
    sec2.append(r2); r2.append(b0,b1,b2); body.append(sec2);

    const sec3=el('div','sec'); const L=J('orders_v1',[]); 
    sec3.append(kv('orders_v1 total', String(L.length)));
    const row3=el('div','row');
    const b3=el('button','warn','Rebuild orders_v1 from legacy'); b3.onclick=()=>{ const r=rebuildFromLegacy(); alert('Rebuilt '+r.rebuilt+' from legacy.'); runAll(); };
    const b4=el('button','danger','Factory Reset (legacy keys)'); b4.onclick=()=>{ if(confirm('Delete legacy order_* and order_list_v1?')){ const r=nukeLegacy(); alert('Removed '+r.removed+' legacy records.'); runAll(); } };
    sec3.append(row3); row3.append(b3,b4); body.append(sec3);

    const sec4=el('div','sec'); const s=ensureShims();
    sec4.append(kv('missing shims mounted', (s.shims||[]).join(', ') || 'none', s.shims && s.shims.length?'warn':'ok'));
    const row4=el('div','row'); 
    const b5=el('button','','Normalize statuses & add ready_at'); b5.onclick=()=>{ const r=normalizeStatuses(); alert('Statuses normalized: '+r.fixed+', ready_at added: '+r.addedReady); runAll(); };
    sec4.append(row4); row4.append(b5); body.append(sec4);
  }

  setTimeout(()=>{document.getElementById('diag-toggle').click();}, 400);

  // UI host
  const panel=document.createElement('div'); panel.className='panel'; panel.innerHTML='<div class="body" id="diag-body"></div>';
  const btn=document.createElement('button'); btn.id='diag-toggle'; btn.className='btn'; btn.textContent='DIAG';
  const host=document.createElement('div'); host.id=ID; host.append(panel, btn); document.body.appendChild(host);
})();