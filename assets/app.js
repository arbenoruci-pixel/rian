// === GPT-INJECT: CODE-SYSTEM START ===
/** Single source of truth for order codes ("-<n>") and storage helpers.
 * PRANIMI is the ONLY place that increments.
 */
(function(){ 
  const KEY_CODE_COUNTER = 'code_counter'; // int; next numeric id to assign
  const KEY_ORDERS_UNIFIED = 'orders_v1';  // unified list mirror (optional)

  function ensureCodeCounterInit() {
    if (localStorage.getItem(KEY_CODE_COUNTER) === null) {
      localStorage.setItem(KEY_CODE_COUNTER, '0'); // so first claim => -1
    }
  }

  function getCodeCounter() {
    ensureCodeCounterInit();
    return parseInt(localStorage.getItem(KEY_CODE_COUNTER) || '0', 10);
  }

  function setCodeCounter(n) {
    localStorage.setItem(KEY_CODE_COUNTER, String(n));
  }

  window.previewNextCode = function previewNextCode() {
    const n = getCodeCounter() + 1;
    return "-" + n;
  }

  window.claimNextCode = function claimNextCode() {
    const n = getCodeCounter() + 1;
    setCodeCounter(n);
    return { code: "-" + n, code_n: n };
  }

  window.migrateLegacyCodes = function migrateLegacyCodes() {
    try {
      const keys = Object.keys(localStorage);
      let changed = 0;
      for (const k of keys) {
        if (k.startsWith('order_')) {
          try {
            const raw = localStorage.getItem(k);
            if (!raw) continue;
            const o = JSON.parse(raw);
            if (!o) continue;
            if (o.code && /^-\d+$/.test(o.code)) continue;

            let n = null;
            if (o.code && typeof o.code === 'string') {
              const m = o.code.match(/(\d+)/);
              if (m) n = parseInt(m[1],10);
            }
            if (n==null && typeof o.code_n==='number') n=o.code_n;
            if (n==null && o.id) {
              const m2 = String(o.id).match(/(\d+)/);
              if (m2) n = parseInt(m2[1],10);
            }
            if (n==null) continue;

            o.code = "-" + n;
            o.code_n = n;
            localStorage.setItem(k, JSON.stringify(o));
            changed++;
          } catch(e){}
        }
      }
      let maxN = 0;
      for (const k of keys) {
        if (k.startsWith('order_')) {
          try {
            const o = JSON.parse(localStorage.getItem(k));
            if (o && typeof o.code_n==='number' && o.code_n>maxN) maxN=o.code_n;
          } catch(e){}
        }
      }
      const cur = getCodeCounter();
      if (maxN > cur) setCodeCounter(maxN);
      return {changed, maxN, counter:getCodeCounter()};
    } catch (e) {
      return {error:String(e)};
    }
  }

  window.unifiedList = {
    read() {
      try { return JSON.parse(localStorage.getItem('orders_v1') || '[]'); }
      catch(e){ return [] }
    },
    write(list) {
      localStorage.setItem('orders_v1', JSON.stringify(list||[]));
    },
    upsert(o) {
      const list = this.read();
      const idx = list.findIndex(x => x.id===o.id || x.code===o.code);
      if (idx>=0) list[idx] = Object.assign({}, list[idx], o);
      else list.unshift(o);
      this.write(list);
    }
  };

  window.setOrderStatus = function setOrderStatus(orderId, status) {
    const k = 'order_' + orderId;
    const raw = localStorage.getItem(k);
    if (!raw) return false;
    try {
      const o = JSON.parse(raw);
      o.status = status;
      if (status==='gati' && !o.ready_at) o.ready_at = new Date().toISOString();
      localStorage.setItem(k, JSON.stringify(o));
      try { window.unifiedList.upsert(o); } catch(e){}
      return true;
    } catch(e) {
      return false;
    }
  }

  window._codeSystem = {
    getCodeCounter, setCodeCounter, previewNextCode, claimNextCode, migrateLegacyCodes
  };
})();
// === GPT-INJECT: CODE-SYSTEM END ===



/* assets/app.js — FIXED v3 (2025-09-20)
   GOAL: Work even if other pages have old logic.
   - Visible version banner so you know this file is loaded
   - Strong multi-field SEARCH (name/phone/X) + auto-bind to common search inputs
   - Monotonic status (no downgrade) + last-write-wins by updatedAt
   - Defensive storage guard: intercept localStorage writes to orders_v1 and keep higher status
   - Auto-migration on load (adds updatedAt, bumps old GATI)
   - Limit active orders per client (name+phone)
*/

/* =========================
   CONFIG
   ========================= */
const STORAGE_KEY = 'orders_v1';
const MAX_ACTIVE_ORDERS_PER_CLIENT = 1;
const STATUS = { PRANIM: 'pranim', PASTRIM: 'pastrim', GATI: 'gati', DOREZUAR: 'dorezuar' };
const ACTIVE_STATUSES = new Set([STATUS.PRANIM, STATUS.PASTRIM, STATUS.GATI]);
const STATUS_RANK = { pranim:1, pastrim:2, gati:3, dorezuar:4 };
const VERSION = 'assets/app.js v3 • 2025-09-20';

/* =========================
   UTILS
   ========================= */
const nowTs = () => Date.now();
function uid(){ return 'ord_' + Math.random().toString(36).slice(2,10) + nowTs().toString(36); }

// Accent-insensitive folding
function fold(s=''){
  try {
    return String(s).normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase().trim();
  } catch {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
  }
}
function normalizePhone(s=''){ return String(s).replace(/\D/g,''); }
function normalizeXCode(s=''){
  const str = String(s).trim().toUpperCase();
  const n = str.replace(/^X/, '');
  const nNoPad = n.replace(/^0+/, '') || '0';
  return nNoPad;
}

/* =========================
   STORAGE (with defensive guard)
   ========================= */
function _read(){ try{ const raw=localStorage.getItem(STORAGE_KEY); return raw?JSON.parse(raw):[]; }catch{ return []; } }
function loadOrders(){ const arr=_read(); return Array.isArray(arr)?arr:[]; }
function _write(list){ localStorage.setItem(STORAGE_KEY, JSON.stringify(list || [])); }

// Defensive save: last-write-wins + no status downgrade
function saveOrder(order){
  const list = loadOrders();
  const i = list.findIndex(o => o.id === order.id);
  if(!order.updatedAt){ order.updatedAt = nowTs(); }

  if(i === -1){
    list.push(order);
  } else {
    const prev = list[i];
    const prevTs = Number(prev.updatedAt || 0);
    const nextTs = Number(order.updatedAt || 0);
    const chosen = nextTs >= prevTs ? order : prev;

    // never downgrade status
    const a = STATUS_RANK[String(prev.status).toLowerCase()] || 0;
    const b = STATUS_RANK[String(chosen.status).toLowerCase()] || 0;
    if(b < a){
      chosen.status = prev.status;
      chosen.updatedAt = Math.max(prevTs, nextTs, nowTs());
    }
    list[i] = chosen;
  }
  _write(list);
}

/* Intercept any other code that tries to overwrite orders_v1 directly */
(function installStorageGuard(){
  const _origSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, val){
    if(key === STORAGE_KEY){
      try {
        const incoming = JSON.parse(val || '[]');
        if(Array.isArray(incoming)){
          const current = loadOrders();
          // merge per id: last-write-wins + no downgrade
          const byId = new Map();
          const put = (x) => {
            const prev = byId.get(x.id);
            if(!prev){ byId.set(x.id, x); }
            else{
              const aTs = Number(prev.updatedAt||0);
              const bTs = Number(x.updatedAt||0);
              const cand = bTs >= aTs ? x : prev;
              // guard
              const a = STATUS_RANK[String(prev.status).toLowerCase()] || 0;
              const b = STATUS_RANK[String(cand.status).toLowerCase()] || 0;
              if(b < a){
                cand.status = prev.status;
                cand.updatedAt = Math.max(aTs, bTs, nowTs());
              }
              byId.set(x.id, cand);
            }
          };
          for(const it of current) put(it);
          for(const it of incoming) put(it);
          const merged = Array.from(byId.values());
          // write merged
          return _origSet(STORAGE_KEY, JSON.stringify(merged));
        }
      } catch { /* fall through */ }
    }
    return _origSet(key, val);
  };
})();

/* =========================
   AUTO-MIGRATION ON LOAD
   ========================= */
(function migrateOrdersOnLoad(){
  try{
    const list = loadOrders();
    if(!list.length) return;
    let changed=false;
    const now = nowTs();
    for(const o of list){
      const before = JSON.stringify(o);
      if(o.status){ o.status = String(o.status).toLowerCase(); }
      if(!o.updatedAt){ o.updatedAt = o.ts ? Number(o.ts) : now; }
      if(o.status === STATUS.GATI && o.updatedAt < now - 5000){ o.updatedAt = now; }
      if(JSON.stringify(o) !== before) changed=true;
    }
    if(changed) _write(list);
  }catch{}
})();

/* =========================
   SYNC STUBS
   ========================= */
async function fetchRemoteOrders(){ return []; }
async function pushDirtyOrders(){}
function mergeOrders(remoteList=[], localList=[]){
  const byId = new Map();
  const put = x => {
    const prev = byId.get(x.id);
    if(!prev){ byId.set(x.id, x); }
    else {
      const a = Number(prev.updatedAt||0);
      const b = Number(x.updatedAt||0);
      byId.set(x.id, b > a ? x : prev);
    }
  };
  for(const it of localList) put(it);
  for(const it of remoteList) put(it);
  return Array.from(byId.values());
}
async function syncOrders(){
  const local = loadOrders();
  const remote = await fetchRemoteOrders();
  const merged = mergeOrders(remote, local);
  _write(merged);
  await pushDirtyOrders();
  return merged;
}

/* =========================
   ORDER LOGIC
   ========================= */
function clientKeyFrom(name, phone){ return fold(name) + '|' + normalizePhone(phone); }
function countActiveOrdersForClient(name, phone){
  const key = clientKeyFrom(name, phone);
  return loadOrders().filter(o => clientKeyFrom(o.client_name, o.client_phone) === key && ACTIVE_STATUSES.has(o.status)).length;
}
function ensureClientLimitOrThrow(name, phone){
  if(!name || !phone) return;
  const active = countActiveOrdersForClient(name, phone);
  if(active >= MAX_ACTIVE_ORDERS_PER_CLIENT){
    throw new Error(`Ky klient ka tashmë ${active} porosi aktive. Lejohen deri në ${MAX_ACTIVE_ORDERS_PER_CLIENT}.`);
  }
}
function nextXCodeNumber(){
  const list = loadOrders();
  const nums = list.map(o => {
    const n = Number(normalizeXCode(o.code));
    return Number.isFinite(n) ? n : 0;
  });
  const max = nums.length ? Math.max(...nums) : 0;
  return max + 1;
}
function createOrder({ client_name, client_phone, client_code, pay_rate=0, pay_m2=0, pieces=[], notes='' }){
  ensureClientLimitOrThrow(client_name, client_phone);
  const id = uid();
  const code = 'X' + String(nextXCodeNumber()).padStart(3,'0');
  const order = {
    id, code,
    status: STATUS.PRANIM,
    ts: nowTs(),
    updatedAt: nowTs(),
    client_name: client_name || '',
    client_phone: client_phone || '',
    client_code: client_code || '',
    pay_rate: Number(pay_rate || 0),
    pay_m2: Number(pay_m2 || 0),
    pay_euro: Number((Number(pay_rate||0)*Number(pay_m2||0)).toFixed(2)),
    pieces: Array.isArray(pieces) ? pieces : [],
    notes: notes || '',
    flags: { readyToday: false, noShow: false },
  };
  saveOrder(order);
  return order;
}

/* =========================
   STATUS CHANGES
   ========================= */
function updateOrderStatus(id, newStatus){
  const o = getOrderById(id);
  if(!o) return;
  const cur = String(o.status).toLowerCase();
  const next = String(newStatus).toLowerCase();
  if(cur === next) return;
  o.status = next;
  o.updatedAt = nowTs();
  saveOrder(o);
}
function saveFormEdits(id, formValues={}){
  const o = getOrderById(id);
  if(!o) return;
  const keepStatus = o.status;
  const updated = { ...o, ...formValues, status: keepStatus, updatedAt: nowTs() };
  saveOrder(updated);
}

/* =========================
   STRONG MULTI-FIELD SEARCH + AUTO-BIND
   ========================= */
function searchOrders(rawQuery=''){
  const q = String(rawQuery || '').trim();
  if(!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);

  const out = [];
  const seen = new Set();

  for(const o of loadOrders()){
    const nameF = fold(o.client_name);
    const phoneF = normalizePhone(o.client_phone);
    const xF = normalizeXCode(o.code);

    const nameTokens = tokens.filter(t => !/^\d+$/.test(t));
    const nameMatch = nameTokens.length ? nameTokens.every(t => nameF.includes(fold(t))) : false;

    const phoneTokens = tokens.map(normalizePhone).filter(t => t.length>0);
    const phoneMatch = phoneTokens.length ? phoneTokens.some(t => phoneF.includes(t)) : false;

    const xTokens = tokens.map(normalizeXCode).filter(Boolean);
    const xMatch = xTokens.length ? xTokens.some(t => xF === t || xF.startsWith(t)) : false;

    if(nameMatch || phoneMatch || xMatch){
      if(!seen.has(o.id)){
        seen.add(o.id);
        out.push(o);
      }
    }
  }
  out.sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
  return out;
}

function installSearch(selectorList){
  const sels = Array.isArray(selectorList) ? selectorList : ['#search','input[type="search"]','input[name="search"]'];
  const el = sels.map(s=>document.querySelector(s)).find(Boolean);
  if(!el) return false;
  el.addEventListener('input', ()=>{
    const q = el.value || '';
    const results = searchOrders(q);
    if(typeof window.renderSearch === 'function'){ window.renderSearch(results); }
    else { console.log('Search results:', results); }
  }, { passive:true });
  return true;
}

/* Try to auto-bind search to common inputs */
document.addEventListener('DOMContentLoaded', ()=>{
  installSearch(['#search','input[type="search"]','input[name="search"]','[data-search]']);
  // Show a small version badge so you can SEE this file is loaded
  try {
    const b = document.createElement('div');
    b.textContent = VERSION;
    b.style.position='fixed';
    b.style.bottom='6px';
    b.style.right='8px';
    b.style.padding='4px 6px';
    b.style.fontSize='10px';
    b.style.opacity='0.5';
    b.style.background='black';
    b.style.color='white';
    b.style.zIndex='99999';
    b.style.borderRadius='4px';
    document.body.appendChild(b);
    setTimeout(()=>{ b.remove(); }, 4000);
  } catch {}
});

/* =========================
   LISTS by status
   ========================= */
function listPastrimi(){ return loadOrders().filter(o => o.status === STATUS.PASTRIM && !o.flags.noShow); }
function listGati(){ return loadOrders().filter(o => o.status === STATUS.GATI && !o.flags.noShow); }
function listMarrjeSot(){ return loadOrders().filter(o => o.status === STATUS.GATI && o.flags.readyToday && !o.flags.noShow); }

/* =========================
   UI HOOKS (optional)
   ========================= */
document.addEventListener('click', (e)=>{
  const q = sel => e.target.closest(sel);
  const gBtn = q('[data-action="mark-gati"]');
  if(gBtn){ updateOrderStatus(gBtn.getAttribute('data-id'), STATUS.GATI); return; }
  const pBtn = q('[data-action="mark-pastrim"]');
  if(pBtn){ updateOrderStatus(pBtn.getAttribute('data-id'), STATUS.PASTRIM); return; }
  const dBtn = q('[data-action="mark-dorezuar"]');
  if(dBtn){ updateOrderStatus(dBtn.getAttribute('data-id'), STATUS.DOREZUAR); return; }
});

/* =========================
   EXPORTS
   ========================= */
window.Tepiha = {
  // CRUD / status
  createOrder, saveFormEdits, updateOrderStatus,
  // lists
  listPastrimi, listGati, listMarrjeSot,
  // search
  searchOrders, installSearch,
  // sync
  syncOrders,
  // utils
  loadOrders, getOrderById, saveOrder,
};


// === GPT-INJECT: legacy fallback ===
function getOrderById(id){
  try{
    const raw = localStorage.getItem('order_' + id);
    if (raw) return JSON.parse(raw);
  }catch(e){}
  return null;
}


// === GPT-INJECT: legacy saveDraftLocal fallback ===
function saveDraftLocal(order){
  try{
    if(!order) return false;
    if(!order.id){ order.id = (order.code || ('ord_'+Date.now())); }
    localStorage.setItem('order_'+order.id, JSON.stringify(order));
    try{ if(window.unifiedList){ window.unifiedList.upsert(order); } }catch(e){}
    return true;
  }catch(e){ return false; }
}


// === GPT-INJECT: legacy mirrorToUnifiedStore fallback ===
function mirrorToUnifiedStore(order){
  try{ if(window.unifiedList){ window.unifiedList.upsert(order); } }catch(e){}
}

