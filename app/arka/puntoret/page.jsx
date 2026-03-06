
'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'

export default function PuntoretPage(){
  const [devices,setDevices]=useState([])

  async function load(){
    const { data } = await supabase
      .from('worker_devices')
      .select('*')
      .order('created_at',{ascending:false})

    setDevices(data||[])
  }

  async function approve(device_id){
    await supabase
      .from('worker_devices')
      .update({ approved:true })
      .eq('device_id',device_id)

    load()
  }

  async function revoke(device_id){
    await supabase
      .from('worker_devices')
      .update({ approved:false })
      .eq('device_id',device_id)

    load()
  }

  useEffect(()=>{ load() },[])

  return (
    <div style={{padding:20}}>
      <h2>DEVICES</h2>

      {devices.map(d=>(
        <div key={d.device_id} style={{
          display:'flex',
          justifyContent:'space-between',
          marginBottom:8,
          borderBottom:'1px solid #333',
          paddingBottom:6
        }}>
          <span>{d.worker_name || 'UNKNOWN'}</span>

          <div>
            {!d.approved && (
              <button onClick={()=>approve(d.device_id)}>
                APPROVE
              </button>
            )}

            {d.approved && (
              <button onClick={()=>revoke(d.device_id)}>
                REVOKE
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
