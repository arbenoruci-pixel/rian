// PAPLOTËSUARA = "Drafts from Pranimi"
// Shows unfinished orders. Badge and list now use the same rule:
// 1) status = 'draft' OR status IS NULL
// 2) OR "empty shell" created in last 30 minutes (code reserved, no data)

import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

const headers = {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  Accept: 'application/json',
};

const listEl = document.getElementById('list');
const tpl = document.getElementById('tpl-card');

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
  }catch(e){ /* silent */ }
}

function thirtyMinAgoISO(){
  const d = new Date(Date.now() - 30*60*1000);
  return d.toISOString();
}

async function fetchDrafts(query){
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set(
    'select',
    'id,code,name,phone,pieces,m2,total,status,stage,stage_at,created_at'
  );
  url.searchParams.set('archived','eq.false');
  url.searchParams.set('picked_at','is.null');

  // include true drafts OR empty shells created in the last 30 minutes
  // empty shell = no name/phone/pieces/m2/total
  const t30 = encodeURIComponent(thirtyMinAgoISO());
  const emptyShell =
    `and(name.is.null,phone.is.null,pieces.is.null,m2.is.null,total.is.null,created_at.gte.${t30})`;

  // allow legacy "stage = queue" with null status to be treated as draft
  const legacyQueue = `and(status.is.null,stage.eq.queue)`;

  url.searchParams.append(
    'or',
    `(status.eq.draft,status.is.null,${emptyShell},${legacyQueue})`
  );

  url.searchParams.set('order','created_at.desc');

  if(query){
    const q = query.trim();
    const parts = [];
    if (/^\d+$/.test(q)) parts.push(`code.eq.${q}`);
    parts.push(`name.ilike.*${encodeURIComponent(q)}*`);
    parts.push(`phone.ilike.*${encodeURIComponent(q)}*`);
    url.searchParams.append('or', `(${parts.join(',')})`);
  }

  const r = await fetch(url.toString(), { headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
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

  // Open Pranimi to finish (pass BOTH id and code so the badge matches)
  node.style.cursor = 'pointer';
  node.addEventListener('click', (e)=>{
    if (e.target.closest('button')) return;
    window.location.href = `/pranimi/?id=${encodeURIComponent(row.id)}&code=${encodeURIComponent(row.code||'')}`;
  });

  // SMS helper
  const smsBtn = node.querySelector('[data-act="sms"]');
  if (smsBtn) smsBtn.addEventListener('click', ()=>{
    const msg = encodeURIComponent(`Përshëndetje ${row.name || ''}! Porosia #${row.code} është regjistruar. Do ju kontaktojmë shpejt.`);
    const phone = encodeURIComponent((row.phone||'').replace(/\s+/g,''));
    window.location.href = `sms:${phone}?&body=${msg}`;
  });

  return node;
}

async function refresh(query){
  listEl.innerHTML = '';
  const rows = await fetchDrafts(query).catch(e=>{
    console.warn(e);
    listEl.innerHTML = `<div class="empty">Gabim gjatë leximit…</div>`;
    return [];
  });
  if (!rows.length){
    listEl.innerHTML = `<div class="empty">S’ka asnjë draft. 🎉</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  rows.forEach(r => frag.appendChild(cardFor(r)));
  listEl.appendChild(frag);
}

window.addEventListener('DOMContentLoaded', async ()=>{
  await cleanupStaleDrafts();     // frees only empty shells (keeps partial-info drafts)
  await refresh();

  const q = document.getElementById('q');
  let t = null;
  if (q) q.addEventListener('input', ()=>{
    clearTimeout(t);
    t = setTimeout(()=> refresh(q.value), 200);
  });
});