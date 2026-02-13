
import { saveOrderLocal, pushOp } from "./offlineStore";
import { runSync } from "./syncEngine";

export async function saveOrder(order){
  order.updated_at = Date.now();
  order.dirty = true;

  await saveOrderLocal(order);

  await pushOp({
    op_id: crypto.randomUUID(),
    type:"save_order",
    entity_id:order.id,
    payload:order,
    created_at:Date.now()
  });

  if(typeof navigator !== "undefined" && navigator.onLine){
    runSync();
  }

  return order;
}
