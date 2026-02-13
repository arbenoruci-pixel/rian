
const DB_NAME = "tepiha_offline_db";
const DB_VERSION = 1;

function openDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains("orders")){
        db.createObjectStore("orders", { keyPath:"id" });
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
  const db = await openDB();
  return new Promise((res,rej)=>{
    const tx = db.transaction("orders","readonly");
    const req = tx.objectStore("orders").getAll();
    req.onsuccess=()=>res(req.result||[]);
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
