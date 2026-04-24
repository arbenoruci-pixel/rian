'use client'

import { useEffect, useRef, useState } from 'react'
import { getOutboxSnapshot, syncNow } from '@/lib/syncManager'

const SNAPSHOT_KEY = 'tepiha_sync_snapshot_v1'
const FALLBACK_REFRESH_MS = 180000
const LS_DEBUG_FLAG = 'tepiha_debug_outbox_monitor'

function shouldShow() {
  try {
    if (typeof window === 'undefined') return false
    const qs = new URLSearchParams(window.location.search || '')
    if (qs.get('debugOutbox') === '1') return true
    return window.localStorage.getItem(LS_DEBUG_FLAG) === '1'
  } catch {
    return false
  }
}

export default function OutboxMonitor(){
  const [items,setItems] = useState([])
  const [enabled, setEnabled] = useState(false)
  const lastSnapshotRef = useRef('')
  const wakeTimerRef = useRef(null)

  function refresh(force = false){
    try {
      const raw = typeof window !== 'undefined' ? (window.localStorage.getItem(SNAPSHOT_KEY) || '[]') : '[]'
      if (!force && raw === lastSnapshotRef.current) return
      lastSnapshotRef.current = raw
    } catch {}
    const snapshot = getOutboxSnapshot() || []
    setItems(snapshot)
  }

  useEffect(() => {
    setEnabled(shouldShow())
  }, [])

  useEffect(()=>{
    if (!enabled) return

    refresh(true)

    const onOutboxChanged = () => refresh(true)
    const onStorage = (e) => {
      if (!e || e.key === SNAPSHOT_KEY || e.key === null) refresh(true)
    }
    const scheduleRefresh = (delay = 0) => {
      if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = setTimeout(() => {
        wakeTimerRef.current = null
        refresh(true)
      }, Math.max(0, Number(delay) || 0))
    }
    const onFocus = () => scheduleRefresh(2200)
    const onOnline = () => scheduleRefresh(2600)
    const onVisible = () => {
      try {
        if (document.visibilityState === 'visible') scheduleRefresh(2200)
      } catch {
        refresh(true)
      }
    }

    window.addEventListener('tepiha:outbox-changed', onOutboxChanged)
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)

    const t = setInterval(() => refresh(false), FALLBACK_REFRESH_MS)

    return ()=>{
      clearInterval(t)
      if (wakeTimerRef.current) clearTimeout(wakeTimerRef.current)
      window.removeEventListener('tepiha:outbox-changed', onOutboxChanged)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  },[enabled])

  if (!enabled) return null

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
          refresh(true)
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
