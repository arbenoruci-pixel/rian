
export async function setRiplan(supabase, orderId, payload){
  const { at, note } = payload;

  const { error } = await supabase
    .from('transport_orders')
    .update({
      status: 'riplan',
      data: {
        reschedule_at: at,
        reschedule_note: note
      }
    })
    .eq('id', orderId);

  if(error){
    console.error('RIPLAN ERROR', error);
    throw error;
  }
}
