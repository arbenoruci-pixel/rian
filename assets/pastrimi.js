// /assets/pastrimi.js — compact list + SMS + GATI + long-press stage
// Works with /assets/supabase.js (window.select/update) OR direct supabase-js.

const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [].slice.call(r.querySelectorAll ? r.querySelectorAll(s) : []);
const n2 = v => Number(v||0).toFixed(2);

// ---------- Supabase helpers (dual-mode: REST-like or supabase-js) ----------
async function sbSelect(table, query) {
  // prefer your helpers if present
  try {
    if (typeof window.select === 'function') {
      const res = await window.select(table, query||{});
      if (Array.isArray(res)) return res;
      if (res && Array.isArray(res.data)) return res.data;
      return [];
    }
  } catch(_) {}

  // fallback: supabase-js on-the-fly
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const url = window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL;
  const key = window.SUPABASE_ANON || window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const sb  = createClient(url, key);

  let q = sb.from(table).select('*');
  if (query && query.status) {
    // status filter supports eq: or in: strings
    const sv = String(query.status);
    if (sv.startsWith('eq:'))      q = q.eq('status', sv.slice(3));
    else if (sv.startsWith('in:')) q = q.in('status', sv.slice(3).split(','));
    else                           q = q.eq('status', sv);
  }
  if (query && query.order === 'created_at.desc') q = q.order('created_at', { ascending:false });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function sbUpdateOrder(id, patch) {
  try {
    if (typeof window.update === 'function') {
      const res = await window.update('orders', patch, { id });
      return res;
    }
  } catch(_) {}

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const url = window.SUPABASE_URL || window.NEXT_PUBLIC_SUPABASE_URL;
  const key = window.SUPABASE_ANON || window.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const sb  = createClient(url, key);
  const { error } = await sb.from('orders').update(patch).eq('id', id);
  if (error) throw error;
}

// ---------- UI helpers ----------
function banner(msg) {
  let el = $('#sb_err'); 
  if (!el) {
    el = document.createElement('div');
    el.id = 'sb_err';
    el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:#a40e0e;border:1px solid #c11;color:#fff;padding:8px 12px;border-radius:10px;font-weight:900';
    document.body.appendChild(el);
  }
  el.textContent = 'SUPABASE: ' + (msg||'ERR');
  el.style.display = 'block';
  setTimeout(()=>{ el.style.display = 'none'; }, 3500);
}
function daysAgo(iso){
  if (!iso) return 99;
  const d = new Date(iso);
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function ageClass(iso){
  const d = daysAgo(iso);
  if (d <= 0) return 'good';  // today
  if (d === 1) return 'warn'; // yesterday
  return 'bad';               // 2+ days
}
function stageLabel(v){
  const s = String(v||'').toLowerCase();
  if (s==='laj' || s==='wash') return 'LAJ';
  if (s==='thaj' || s==='dry') return 'THAJ';
  if (s==='pako' || s==='pack') return 'PAKO';
  if (s==='radhe' || s==='queue' || s==='ne radhe') return 'RADHË';
  return 'RADHË';
}
function nextStageVal(label){
  const m = { 'RADHË':'radhe', 'LAJ':'laj', 'THAJ':'thaj', 'PAKO':'pako' };
  return m[label] || 'radhe';
}
function smsReadyText(o){
  return `Përshëndetje ${o.name||''}, tepihet me kod ${o.code} janë gati për marrje. \
Gjithsej ${o.pieces||0} copë / ${n2(o.m2||0)} m². Totali: €${n2(o.total||0)}. Faleminderit!`;
}

// ---------- Stage sheet (long-press) ----------
function ensureStageSheet(){
  if ($('#stageSheet')) return;
  const sh = document.createElement('div');
  sh.id = 'stageSheet';
  sh.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;z-index:9998;align-items:center;justify-content:center;padding:16px';
  sh.innerHTML = `
    <div style="background:#0c0f16;border:1px solid #273143;border-radius:16px;padding:12px;max-width:520px;width:100%">
      <div style="font-weight:1000;margin-bottom:10px">Zgjidh fazën</div>
      <div id="stageBtns" style="display:flex;flex-wrap:wrap;gap:10px">
        <button class="chip">RADHË</button>
        <button class="chip">LAJ</button>
        <button class="chip">THAJ</button>
        <button class="chip">PAKO</button></div>
      <div style="display:flex;justify-content:flex-end;margin-top:10px">
        <button id="stageCancel" class="chip" style="background:#0b111d;border:2px solid #2c3a55">Mbyll</button></div></div>`;
  document.body.appendChild(sh);
}
let __sheetCtx = null;
function openStagePicker(order, stageEl, rowEl){
  ensureStageSheet();
  __sheetCtx = { order, stageEl, rowEl };
  $('#stageSheet').style.display='flex';
}
(document.body.addEventListener?document.body.addEventListener('click',e=>{
  if (e.target.id==='stageCancel' || e.target.id==='stageSheet') {
    $('#stageSheet').style.display='none';
  }
}, true):0);
document.addEventListener('click', (e)=>{
  const sh = $('#stageSheet'); if (!sh || sh.style.display!=='flex') return;
  const b = e.target.closest && e.target.closest('#stageBtns .chip');
  if (!b) return;
  const label = b.textContent.trim();
  const val   = nextStageVal(label);
  const ctx   = __sheetCtx; __sheetCtx=null;
  if (!ctx) return;
  (async ()=>{
    try{
      await sbUpdateOrder(ctx.order.id, { stage: val, stage_at: new Date().toISOString() });
      ctx.stageEl.textContent = label;
      const badge = ctx.rowEl.querySelector('.age');
      if (badge) { badge.classList.remove('good','warn','bad'); badge.classList.add('good'); }
      sh.style.display='none';
    }catch(err){ banner('ERR'); console.error(err); }
  })();
});

// ---------- row renderer ----------
function rowEl(o){
  const el = document.createElement('div');
  el.className = 'card';
  const label = stageLabel(o.stage);

  el.innerHTML = `
    <div class="head">
      <span class="code">${o.code||''}</span>
      <span class="name">${(o.name||'').slice(0,30)}</span>
      <span class="pieces">${o.pieces||0} copë</span>
      <span class="m2">${n2(o.m2||0)} m²</span>
      <span class="total">€${n2(o.total||0)}</span>
      <button class="stage badge">${label}</button>
      <span class="age ${ageClass(o.stage_at||o.created_at)}"></span></div>
    <div class="actions">
      <button class="det" data-client="${o.id}">📋 DETAJE</button> <button class="sms">SMS</button>
      <button class="go">▶ GATI</button></div>
  `;

  // style (tiny CSS inline to keep single-file)
  el.style.cssText = 'border:1px solid #273143;background:#0c0f16;border-radius:14px;padding:10px;margin:10px 0';
  el.querySelector('.head').style.cssText = 'display:grid;grid-template-columns:auto 1fr auto auto auto auto 10px;gap:8px;align-items:center';
  el.querySelector('.actions').style.cssText = 'display:flex;gap:8px;margin-top:8px';
  // Long-press on CODE badge -> open client panel
  try {
    const codeEl = el.querySelector('.code');
    if (codeEl) {
      let _t;
      const OPEN = () => { try { window.openClientById && window.openClientById(o.id); } catch(e){} };
      codeEl.addEventListener('touchstart', ()=>{ _t = setTimeout(OPEN, 600); }, {passive:true});
      codeEl.addEventListener('touchend',   ()=>{ clearTimeout(_t); });
      codeEl.addEventListener('mousedown',  ()=>{ _t = setTimeout(OPEN, 600); });
      codeEl.addEventListener('mouseup',    ()=>{ clearTimeout(_t); });
      codeEl.addEventListener('mouseleave', ()=>{ clearTimeout(_t); });
    }
  } catch(e){}

  el.querySelector('.det').onclick = ()=>{ try{ window.openClientById && window.openClientById(o.id); }catch(e){ console.warn(e); } };
  $$('.badge', el).forEach(b=>{ b.style.cssText='background:#0b111d;border:1px solid #2c3a55;border-radius:999px;padding:6px 10px;font-weight:900;color:#e6f0ff' });
  $$('.actions button', el).forEach(b=>{ b.style.cssText='border:0;border-radius:12px;padding:10px 14px;font-weight:1000;background:#0c1220;color:#e6f0ff;border:1px solid #2b3956' });
  el.querySelector('.go').style.background='#1e60ff';

  // SMS
  el.querySelector('.sms').onclick = ()=>{
    const phone = String(o.phone||'').replace(/\D/g,'');
    if (!phone) { alert('S’ka telefon'); return; }
    location.href = `sms:${phone}?&body=${encodeURIComponent(smsReadyText(o))}`;
  };

  // GATI
  el.querySelector('.go').onclick = async ()=>{
    try {
      await sbUpdateOrder(o.id, { status:'gati', stage:'pako', stage_at: new Date().toISOString() });
      el.style.opacity = .4;
      setTimeout(()=> el.remove(), 300);
    } catch (e) { console.error(e); banner('ERR'); }
  };

  // long-press stage to change
  const stageBtn = el.querySelector('.stage');
  let t=null, long=false;
  const start = ()=>{ long=false; t=setTimeout(()=>{ long=true; openStagePicker(o, stageBtn, el); }, 500); };
  const end   = ()=>{ clearTimeout(t); };
  ['mousedown','touchstart'].forEach(evt=> stageBtn.addEventListener(evt, start, {passive:true}));
  ['mouseup','mouseleave','touchend','touchcancel'].forEach(evt=> stageBtn.addEventListener(evt, end));

  return el;
}

// ---------- top stats ----------
function renderStats(rows){
  const sumM2 = rows.reduce((s,x)=>s+Number(x.m2||0),0);
  const bar = document.createElement('div');
  bar.style.cssText='display:flex;flex-wrap:wrap;gap:12px;margin:6px 0';
  bar.innerHTML = `
    <div class="pill">🧾 ${rows.length} porosi</div>
    <div class="pill">📐 ${n2(sumM2)} m²</div>
    <div class="pill">Radhë: ${rows.filter(x=>/radhe|queue/i.test(x.stage)).length}</div>
    <div class="pill">Laj: ${rows.filter(x=>/laj|wash/i.test(x.stage)).length}</div>
    <div class="pill">Thaj: ${rows.filter(x=>/thaj|dry/i.test(x.stage)).length}</div>
    <div class="pill">Pako: ${rows.filter(x=>/pako|pack/i.test(x.stage)).length}</div>
    <button id="btnRefresh" class="pill">↻ Rifresko</button>
  `;
  $$('.pill', bar).forEach(p=> p.style.cssText='background:#0b111d;border:1px solid #273143;border-radius:12px;padding:10px 12px;font-weight:1000');
  $('#stats')?.replaceChildren(bar);
  $('#btnRefresh').onclick = render;
}

// ---------- main render ----------
async function render(){
  try{
    // Prefer server-side filtered (pastrim or dorzim depending your flow)
    let rows = await sbSelect('orders', { status:'in:pastrim,dorzim', order:'created_at.desc' });
    if (!Array.isArray(rows)) rows = [];

    // Fallback: basic select if server didn’t accept filter
    if (!rows.length) rows = await sbSelect('orders', {});

    // Only “in process” (not gati)
    rows = rows.filter(o => String(o.status||'').toLowerCase() !== 'gati')
               .sort((a,b)=> String(b.status).localeCompare(String(a.status)) || 
                             String(b.created_at||'').localeCompare(String(a.created_at||'')));

    renderStats(rows);

    const host = $('#list');
    if (!host) return;
    host.innerHTML = '';
    rows.forEach(o => host.appendChild(rowEl(o)));
  }catch(e){
    console.error(e);
    banner('ERR');
  }
}

// ---------- boot ----------
document.addEventListener('DOMContentLoaded', ()=>{
  // make sure containers exist (defensive)
  if (!$('#stats')) { const d=document.createElement('div'); d.id='stats'; document.body.prepend(d); }
  if (!$('#list'))  { const d=document.createElement('div'); d.id='list';  document.body.appendChild(d); }
  render();
});