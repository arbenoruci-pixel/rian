
'use client'

import { useEffect } from 'react'
import { startAutoSync } from '@/lib/syncManager'

export default function SyncBoot(){

  useEffect(()=>{

    const stop = startAutoSync()

    return () => {
      if(stop) stop()
    }

  },[])

  return null
}
