
window.norm=(s)=> (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
window.uid=()=> (crypto.randomUUID?crypto.randomUUID():(Date.now().toString(36)+Math.random().toString(36).slice(2,10)));
window.toast=(m)=>{try{const t=document.createElement('div');t.style.position='fixed';t.style.left='50%';t.style.transform='translateX(-50%)';t.style.bottom='16px';t.style.background='rgba(0,0,0,.85)';t.style.color='#fff';t.style.padding='10px 14px';t.style.borderRadius='10px';t.style.zIndex='99999';t.textContent=m;document.body.appendChild(t);setTimeout(()=>t.remove(),1500);}catch(e){console.log(m);}}
