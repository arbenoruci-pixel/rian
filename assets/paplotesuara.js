// Lists all active, not-finished orders and offers quick actions.
// Logic: archived=false AND picked_at IS NULL
import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

const headers = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  Accept: 'application/json',
};

const listEl = document.getElementById('list');
const tpl = document.getElementById('tpl-card');

function isoNow() { return new Date().toISOString(); }
function fmtMoney(n){ return (Number(n||0)).toLocaleString('sq-AL',{style:'currency',currency:'EUR',maximumFractionDigits:2}); }
function daysAgo(iso){
  if(!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime())/86400000;
  const n = Math.floor(d);
  return n<=0 ? 'sot' : `${n} ditë`;
}

async function fetchUnfinished(query){
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('select','id,code,name,phone,pieces,m2,total,status,stage,stage_at,ready_at,picked_at,no_show');
  url.searchParams.set('archived','eq.false');
  url.searchParams.set('picked_at','is.null');
  url.searchParams.set('order','stage_at.desc');

  // search by code/name/phone
  if(query){
    // PostgREST OR is URL-encoded; we’ll use ilike for name/phone and equality for code
    const orParts = [];
    const q = query.trim();
    if (/^\d+$/.test(q)) orParts.push(`code.eq.${q}`);
    orParts.push(`name.ilike.*${encodeURIComponent(q)}*`);
    orParts.push(`phone.ilike.*${encodeURIComponent(q)}*`);
    url.searchParams.append('or', `(${orParts.join(',')})`);
  }

  const r = await fetch(url.toString(), { headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function cardFor(row){
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.code').textContent = row.code ?? '—';
  node.querySelector('.name').textContent = row.name ?? 'Pa emër';
  node.querySelector('.phone').textContent = row.phone ?? '';
  node.querySelector('.status').textContent = (row.status || row.stage || '—').toUpperCase();
  node.querySelector('.pieces').textContent = `Copë: ${row.pieces ?? 0}`;
  node.querySelector('.m2').textContent = `m²: ${Number(row.m2||0).toFixed(2)}`;
  node.querySelector('.total').textContent = `Totali: ${fmtMoney(row.total||0)}`;

  // age → prefer ready_at, else stage_at
  const anchor = row.ready_at || row.stage_at;
  node.querySelector('.when').textContent = `Koha: ${daysAgo(anchor)}`;

  // actions
  node.querySelector('[data-act="sms"]').addEventListener('click', ()=> sendSMS(row));
  node.querySelector('[data-act="gati"]').addEventListener('click', ()=> markGati(row, node));
  node.querySelector('[data-act="dorzo"]').addEventListener('click', ()=> markDorzo(row, node));
  node.querySelector('[data-act="noshow"]').addEventListener('click', ()=> toggleNoShow(row, node));

  // style no_show
  if (row.no_show) node.querySelector('[data-act="noshow"]').classList.add('warn');

  return node;
}

async function refresh(query){
  listEl.innerHTML = '';
  const rows = await fetchUnfinished(query).catch(e=>{
    console.warn(e);
    listEl.innerHTML = `<div class="empty">Gabim gjatë leximit…</div>`;
    return [];
  });
  if (!rows.length){
    listEl.innerHTML = `<div class="empty">Asnjë porosi e papërfunduar 🎉</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  rows.forEach(r => frag.appendChild(cardFor(r)));
  listEl.appendChild(frag);
}

/* -------------------- actions (PATCH) -------------------- */

async function patch(id, body){
  const url = `${SUPABASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(id)}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function sendSMS(row){
  const msg = encodeURIComponent(`Përshëndetje ${row.name || ''}! Porosia #${row.code} është gati për marrje. Faleminderit!`);
  const phone = encodeURIComponent((row.phone||'').replace(/\s+/g,''));
  // sms: works on iOS/Android
  window.location.href = `sms:${phone}?&body=${msg}`;
}

async function markGati(row, node){
  try{
    await patch(row.id, { status: 'gati', ready_at: isoNow(), stage: 'gati', stage_at: isoNow() });
    node.remove(); // disappears from "paplotesuara" if your workflow later picks it
  }catch(e){ alert('Nuk u ruajt: ' + e.message); }
}

async function markDorzo(row, node){
  try{
    await patch(row.id, { status: 'dorzim', picked_at: isoNow(), stage: 'dorzim', stage_at: isoNow(), is_paid: true });
    node.remove(); // completed
  }catch(e){ alert('Nuk u ruajt: ' + e.message); }
}

async function toggleNoShow(row, node){
  try{
    const newVal = !row.no_show;
    const data = await patch(row.id, { no_show: newVal });
    row.no_show = data?.[0]?.no_show ?? newVal;
    const btn = node.querySelector('[data-act="noshow"]');
    btn.classList.toggle('warn', row.no_show);
  }catch(e){ alert('Nuk u ruajt: ' + e.message); }
}

/* -------------------- init -------------------- */

window.addEventListener('DOMContentLoaded', ()=>{
  refresh();
  const q = document.getElementById('q');
  let t = null;
  q.addEventListener('input', ()=>{
    clearTimeout(t);
    t = setTimeout(()=> refresh(q.value), 200);
  });
});
