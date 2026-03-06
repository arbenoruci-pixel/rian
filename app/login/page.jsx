
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage(){
  const [pin,setPin]=useState('')
  const router = useRouter()

  const submit=(e)=>{
    e.preventDefault()
    localStorage.setItem('PIN',pin)
    router.push('/')
  }

  return (
    <div style={{display:'flex',height:'100vh',alignItems:'center',justifyContent:'center'}}>
      <form onSubmit={submit}>
        <h2>LOGIN</h2>
        <input
          type="password"
          value={pin}
          onChange={e=>setPin(e.target.value)}
          placeholder="PIN"
          style={{fontSize:20,padding:10}}
        />
        <button type="submit">ENTER</button>
      </form>
    </div>
  )
}
