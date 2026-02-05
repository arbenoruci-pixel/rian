'use client';
import { useEffect } from 'react';
export default function TransportIndex(){
  useEffect(()=>{ window.location.replace('/transport/menu'); },[]);
  return null;
}
