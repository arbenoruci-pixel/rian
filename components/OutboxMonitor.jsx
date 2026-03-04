
'use client'

import { useEffect, useState } from 'react'
import { getOutboxSnapshot, syncNow } from '@/lib/syncManager'

export default function OutboxMonitor(){

  const [items,setItems] = useState([])

  function refresh(){
    const snapshot = getOutboxSnapshot() || []
    setItems(snapshot)
  }

  useEffect(()=>{

    refresh()

    const t = setInterval(refresh,3000)

    return ()=>clearInterval(t)

  },[])

  const pending = items.filter(i=>i.status==='pending').length
  const failed = items.filter(i=>i.status==='failed').length

  return (

    <div style={{
      padding:20,
      border:'1px solid #333',
      borderRadius:10,
      marginTop:20
    }}>

      <h2>OUTBOX MONITOR</h2>

      <div style={{marginBottom:10}}>
        Pending: <b>{pending}</b> | Failed: <b>{failed}</b> | Total: <b>{items.length}</b>
      </div>

      <button
        onClick={async ()=>{
          await syncNow()
          refresh()
        }}
      >
        FORCE SYNC
      </button>

      <div style={{marginTop:20}}>

        {items.map(item=>(

          <div
            key={item.id}
            style={{
              padding:10,
              borderBottom:'1px solid #222',
              fontSize:12
            }}
          >

            <div>
              <b>{item.kind}</b> | code: {item.uniqueValue}
            </div>

            <div>
              attempts: {item.attempts}
            </div>

            <div>
              created: {item.createdAt}
            </div>

            {item.lastError && (
              <div style={{color:'red'}}>
                error: {item.lastError.message}
              </div>
            )}

          </div>

        ))}

      </div>

    </div>

  )
}
