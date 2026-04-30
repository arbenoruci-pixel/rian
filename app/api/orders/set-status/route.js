import { apiOk, apiFail, createServiceClientOrThrow, logApiError, readBody } from '@/lib/apiService';
import { validateOrderStatus } from '@/lib/validation';
import { transitionOrderStatus, fetchOrderByIdSafe, updateOrderData } from '@/lib/ordersService';
export const dynamic = 'force-dynamic';

const ALLOWED = ['incomplete', 'pastrim', 'gati', 'dorzim'];

export async function POST(req) {
  try {
    const body = await readBody(req);
    const orderId = body?.order_id ?? body?.id;
    const nextStatus = validateOrderStatus('orders', body?.status, ALLOWED);

    if (!orderId) return apiFail('MISSING_ORDER_ID', 400);
    if (!nextStatus) return apiFail('INVALID_STATUS', 400);

    createServiceClientOrThrow(); // explicit server env check
    const cur = await fetchOrderByIdSafe('orders', orderId, 'id,status,ready_at,picked_up_at,data');
    if (!cur) return apiFail('ORDER_NOT_FOUND', 404);

    const patch = {};
    if (nextStatus === 'dorzim' && !cur.picked_up_at) patch.picked_up_at = new Date().toISOString();
    await transitionOrderStatus('orders', orderId, nextStatus, patch);
    await updateOrderData('orders', orderId, (current) => ({
      ...(current || {}),
      status: nextStatus,
      ...(nextStatus === 'dorzim'
        ? {
            ready_note: '',
            ready_note_text: '',
            ready_location: '',
            ready_slots: [],
            ready_note_at: null,
            ready_note_by: null,
          }
        : {}),
    }));

    const updated = await fetchOrderByIdSafe('orders', orderId, 'id,status,ready_at,picked_up_at,data');
    return apiOk({ order: updated });
  } catch (e) {
    logApiError('api.orders.set-status', e);
    const msg = String(e?.message || e);
    if (msg.includes('STATUS_TRANSITION_NOT_ALLOWED')) return apiFail(msg, 400);
    return apiFail(msg, 500);
  }
}
