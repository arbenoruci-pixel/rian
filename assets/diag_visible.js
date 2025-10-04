
/* assets/diag_visible.js — adds a visible ⚙️ gear on PRANIMI with Self-Check + Factory Reset */
(function(){
  function sb(){ return window.sb || window.supabase || window.supabaseClient || null; }
  function isPranimi(){ return !!document.querySelector('#pranimi, .screen-pranimi, [data-screen="pranimi"], [data-page="pranimi"]'); }
  function makeGear(){
    if (document.getElementById('diag-gear')) return;
    const g=document.createElement('button'); g.id='diag-gear'; g.textContent='⚙️'; g.title='Diagnostics';
    Object.assign(g.style,{position:'fixed',right:'14px',bottom:'14px',zIndex:999998,width:'44px',height:'44px',borderRadius:'12px',background:'#0b0b0d',color:'#e5e7eb',border:'1px solid #2a2a2a',boxShadow:'0 6px 18px rgba(0,0,0,.35)',cursor:'pointer',fontSize:'22px',lineHeight:'44px',textAlign:'center'});
    g.onclick=openMenu; document.body.appendChild(g);
  }
  function menuItem(label, fn){
    const b=document.createElement('button'); b.textContent=label;
    Object.assign(b.style,{display:'block',width:'100%',textAlign:'left',padding:'8px 12px',background:'transparent',color:'#e5e7eb',border:'0',cursor:'pointer'});
    b.onmouseenter=()=>b.style.background='#111'; b.onmouseleave=()=>b.style.background='transparent';
    b.onclick=fn; return b;
  }
  function openMenu(){
    if (document.getElementById('diag-menu')) document.getElementById('diag-menu').remove();
    const wrap=document.createElement('div'); wrap.id='diag-menu';
    Object.assign(wrap.style,{position:'fixed',right:'14px',bottom:'66px',zIndex:999999,background:'#0b0b0d',color:'#e5e7eb',border:'1px solid #2a2a2a',borderRadius:'10px',padding:'6px',minWidth:'220px',fontFamily:'ui-sans-serif,-apple-system',fontSize:'13px'});
    wrap.appendChild(menuItem('Run Self-Check', selfcheck));
    wrap.appendChild(menuItem('Factory Reset', resetAll));
    wrap.appendChild(menuItem('Close', ()=>wrap.remove()));
    document.body.appendChild(wrap);
    setTimeout(()=>{ const onDoc=e=>{ if(!wrap.contains(e.target) && e.target.id!=='diag-gear'){ wrap.remove(); document.removeEventListener('click', onDoc, true);} }; document.addEventListener('click', onDoc, true); },0);
  }
  async function selfcheck(){
    const s=sb(); const out=[];
    out.push('Env: '+(s?'OK ✅':'MISSING ❌'));
    try{ const r=await s.rpc('next_code'); if(r.error) throw r.error; out.push('RPC next_code: '+r.data+' ✅'); } catch(e){ out.push('RPC next_code ERR: '+(e.message||e)+' ❌'); }
    try{ const r=await s.from('orders').select('id',{head:true,count:'exact'}); if(r.error) throw r.error; out.push('orders SELECT ok ✅'); } catch(e){ out.push('orders ERR: '+(e.message||e)+' ❌'); }
    try{ const r=await s.from('payments').select('id',{head:true,count:'exact'}); if(r.error) throw r.error; out.push('payments SELECT ok ✅'); } catch(e){ out.push('payments ERR: '+(e.message||e)+' ❌'); }
    alert(out.join('\n'));
  }
  function resetAll(){ try{ localStorage.clear(); sessionStorage && sessionStorage.clear(); }catch(e){} location.reload(); }
  function boot(){ if(!isPranimi()) return; makeGear(); }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot, {once:true}); else boot();
})();
