
// ULTRA FLOW STABIL V2 (SAFE PATCH)
// This helper ensures orders always default to 'pastrim' and prevents ghost saves.

export function enforceUltraFlow(order){
  if(!order) return order;
  if(!order.status || order.status !== 'pastrim'){
    order.status = 'pastrim';
  }
  return order;
}
