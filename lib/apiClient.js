// lib/apiClient.js
import { saveOrderLocal, getOrderLocal, pushOp } from "./offlineStore";
import { runSync } from "./syncEngine";

function now(){ return Date.now(); }
function uuid(){ return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(now()) + "_" + Math.random().toString(16).slice(2); }

export async function saveOrder(order){
  const o = { ...order };
  if(!o.id) o.id = uuid();
  o.updated_at = now();
  o.dirty = true;

  await saveOrderLocal(o);

  await pushOp({
    op_id: uuid(),
    type: "save_order",
    entity: "order",
    entity_id: o.id,
    payload: o,
    created_at: now(),
  });

  if(typeof navigator !== "undefined" && navigator.onLine){
    runSync();
  }

  return o;
}

export async function setStatus(orderId, status, extra = {}){
  const current = await getOrderLocal(orderId);
  const next = { ...(current||{id:orderId}), status, ...extra, updated_at: now(), dirty: true };

  await saveOrderLocal(next);

  await pushOp({
    op_id: uuid(),
    type: "set_status",
    entity: "order",
    entity_id: orderId,
    payload: { id: orderId, status, ...extra, updated_at: next.updated_at },
    created_at: now(),
  });

  if(typeof navigator !== "undefined" && navigator.onLine){
    runSync();
  }

  return next;
}

export async function addPayment(orderId, payment){
  // payment should be a ledger row (recommended). If your DB uses paid_total, keep it in payload too.
  await pushOp({
    op_id: uuid(),
    type: "add_payment",
    entity: "payment",
    entity_id: orderId,
    payload: { order_id: orderId, ...payment, created_at: now() },
    created_at: now(),
  });

  if(typeof navigator !== "undefined" && navigator.onLine){
    runSync();
  }

  return true;
}
