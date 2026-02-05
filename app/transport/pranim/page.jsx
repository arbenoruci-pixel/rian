'use client';
import { useEffect } from 'react';
export default function TransportPranimRedirect(){
  useEffect(()=>{ window.location.replace('/transport/pranimi'); },[]);
  return null;
}
