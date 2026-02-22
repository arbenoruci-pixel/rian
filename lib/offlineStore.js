// lib/offlineStore.js
// Offline-first: IndexedDB stores orders + clients + ops queue + meta

const DB_NAME = "tepiha_offline_db";
const DB_VERSION = 3;

function openDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;

      if(!db.objectStoreNames.contains("orders")){
        db.createObjectStore("orders", { keyPath:"id" });
      }
      if(!db.objectStoreNames.contains("clients")){
        db.createObjectStore("clients", { keyPath:"id" });
      }
      if(!db.objectStoreNames.contains("ops")){
        db.createObjectStore("ops", { keyPath:"op_id" });
      }
      if(!db.objectStoreNames.contains("meta")){
        db.createObjectStore("meta", { keyPath:"key" });
      }
    };
    req.onsuccess = ()=>resolve(req.result);
    req.onerror = ()=>reject(req.error);
  });
}

export async function saveOrderLocal(order){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("orders","readwrite");
    tx.objectStore("orders").put(order);
    tx.oncomplete=()=>res(true);
    tx.onerror=()=>rej(tx.error);
  });
}

export async function getAllOrdersLocal(){
  // Prefer IndexedDB, but fall back to legacy localStorage (older bundles)
  // if the IDB store is empty. This prevents Pastrimi/Gati from showing 0
  // after upgrading storage.
  let rows = [];
  try{
    const db = await openDB();
    rows = await new Promise((res,rej)=>{
      const tx = db.transaction("orders","readonly");
      const req = tx.objectStore("orders").getAll();
      req.onsuccess=()=>res(req.result||[]);
      req.onerror=()=>rej(req.error);
    });
  }catch{
    rows = [];
  }

  if(Array.isArray(rows) && rows.length>0) return rows;

  // ---- legacy localStorage migration (best-effort) ----
  try{
    if(typeof window==="undefined") return rows;
    const listRaw = window.localStorage.getItem('order_list_v1');
    if(!listRaw) return rows;
    const ids = JSON.parse(listRaw);
    if(!Array.isArray(ids) || ids.length===0) return rows;

    const legacy=[];
    for(const id of ids){
      const raw = window.localStorage.getItem(`order_${id}`);
      if(!raw) continue;
      try{
        const o = JSON.parse(raw);
        if(!o || typeof o!=="object") continue;
        if(!o.id) o.id=String(id);
        if(!o.updated_at) o.updated_at = o.updatedAt || o.created_at || new Date().toISOString();
        legacy.push(o);
      }catch{ /* ignore bad rows */ }
    }

    if(legacy.length===0) return rows;

    // Save into IDB for future reads (best-effort)
    try{
      for(const o of legacy){
        // eslint-disable-next-line no-await-in-loop
        await saveOrderLocal({ ...o, _local:true });
      }
    }catch{ /* ignore */ }

    return legacy;
  }catch{
    return rows;
  }
}


export async function getOrderLocal(id){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("orders","readonly");
    const req = tx.objectStore("orders").get(id);
    req.onsuccess=()=>res(req.result||null);
    req.onerror=()=>rej(req.error);
  });
}

// Needed by PRANIMI after a successful online sync (cleanup local draft/order)
export async function removeOrderLocal(id){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("orders","readwrite");
    tx.objectStore("orders").delete(id);
    tx.oncomplete=()=>res(true);
    tx.onerror=()=>rej(tx.error);
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

export async function getClientLocal(id){
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("clients","readonly");
    const req = tx.objectStore("clients").get(id);
    req.onsuccess=()=>res(req.result||null);
    req.onerror=()=>rej(req.error);
  });
}

export async function pushOp(op){
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
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("meta","readonly");
    const req = tx.objectStore("meta").get(key);
    req.onsuccess=()=>res(req.result?.value||null);
    req.onerror=()=>rej(req.error);
  });
}
