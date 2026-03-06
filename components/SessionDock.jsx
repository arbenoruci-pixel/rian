
'use client'
import { useRouter, usePathname } from 'next/navigation'

export default function SessionDock(){
  const router = useRouter()
  const pathname = usePathname()

  if(pathname !== '/') return null

  return (
    <div
      onClick={()=>router.push('/doctor')}
      style={{
        position:'fixed',
        bottom:14,
        left:'50%',
        transform:'translateX(-50%)',
        padding:'6px 14px',
        borderRadius:20,
        background:'#111',
        color:'#fff',
        fontSize:12,
        cursor:'pointer',
        opacity:0.8
      }}
    >
      DOC
    </div>
  )
}
