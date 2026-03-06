
'use client'
import Link from 'next/link'
import SessionDock from '@/components/SessionDock'

export default function Home(){
  return (
    <div style={{padding:30}}>
      <h1>HOME</h1>

      <div style={{display:'flex',gap:10}}>
        <Link href="/pranimi">PRANIMI</Link>
        <Link href="/pastrimi">PASTRIMI</Link>
        <Link href="/gati">GATI</Link>
      </div>

      <SessionDock/>
    </div>
  )
}
