// lib/offlineStore.js
// Versioni i Blinduar - Pa bllokada për porositë e reja

const DB_NAME = "tepiha_offline_db";
const DB_VERSION = 3;

const LS_QUEUE_MIRROR = 'tepiha_offline_queue_v1';
const LS_QUEUE_MIRROR_MAX = 500;

function safeParse(s, fallback){
  try { return JSON.parse(s); } catch { return fallback; }
}

function mirrorPush(row){
  try{
    const list = safeParse(localStorage.getItem(LS_QUEUE_MIRROR) || '[]', []);
    const next = Array.isArray(list) ? list : [];
    if (row.op_id && next.some(x => x.op_id === row.op_id)) return;
    next.push(row);
    while(next.length > LS_QUEUE_MIRROR_MAX) next.shift();
    localStorage.setItem(LS_QUEUE_MIRROR, JSON.stringify(next));
  }catch{}
}

export function readQueueMirror(){
  try{
    const list = safeParse(localStorage.getItem(LS_QUEUE_MIRROR) || '[]', []);
    return Array.isArray(list) ? list : [];
  }catch{ return []; }
}

function openDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains("orders")) db.createObjectStore("orders", { keyPath:"id" });
      if(!db.objectStoreNames.contains("clients")) db.createObjectStore("clients", { keyPath:"id" });
      if(!db.objectStoreNames.contains("ops")) db.createObjectStore("ops", { keyPath:"op_id" });
      if(!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath:"key" });
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}

export async function saveOrderLocal(order){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("orders","readwrite");
    const id = String(order?.id ?? order?.local_oid ?? order?.oid ?? '');
    if(!id) return res(false);
    
    tx.objectStore("orders").put({
      ...order,
      id,
      updated_at: order?.updated_at || new Date().toISOString(),
    });
    tx.oncomplete=()=>res(true);
    tx.onerror=()=>rej(tx.error);
  });
}

export async function removeOrderLocal(id){
  try{
    const db = await openDB();
    const key = String(id);
    return await new Promise((res,rej)=>{
      const tx = db.transaction("orders","readwrite");
      const store = tx.objectStore("orders");
      const g = store.get(key);
      g.onsuccess = ()=>{
        const cur = g.result;
        if(cur && typeof cur === 'object'){
          store.put({ ...cur, _synced: true, localOnly: false, updated_at: new Date().toISOString() });
        }
      };
      tx.oncomplete=()=>res(true);
      tx.onerror=()=>rej(tx.error);
    });
  } catch { return false; }
}

export async function getAllOrdersLocal(){
  let idbRows = [];
  try{
    const db = await openDB();
    idbRows = await new Promise((res,rej)=>{
      const tx = db.transaction("orders","readonly");
      const req = tx.objectStore("orders").getAll();
      req.onsuccess=()=>res(req.result||[]);
      req.onerror=()=>rej(req.error);
    });
  } catch { idbRows = []; }

  let legacyRows = [];
  try {
    // Shiko te memory e vjeter nese ka mbetur gje
    const queueRaw = window.localStorage.getItem('tepiha_offline_queue_v1');
    if(queueRaw){
        const q = safeParse(queueRaw, []);
        q.forEach(it => { 
          const ord = it.order || it.payload || it;
          if(ord && typeof ord === 'object') legacyRows.push(ord); 
        });
    }
  } catch { legacyRows = []; }

  let blacklist = [];
  try { blacklist = safeParse(window.localStorage.getItem('tepiha_ghost_blacklist') || '[]', []); } catch(e) {}

  const all = [...idbRows, ...legacyRows];
  const unique = [];
  const seen = new Set();
  
  for (const o of all) {
    const oid = String(o.id || o.local_oid || o.oid || '');
    if (!oid) continue;
    if (blacklist.includes(oid)) continue;
    
    // 🔥 RREGULLIMI KRYESOR: Prano cdo gje qe ka qofte edhe nje kod ose emer
    const hasData = o.code || o.client || o.client_name || o.data || (o.tepiha && o.tepiha.length > 0) || o.phone;
    if (!hasData) continue;

    if (!seen.has(oid)) {
      seen.add(oid);
      unique.push(o);
    }
  }
  return unique;
}

export async function pushOp(op){
  try { mirrorPush(op); } catch {}
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("ops","readwrite");
    tx.objectStore("ops").put(op);
    tx.oncomplete=()=>res(true);
    tx.onerror=()=>rej(tx.error);
  });
}

export async function deleteOp(op_id){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("ops","readwrite");
    tx.objectStore("ops").delete(op_id);
    tx.oncomplete=()=>res(true);
    tx.onerror=()=>rej(tx.error);
  });
}

export async function getPendingOps(){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("ops","readonly");
    const req = tx.objectStore("ops").getAll();
    req.onsuccess=()=>res(req.result||[]);
    req.onerror=()=>rej(req.error);
  });
}

export async function saveClientLocal(client){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("clients","readwrite");
    tx.objectStore("clients").put(client);
    tx.oncomplete=()=>res(true);
    tx.onerror=()=>rej(tx.error);
  });
}

export async function getAllClientsLocal(){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("clients","readonly");
    const req = tx.objectStore("clients").getAll();
    req.onsuccess=()=>res(req.result||[]);
    req.onerror=()=>rej(req.error);
  });
}

export async function setMeta(key,value){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("meta","readwrite");
    tx.objectStore("meta").put({key,value});
    tx.oncomplete=()=>res(true);
    tx.onerror=()=>rej(tx.error);
  });
}

export async function getMeta(key){
  try{
    const db = await openDB();
    return await new Promise((res,rej)=>{
      const tx = db.transaction("meta","readonly");
      const req = tx.objectStore("meta").get(String(key));
      req.onsuccess=()=>res(req.result?.value ?? null);
      req.onerror=()=>rej(req.error);
    });
  } catch { return null; }
}
