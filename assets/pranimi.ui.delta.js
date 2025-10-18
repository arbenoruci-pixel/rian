// assets/pranimi.ui.delta.js — NON-DESTRUCTIVE UI PATCH v4
// UI-only: adds chips->rows, per-row photos (tepiha/staza), client small photo,
// stairs m² logic, and a photo for Shkallore. Does NOT change your engine.

(function(){
  if (window.PranimiDeltaV4) return;
  window.PranimiDeltaV4 = true;

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const el = (t, cls) => { const n=document.createElement(t); if(cls) n.className=cls; return n; };
  const toNum = (v) => { const t=(v??'').toString().replace(',','.').replace(/[^\d.\-]/g,''); const n=Number(t); return Number.isFinite(n)?n:0; };

  // ---------- state ----------
  const state = { tepiha:{}, staza:{}, stairsM2:0, price:3.0 };
  const photos = new Map(); // per-row: key = group|size|idx
  const stairsPhotoKey = 'stairs_photo_thumb_v1';

  // optional price
  const priceInput = $('#price_per_m2');
  if (priceInput) {
    state.price = toNum(priceInput.value);
    priceInput.addEventListener('input', ()=>{ state.price = toNum(priceInput.value); recalcTotals(); }, {passive:true});
  }

  function getCount(group, size){ return (state[group][String(size)]||0); }
  function setCount(group, size, count){ state[group][String(size)] = Math.max(0, count|0); }
  function photoKey(group,size,idx){ return `${group}|${size}|${idx}`; }

  // ---------- rows with per-row photos ----------
  function makeRow(size, group, idx){
    const wrap = el('div','piece-row'); wrap.dataset.group=group; wrap.dataset.size=size; wrap.dataset.idx=idx;

    const left = el('div','left');
    const input = el('input','input piece-input'); input.value = `${Number(size).toFixed(1)} m²`; input.readOnly = true;
    left.appendChild(input);

    // camera + hidden file + thumb
    const camHolder = el('div','cam-holder');
    const camLabel = el('label','cam-btn'); camLabel.textContent = '📷';
    const file = el('input'); file.type='file'; file.accept='image/*'; file.capture='environment'; file.style.display='none';
    const thumb = el('img','thumb row-thumb'); thumb.style.display='none';
    camLabel.appendChild(file);
    camHolder.appendChild(camLabel);
    camHolder.appendChild(thumb);
    left.appendChild(camHolder);

    file.addEventListener('change', (e)=>{
      const f = e.target.files?.[0]; if(!f) return;
      const reader = new FileReader();
      reader.onload = ()=>{
        thumb.src = reader.result;
        thumb.style.display = 'inline-block';
        photos.set(photoKey(group,size,idx), reader.result);
      };
      reader.readAsDataURL(f);
    });

    thumb.addEventListener('click', ()=> file.click());

    const right = el('div','mwrap');
    const bMin = el('button','btn red'); bMin.textContent = '−';
    const cnt  = el('span'); cnt.className='count'; cnt.textContent = String(idx+1);
    const bAdd = el('button','btn'); bAdd.textContent = '+';

    bAdd.addEventListener('click', ()=> { addRow(group, size); });
    bMin.addEventListener('click', ()=> { removeOne(group, size); });

    right.appendChild(bMin); right.appendChild(cnt); right.appendChild(bAdd);
    wrap.appendChild(left);
    wrap.appendChild(right);
    return wrap;
  }

  function render(group){
    const bag = state[group];
    const target = group==='tepiha' ? $('#list-tepiha') : $('#list-staza');
    if (!target) return;
    target.innerHTML = '';
    const sizes = Object.keys(bag).filter(k=>bag[k]>0).map(toNum).sort((a,b)=>a-b);
    sizes.forEach(sNum => {
      const s = sNum.toFixed(1);
      const count = bag[s];
      for (let i=0;i<count;i++){
        const row = makeRow(s, group, i);
        const p = photos.get(photoKey(group,s,i));
        if (p) { const img=row.querySelector('.row-thumb'); img.src=p; img.style.display='inline-block'; }
        target.appendChild(row);
      }
    });
    recalcTotals();
  }

  function addRow(group, size){
    let s = size;
    if (s == null) {
      const input = prompt('Vendos m² për rreshtin:', '2.0');
      if (!input) return;
      s = toNum(input);
    }
    if (!s || s <= 0) return;
    const key = s.toFixed(1);
    setCount(group, key, getCount(group, key)+1);
    render(group);
  }
  function removeRow(group){
    const bag = state[group];
    const sizes = Object.keys(bag).filter(k=>bag[k]>0).map(toNum).sort((a,b)=>b-a);
    if (!sizes.length) return;
    const key = sizes[0].toFixed(1);
    setCount(group, key, getCount(group,key)-1);
    const newCount = getCount(group,key);
    photos.delete(photoKey(group,key,newCount));
    render(group);
  }
  function removeOne(group, size){
    const key = String(size);
    const c = getCount(group,key);
    if (c<=0) return;
    setCount(group,key,c-1);
    photos.delete(photoKey(group,key,c-1));
    render(group);
  }

  // expose helpers if not present
  window.addRow = window.addRow || addRow;
  window.removeRow = window.removeRow || removeRow;

  // chips
  document.addEventListener('click', (e)=>{
    const chip = e.target.closest('#chips-tepiha .chip, #chips-staza .chip');
    if (!chip) return;
    const group = chip.closest('#chips-tepiha') ? 'tepiha' : 'staza';
    const label = chip.textContent.trim();
    if (/manual/i.test(label)) { addRow(group, null); }
    else {
      const s = toNum(label);
      if (s>0) addRow(group, s);
    }
  }, {passive:true});

  // stairs logic
  const stairsBtn = $('#openStairs');
  if (stairsBtn) stairsBtn.addEventListener('click', ()=>{
    const n = Number(prompt('Numri i shkallëve (0.3 m² secila):', '1')) || 0;
    if (n>0) { state.stairsM2 += n * 0.3; recalcTotals(); }
  });

  // stairs photo: insert cam button + thumb into #sec-shkallore
  (function setupStairsPhoto(){
    const sec = $('#sec-shkallore');
    if (!sec) return;
    // Add a small photo lane under buttons if not exists
    let lane = sec.querySelector('.stairs-photo-lane');
    if (!lane) {
      lane = el('div','stairs-photo-lane');
      lane.style.display = 'flex';
      lane.style.alignItems = 'center';
      lane.style.gap = '10px';
      lane.style.marginTop = '10px';
      // cam label + hidden input
      const camLabel = el('label','cam-btn'); camLabel.textContent='📷';
      const file = el('input'); file.type='file'; file.accept='image/*'; file.capture='environment'; file.style.display='none'; file.id = 'stairsPhotoInput';
      const thumb = el('img','thumb'); thumb.id='stairsThumb'; thumb.style.display='none';
      camLabel.appendChild(file);
      lane.appendChild(camLabel);
      lane.appendChild(thumb);
      sec.appendChild(lane);

      // restore thumb if previously saved
      try {
        const saved = sessionStorage.getItem(stairsPhotoKey);
        if (saved) { thumb.src = saved; thumb.style.display='inline-block'; }
      } catch {}

      // change event
      file.addEventListener('change', (e)=>{
        const f = e.target.files?.[0]; if(!f) return;
        const reader = new FileReader();
        reader.onload = ()=>{
          thumb.src = reader.result;
          thumb.style.display = 'inline-block';
          try { sessionStorage.setItem(stairsPhotoKey, reader.result); } catch {}
        };
        reader.readAsDataURL(f);
      });
      thumb.addEventListener('click', ()=> file.click());
    }
  })();

  // client photo small & persistent
  (function setupClientPhoto(){
    const input = $('#clientPhotoInput');
    if (!input) return;
    let thumb = $('#clientThumb');
    if (!thumb) {
      thumb = el('img','thumb client-thumb'); thumb.id='clientThumb'; thumb.style.display='none';
      const label = input.closest('label.cam-btn');
      (label?.parentElement || input.parentElement).appendChild(thumb);
    }
    const KEY='client_photo_thumb_v1';
    try{
      const saved = sessionStorage.getItem(KEY);
      if (saved) { thumb.src=saved; thumb.style.display='inline-block'; }
    }catch{}
    input.addEventListener('change', (e)=>{
      const f = e.target.files?.[0]; if(!f) return;
      const reader = new FileReader();
      reader.onload = ()=>{ thumb.src=reader.result; thumb.style.display='inline-block'; try{sessionStorage.setItem(KEY, reader.result);}catch{} };
      reader.readAsDataURL(f);
    });
    thumb.addEventListener('click', ()=> input.click());
  })();

  // totals
  function recalcTotals(){
    let m2_tepiha=0, m2_staza=0, pieces=0;
    for (const [s,c] of Object.entries(state.tepiha)) { m2_tepiha += Number(s)*c; pieces += c; }
    for (const [s,c] of Object.entries(state.staza))  { m2_staza  += Number(s)*c; pieces += c; }
    const m2_total = m2_tepiha + m2_staza + state.stairsM2;

    const totT = $('#tot-tepiha'); if (totT) totT.textContent = `${m2_tepiha.toFixed(2)} m²`;
    const totS = $('#tot-staza');  if (totS)  totS.textContent = `${m2_staza.toFixed(2)} m²`;
    const stairs = $('#stairsM2'); if (stairs) stairs.textContent = `${state.stairsM2.toFixed(2)} m²`;

    const price = priceInput ? toNum(priceInput.value) : state.price;
    const m2Node = $('#m2Total');  if (m2Node)  m2Node.textContent = m2_total.toFixed(2);
    const eurNode = $('#euroTotal'); if (eurNode) eurNode.textContent = (m2_total * price).toFixed(2);
    return { m2:m2_total, pieces, total:Number((m2_total*price).toFixed(2)), price_per_m2:price };
  }

  // tiny CSS hints (non-invasive)
  const style = document.createElement('style');
  style.textContent = `.row-thumb,.client-thumb,#stairsThumb{width:44px;height:44px;border-radius:10px;object-fit:cover;border:1px solid #2b3956}
  .cam-holder{display:flex;align-items:center;gap:8px;margin-top:6px}`;
  document.head.appendChild(style);

  // initial render
  render('tepiha'); render('staza'); recalcTotals();
})();