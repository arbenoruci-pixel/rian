// PAPLOTËSUARA (v3) — list unfinished orders
// Rule (same as Home badge):
//  • status = 'draft'  OR  status IS NULL
//  • OR "empty shell" created in last 30min (no name/phone/pieces/m2/total)

import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

const headers = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  Accept: 'application/json',
};

const listEl = document.getElementById('list');
const tpl = document.getElementById('tpl-card');
const qInput = document.getElementById('q');

function fmtMoney(n){ return (Number(n||0)).toLocaleString('sq-AL',{style:'currency',currency:'EUR',maximumFractionDigits:2}); }
function daysAgo(iso){
  if(!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime())/86400000;
  const n = Math.floor(d);
  return n<=0 ? 'sot' : `${n} ditë`;
}

async function cleanupStaleDrafts(){
  try{
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/cleanup_drafts`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_minutes: 30 })
    });
  }catch(_){}
}

function thirtyMinAgoISO(){ return new Date(Date.now() - 30*60*1000).toISOString(); }

async function fetchDraftsServer(){
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set(
    'select',
    'id,code,name,phone,pieces,m2,total,status,stage,stage_at,created_at'
  );
  url.searchParams.set('archived','eq.false');
  url.searchParams.set('picked_at','is.null');

  // empty shell = no name/phone/pieces/m2/total AND created in last 30min
  const t30 = thirtyMinAgoISO();
  // NOTE: use and=(...) not and(...), otherwise PostgREST ignores it
  const emptyShell = `and=(name.is.null,phone.is.null,pieces.is.null,m2.is.null,total.is.null,created_at.gte.${encodeURIComponent(t30)})`;
  const legacyQueue = `and=(status.is.null,stage.eq.queue)`;

  // single OR expression so we don't accidentally AND two ORs
  url.searchParams.append(
    'or',
    `(status.eq.draft,status.is.null,${emptyShell},${legacyQueue})`
  );

  url.searchParams.set('order','created_at.desc');
  const r = await fetch(url.toString(), { headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function clientSearchFilter(rows, qRaw){
  const q = (qRaw||'').trim().toLowerCase();
  if (!q) return rows;
  return rows.filter(r=>{
    const code = (r.code==null?'':String(r.code)).toLowerCase();
    const name = (r.name||'').toLowerCase();
    const phone = (r.phone||'').toLowerCase();
    return code.includes(q) || name.includes(q) || phone.includes(q);
  });
}

function cardFor(row){
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector('.code').textContent  = row.code ?? '—';
  node.querySelector('.name').textContent  = (row.name || 'Pa emër').toLowerCase();
  node.querySelector('.phone').textContent = row.phone ?? '';
  node.querySelector('.status').textContent = 'DRAFT';

  node.querySelector('.pieces').textContent = `Copë: ${row.pieces ?? 0}`;
  node.querySelector('.m2').textContent     = `m²: ${Number(row.m2||0).toFixed(2)}`;
  node.querySelector('.total').textContent  = `Totali: ${fmtMoney(row.total||0)}`;
  node.querySelector('.when').textContent   = `Koha: ${daysAgo(row.created_at)}`;

  node.style.cursor = 'pointer';
  node.addEventListener('click', (e)=>{
    if (e.target.closest('button')) return;
    // pass both id and code so Pranimi can load & show the same badge
    window.location.href = `/pranimi/?id=${encodeURIComponent(row.id)}&code=${encodeURIComponent(row.code||'')}`;
  });

  const smsBtn = node.querySelector('[data-act="sms"]');
  if (smsBtn) smsBtn.addEventListener('click', ()=>{
    const msg = encodeURIComponent(`Përshëndetje ${row.name || ''}! Porosia #${row.code} është regjistruar. Do ju kontaktojmë shpejt.`);
    const phone = encodeURIComponent((row.phone||'').replace(/\s+/g,''));
    window.location.href = `sms:${phone}?&body=${msg}`;
  });

  return node;
}

async function refresh(){
  listEl.innerHTML = '';
  const rows = await fetchDraftsServer().catch(e=>{
    console.warn(e);
    listEl.innerHTML = `<div class="empty">Gabim gjatë leximit…</div>`;
    return [];
  });

  const filtered = clientSearchFilter(rows, qInput && qInput.value);
  if (!filtered.length){
    listEl.innerHTML = `<div class="empty">S’ka asnjë draft. 🎉</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  filtered.forEach(r => frag.appendChild(cardFor(r)));
  listEl.appendChild(frag);
}

window.addEventListener('DOMContentLoaded', async ()=>{
  await cleanupStaleDrafts();
  await refresh();
  if (qInput){
    let t=null;
    qInput.addEventListener('input', ()=>{
      clearTimeout(t);
      t=setTimeout(refresh, 180);
    });
  }
});