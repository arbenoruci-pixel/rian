import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';

export async function setRiplan(supabase, orderId, payload){
  const { at, note } = payload;
  const patch = sanitizeTransportOrderPayload({
    status: 'riplan',
    data: {
      reschedule_at: at,
      reschedule_note: note,
    },
  });

  const { error } = await supabase
    .from('transport_orders')
    .update(patch)
    .eq('id', orderId);

  if(error){
    console.error('RIPLAN ERROR', error);
    throw error;
  }
}
