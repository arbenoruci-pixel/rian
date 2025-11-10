// /assets/debug.js — HARD-WIRED to your Supabase; prints exact errors.

const SUPABASE_URL  = 'https://vnidjrxidvusulinozbn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZuaWRqcnhpZHZ1c3VsaW5vemJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1MTk0NjAsImV4cCI6MjA3MzA5NTQ2MH0.hzGSFKU3sKuUKBUBsTE0rKIerj2uhG9pGS8_K9N7tpA';

const out = document.getElementById('out');
document.getElementById('url').textContent = SUPABASE_URL;

const hJSON = () => ({
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  'Content-Type': 'application/json'
});
const hGET = () => ({
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  Accept: 'application/json'
});

function showOK(msg, data) {
  out.innerHTML = `<div class="ok">✅ ${msg}</div>\n${data ? escapeHTML(JSON.stringify(data, null, 2)) : ''}`;
}
function showErr(prefix, r, text) {
  out.innerHTML = `<div class="err">❌ ${prefix}\nStatus: ${r?.status} ${r?.statusText}\n${escapeHTML(text || '')}</div>`;
}
function catchErr(prefix) {
  return (e) => out.innerHTML = `<div class="err">❌ ${prefix}\n${escapeHTML(e?.message || String(e))}</div>`;
}
function escapeHTML(s) { return s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// --- Tests ---
async function pingREST() {
  out.textContent = 'Pinging REST…';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: hGET() });
  const t = await r.text();
  if (!r.ok) return showErr('REST root not OK', r, t);
  showOK('REST reachable', t.slice(0, 200));
}

async function rpcNextCode() {
  out.textContent = 'Calling rpc next_code()…';
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/next_code_num`, {
    method: 'POST', headers: hJSON(), body: JSON.stringify({})
  });
  const t = await r.text();
  let data = null;
  try { data = JSON.parse(t); } catch { /* leave as text */ }
  if (!r.ok) return showErr('RPC next_code_num() failed', r, t);
  showOK('RPC next_code_num() OK', data ?? t);
}

async function selectOrders() {
  out.textContent = 'Selecting orders…';
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('select', 'code,name,phone,status,created_at');
  url.searchParams.set('order', 'created_at.desc');
  url.searchParams.set('limit', '3');
  const r = await fetch(url, { headers: hGET() });
  const t = await r.text();
  let data = null;
  try { data = JSON.parse(t); } catch {}
  if (!r.ok) return showErr('Select orders failed', r, t);
  showOK('Select OK (top 3):', data);
}

async function insertTest() {
  out.textContent = 'Inserting test row…';
  const row = {
    code: '900001', name: 'Supabase Debug Client',
    phone: '44177777', price_per_m2: 5, m2: 3, pieces: 1, total: 15,
    status: 'pastrim', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: 'POST', headers: hJSON(), body: JSON.stringify(row)
  });
  const t = await r.text();
  let data = null;
  try { data = JSON.parse(t); } catch {}
  if (!r.ok) return showErr('Insert test failed', r, t);
  showOK('Insert OK', data);
}

async function cleanup() {
  out.textContent = 'Deleting test rows (code >= 900000)…';
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('code', 'gte.900000');
  const r = await fetch(url, { method: 'DELETE', headers: hJSON() });
  const t = await r.text();
  if (!r.ok) return showErr('Cleanup failed', r, t);
  showOK('Cleanup OK', t || '(deleted >= code 900000)');
}

// Wire buttons
document.getElementById('btnPing')   .addEventListener('click', () => pingREST().catch(catchErr('Ping error')));
document.getElementById('btnRPC')    .addEventListener('click', () => rpcNextCode().catch(catchErr('RPC error')));
document.getElementById('btnSelect') .addEventListener('click', () => selectOrders().catch(catchErr('Select error')));
document.getElementById('btnInsert') .addEventListener('click', () => insertTest().catch(catchErr('Insert error')));
document.getElementById('btnCleanup').addEventListener('click', () => cleanup().catch(catchErr('Cleanup error')));
