import { approvedApiRequest } from './approvedApiRequest.js';

export async function readDispatchOrders(actorId, signal) {
  const result = await approvedApiRequest('/api/transport/order', {
    action: 'LIST', expected_actor_id: actorId,
  }, { timeoutMs: 12000, signal });
  if (!Array.isArray(result?.items) || result.actorId !== actorId
    || result.items.some(row => !row || typeof row.id !== 'string' || !row.id)) {
    throw new Error('DISPATCH_LIST_INVALID_RESPONSE');
  }
  return result.items.map(row => ({ ...row, _table: 'transport_orders' }));
}
