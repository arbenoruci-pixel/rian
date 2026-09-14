export * from '../../lib/ordersService.js';
// Only the local test server aliases ordersService here. Never included in app builds.
export async function resolveOrderById(id, source) {
 const r=await fetch(`/test-order?source=${source}&id=${encodeURIComponent(id)}`); const row=await r.json();
 return row ? {table:source==='base'?'orders':'transport_orders',row} : null;
}
export async function findLatestOrderByCode(){return null;}
export async function updateOrderData(){throw Error('Unrelated tracking writes disabled in isolated test');}
export async function updateOrderGps(){throw Error('Unrelated tracking writes disabled in isolated test');}
