// /assets/photo.interaction.patch.js
// Tap = preview. Long-press = action menu (Retake / Delete / Cancel).
// Retake overwrites the existing thumb; Delete clears it. Works with your current rows.

(function () {
  const LONG_PRESS_MS = 500;

  // ---------- Minimal preview modal ----------
  const style = document.createElement('style');
  style.textContent = `
    .photo-modal__backdrop{position:fixed;inset:0;background:rgba(10,14,20,.86);display:none;align-items:center;justify-content:center;z-index:9999}
    .photo-modal__img{max-width:96vw;max-height:86vh;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
    .photo-modal__hint{position:fixed;bottom:16px;left:0;right:0;text-align:center;color:#cfe1ff;font-size:12px;opacity:.8}
    .photo-modal__backdrop.show{display:flex}

    .photo-sheet{position:fixed;z-index:10000;min-width:180px;background:#0f1522;border:1px solid #273143;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden}
    .photo-sheet__btn{display:block;width:100%;padding:10px 14px;background:none;border:none;color:#eaf1ff;text-align:left;font:600 13px/1.2 system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif}
    .photo-sheet__btn:hover{background:#111a2a}
    .photo-sheet__btn.danger{color:#ff7b7b}
  `;
  document.head.appendChild(style);

  const modal = document.createElement('div');
  modal.className = 'photo-modal__backdrop';
  modal.innerHTML = `
    <img class="photo-modal__img" alt="">
    <div class="photo-modal__hint">Tap anywhere to close • Hold photo icon for options</div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', () => modal.classList.remove('show'));

  function openPreview(src) {
    const img = modal.querySelector('.photo-modal__img');
    img.src = src || '';
    modal.classList.add('show');
  }

  // ---------- Small action sheet near the button ----------
  let sheet;
  function closeSheet(){ if(sheet){ sheet.remove(); sheet=null; } }
  function openSheet(x, y, opts){
    closeSheet();
    sheet = document.createElement('div');
    sheet.className = 'photo-sheet';
    sheet.style.left = Math.max(8, Math.min(window.innerWidth-200, x-90)) + 'px';
    sheet.style.top  = Math.max(8, Math.min(window.innerHeight-160, y+12)) + 'px';

    opts.forEach(o=>{
      const b = document.createElement('button');
      b.className = 'photo-sheet__btn'+(o.danger?' danger':'');
      b.textContent = o.label;
      b.addEventListener('click', ()=>{ closeSheet(); o.onClick(); });
      sheet.appendChild(b);
    });

    document.body.appendChild(sheet);
    // Close on outside click / escape
    setTimeout(()=>{
      const off = (ev)=>{ if(!sheet || sheet.contains(ev.target)) return; closeSheet(); document.removeEventListener('click',off); };
      document.addEventListener('click', off);
      const esc = (ev)=>{ if(ev.key==='Escape'){ closeSheet(); document.removeEventListener('keydown',esc); } };
      document.addEventListener('keydown', esc);
    }, 0);
  }

  // ---------- DOM helpers ----------
  function ensureThumb(btn){
    let img = btn.querySelector('img.thumb');
    if(!img){
      img = document.createElement('img');
      img.className = 'thumb';
      Object.assign(img.style, {
        position:'absolute', inset:'0', width:'100%', height:'100%',
        objectFit:'cover', borderRadius:'10px', display:'none', zIndex:'2'
      });
      btn.style.position = 'relative';
      btn.appendChild(img);
    }
    return img;
  }
  function setThumb(img, src){
    if(!img) return;
    if(src){ img.src = src; img.style.display='block'; }
    else    { img.src = '';  img.style.display='none'; }
  }
  function findRow(el){
    return el.closest('.piece-row') || el.closest('[data-row]') || el.closest('li') || el.closest('tr') || el.parentElement;
  }
  function getRowKind(row){
    // Best-effort: prefer dataset.kind; else infer by list parent id
    const k = (row?.dataset?.kind||'').toLowerCase();
    if(k) return k;
    const list = row && row.closest('[id^="list-"]');
    if(list){ return list.id.replace('list-',''); }
    return 'tepiha';
  }
  function kindStorageKey(kind){
    if(/shk|stair/.test(kind)) return 'stairs_photo_thumb';
    return 'client_photo_thumb';
  }
  function ensureFileInput(row){
    let inp = row.querySelector('input[type="file"].photo-picker');
    if(!inp){
      inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.capture = 'environment';
      inp.className = 'photo-picker';
      inp.style.display = 'none';
      row.appendChild(inp);
    }
    return inp;
  }
  function readFileAsDataURL(file){
    return new Promise((resolve, reject)=>{
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result||'')); fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  // ---------- Press logic ----------
  let pressTimer = null, pressTarget = null, longPressed = false, pressPoint = {x:0,y:0};

  function clearPress(){
    if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    pressTarget = null; longPressed=false;
  }

  function startPress(e){
    const btn = e.target.closest('.cam-btn');
    if(!btn) return;
    pressTarget = btn;
    longPressed = false;
    const p = (e.touches && e.touches[0]) ? e.touches[0] : e;
    pressPoint = { x: p.clientX || 0, y: p.clientY || 0 };

    pressTimer = setTimeout(()=>{ longPressed = true; showOptions(btn, pressPoint.x, pressPoint.y); }, LONG_PRESS_MS);
  }

  function endPress(e){
    const btn = e.target.closest('.cam-btn');
    if(!btn){ clearPress(); return; }
    if(!longPressed){
      // TAP
      const img = btn.querySelector('img.thumb');
      const hasPhoto = img && img.src && img.style.display !== 'none';
      if(hasPhoto){ openPreview(img.src); }
      else        { quickTake(btn); }
    }
    clearPress();
  }

  async function quickTake(btn){
    const row = findRow(btn);
    const input = ensureFileInput(row);
    const once = async ()=>{
      input.removeEventListener('change', once);
      const f = input.files && input.files[0]; if(!f) return;
      try{
        const dataUrl = await readFileAsDataURL(f);
        const img = ensureThumb(btn);
        setThumb(img, dataUrl);
        const kind = getRowKind(row);
        try{ sessionStorage.setItem(kindStorageKey(kind), dataUrl); }catch(_){}
      }catch(err){ console.warn('camera read error', err); }
    };
    input.addEventListener('change', once);
    input.click();
  }

  function showOptions(btn, x, y){
    const row = findRow(btn);
    const img = btn.querySelector('img.thumb');
    const hasPhoto = img && img.src && img.style.display !== 'none';

    // If no photo yet → open camera directly
    if(!hasPhoto){ return quickTake(btn); }

    openSheet(x, y, [
      { label: 'Preview', onClick: ()=> openPreview(img.src) },
      { label: 'Retake (overwrite)', onClick: ()=> quickTake(btn) },
      { label: 'Delete photo', danger:true, onClick: ()=>{
          setThumb(img, '');
          const kind = getRowKind(row);
          // Also clear any remembered session thumbs so save() won’t resurrect it
          try{ sessionStorage.removeItem(kindStorageKey(kind)); }catch(_){}
          // Optional flag so other code knows it was explicitly cleared:
          row.dataset.photoDeleted = "1";
        } 
      },
      { label: 'Cancel', onClick: ()=>{} }
    ]);
  }

  // pointer & touch
  document.addEventListener('pointerdown', (e)=>{
    if(!e.target.closest('.cam-btn')) return;
    startPress(e);
  }, {passive:true});
  document.addEventListener('pointerup', (e)=>{
    if(!pressTarget) return;
    endPress(e);
  }, {passive:true});
  document.addEventListener('pointercancel', clearPress, {passive:true});
  document.addEventListener('pointerleave', (e)=>{
    if(!pressTarget) return;
    if(!e.target.closest('.cam-btn')) clearPress();
  }, {passive:true});
})();