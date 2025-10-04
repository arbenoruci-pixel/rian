
/* assets/tepiha_boot.js — PRANIMI-only: code generation single-flight + photo per row + reset on KODI hold */
(function(){
  const IS_PRANIMI = !!document.querySelector('#pranimi, .screen-pranimi, [data-screen="pranimi"], [data-page="pranimi"]');
  if (!IS_PRANIMI) return;

  const CFG = { bucket: 'tepiha-photos' };
  const SB = () => (window.sb || window.supabase || window.supabaseClient || null);

  // ---- KODI manager (single-flight). Also intercepts supabase.rpc('next_code') globally to avoid double burns.
  const KODI = {
    inflight: null,
    badgeEl: null,
    getBadge(){
      if (this.badgeEl) return this.badgeEl;
      let b = document.getElementById('kodi_badge') || document.querySelector('[data-kodi-badge]');
      if (!b) {
        b = document.createElement('div'); b.id='kodi_badge'; b.textContent='KODI: --';
        Object.assign(b.style, {position:'fixed',left:'10px',top:'8px',background:'rgba(10,36,20,.92)',
          border:'1px solid #1f5937',color:'#bdf7d1',borderRadius:'14px',padding:'6px 10px',
          zIndex: 1000, fontWeight:700, fontSize:'14px', pointerEvents:'auto', userSelect:'none'});
        document.body.appendChild(b);
        // Long-press to reset
        let t=null;
        const start=()=>{ t=setTimeout(()=>{ if(confirm('Factory reset? This clears local data and reloads.')){ try{localStorage.clear(); sessionStorage && sessionStorage.clear();}catch(e){} location.reload(); } }, 1200); };
        const end=()=>{ if(t){ clearTimeout(t); t=null; } };
        b.addEventListener('touchstart', start, {passive:true}); b.addEventListener('mousedown', start);
        ['touchend','touchcancel','mouseup','mouseleave'].forEach(ev=> b.addEventListener(ev, end));
      }
      this.badgeEl = b; return b;
    },
    async _fetch(){
      const s = SB(); if (!s || !s.rpc) throw new Error('supabase client missing');
      const r = await s.rpc('next_code'); if (r.error) throw r.error;
      const n = Number(r.data); if (!Number.isFinite(n) || n <= 0) throw new Error('bad rpc data');
      return n;
    },
    async ensure(){
      const order = (window.currentOrder ||= {});
      if (Number.isInteger(order.code_n) && order.code_n > 0) {
        this.getBadge().textContent = `KODI: -${order.code_n}`; return order.code_n;
      }
      if (!this.inflight) this.inflight = (async()=>{
        try {
          const n = await this._fetch();
          order.code_n = n; order.code = `-${n}`;
          try{ localStorage.setItem('kodi_last', String(n)); }catch(e){}
          return n;
        } catch(e) {
          console.warn('[KODI] RPC failed:', e.message||e);
          this.getBadge().textContent = 'KODI: temp';
          return null;
        }
      })();
      const n = await this.inflight;
      if (n) this.getBadge().textContent = `KODI: -${n}`;
      return n;
    },
    interceptRpc(){
      const s = SB(); if (!s || s.__rpcWrapped) return;
      const orig = s.rpc && s.rpc.bind(s);
      if (!orig) return;
      s.rpc = async (fn, params) => {
        if (fn === 'next_code') {
          const n = await KODI.ensure();
          return { data: n, error: null };
        }
        return orig(fn, params);
      };
      s.__rpcWrapped = true;
    }
  };

  // ---- Photo per row (one camera per created line across sections)
  function fileToDataUrl(file, maxW=1200, q=0.82){
    return new Promise((resolve,reject)=>{
      const img=new Image(), rdr=new FileReader();
      rdr.onload=()=>{ img.src=rdr.result; }; rdr.onerror=reject;
      img.onload=()=>{ const scale=Math.min(1, maxW/img.width); const w=Math.round(img.width*scale), h=Math.round(img.height*scale);
        const c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d').drawImage(img,0,0,w,h);
        resolve(c.toDataURL('image/jpeg', q)); };
      rdr.readAsDataURL(file);
    });
  }
  async function upload(path, dataUrl){
    try {
      const s = SB(); if (!s || !s.storage) return null;
      const base64 = dataUrl.split(',')[1];
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const { error } = await s.storage.from(CFG.bucket).upload(path, bytes, { contentType:'image/jpeg', upsert:true });
      if (error){ console.warn('[photo upload]', error.message); return null; }
      const { data } = s.storage.from(CFG.bucket).getPublicUrl(path);
      return (data && data.publicUrl) || null;
    } catch(e) { console.warn('[photo upload]', e.message||e); return null; }
  }
  function enhanceRow(row, idx){
    if (!row || row.querySelector('.piece-photo-one')) return;
    // pick an anchor (something visible in the row)
    const anchor = row.querySelector('label, .label, .name, span, strong, button') || row;
    const box=document.createElement('span'); box.className='piece-photo-one';
    Object.assign(box.style,{display:'inline-flex',gap:'6px',alignItems:'center',marginLeft:'8px'});
    const lbl=document.createElement('label'); lbl.textContent='📷';
    const input=document.createElement('input'); input.type='file'; input.accept='image/*'; input.capture='environment'; input.style.display='none';
    const img=document.createElement('img'); Object.assign(img.style,{width:'36px',height:'36px',borderRadius:'8px',objectFit:'cover',display:'none',border:'1px solid var(--line,#2a2a2a)'});
    const id='piece_photo_input_'+(row.dataset.idx||idx||0); input.id=id; lbl.setAttribute('for', id);
    box.appendChild(lbl); box.appendChild(input); box.appendChild(img);
    anchor.parentNode && anchor.parentNode.insertBefore(box, anchor.nextSibling);

    const order=(window.currentOrder ||= {}); const i=Number(row.dataset.idx||idx||0);
    input.onchange = async (e)=>{
      const f=e.target.files && e.target.files[0]; if(!f) return;
      const dataUrl=await fileToDataUrl(f); img.src=dataUrl; img.style.display='inline-block';
      const code=order.code || ('temp-'+Date.now()); const path=`orders/${code}/piece-${i}.jpg`;
      const publicUrl = await upload(path, dataUrl);
      order.items = order.items || []; order.items[i] = order.items[i] || {}; order.items[i].photo_url = publicUrl || null;
      try{ localStorage.setItem(`photo_piece_${code}_${i}`, dataUrl); }catch(e){}
    };
  }
  function scanRows(){
    const rows = Array.from(document.querySelectorAll('.piece-row, .staza-row, .shkallore-row, .row.item, li.item, tr.item'));
    rows.forEach((row, idx)=> enhanceRow(row, idx));
  }

  // ---- Boot
  async function boot(){
    // Suppress noisy alerts mentioning next_code so UI isn't blocked
    const origAlert = window.alert;
    window.alert = function(msg){ if (typeof msg==='string' && msg.toLowerCase().includes('next_code')) { console.warn('[alert suppressed]', msg); return; } return origAlert.apply(this, arguments); };

    KODI.interceptRpc();
    await KODI.ensure();
    scanRows();
    setInterval(scanRows, 1500); // keep enhancing dynamically added rows
  }
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot, {once:true}); else boot();
})();
