
import { supabase } from '@/lib/supabaseClient'

/**
 * Safe upsert that tolerates schema mismatches like `delivered_at`
 */
async function safeUpsert(table, payload){
  try{
    const { error } = await supabase.from(table).upsert(payload)
    if(error) throw error
    return { ok:true }
  }catch(err){
    const msg = String(err?.message || '')
    if(msg.includes('delivered_at')){
      const cleaned = Array.isArray(payload)
        ? payload.map(p => { const c={...p}; delete c.delivered_at; return c })
        : (()=>{ const c={...payload}; delete c.delivered_at; return c })()

      const { error:retryErr } = await supabase.from(table).upsert(cleaned)
      if(retryErr) throw retryErr
      return { ok:true, fallback:true }
    }
    throw err
  }
}

export async function syncOrders(orders){
  if(!orders || !orders.length) return { ok:true }
  return safeUpsert('orders', orders)
}

export async function syncTransport(rows){
  if(!rows || !rows.length) return { ok:true }
  return safeUpsert('transport_orders', rows)
}
