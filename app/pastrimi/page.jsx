'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function PastrimiPage() {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(false)

  async function loadOrders() {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .in('status', ['pastrim', 'pastrimi'])
        .order('updated_at', { ascending: false })

      if (error) throw error
      setOrders(data || [])
    } catch (err) {
      alert('ERROR LOAD: ' + err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadOrders()
  }, [])

  async function handleSave(order) {
    try {
      const { error } = await supabase
        .from('orders')
        .update({
          status: 'gati',
          updated_at: new Date().toISOString()
        })
        .eq('id', order.id)

      if (error) throw error

      // TRY budget but do not block
      try {
        await supabase.from('company_budget_moves').insert({
          amount: order.price_total || 0,
          direction: 'IN',
          category: 'Llarje',
          reason: 'Pastrimi Order',
          status: 'DONE'
        })
      } catch (e) {
        console.log('Budget skipped:', e.message)
      }

      await loadOrders()

    } catch (err) {
      alert('SAVE ERROR: ' + err.message)
    }
  }

  return (
    <div className="wrap">
      <h1>PASTRIMI</h1>

      {loading && <p>Loading...</p>}

      {orders.map(o => (
        <div key={o.id} className="row">
          <div>
            <b>{o.code_n}</b> - {o.client_name}
          </div>
          <button onClick={() => handleSave(o)}>GATI</button>
        </div>
      ))}

      <style jsx>{`
        .wrap { padding:20px; color:white; background:#0b0b0b; min-height:100vh }
        .row { display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid #222 }
        button { background:#22c55e; border:none; padding:6px 12px; border-radius:6px }
      `}</style>
    </div>
  )
}
