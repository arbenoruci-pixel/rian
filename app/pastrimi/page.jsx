'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getAllOrdersLocal, saveOrderLocal } from '@/lib/offlineStore';
import { recordCashMove } from '@/lib/arkaCashSync';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getOutboxSnapshot } from '@/lib/syncManager';
import PosModal from '@/components/PosModal';

// NOTE: patched openEdit logic to use universal extractors

// --- CONFIG ---
const BUCKET = 'tepiha-photos';
const LOCAL_ORDERS_KEY = 'tepiha_local_orders_v1';
const OFFLINE_QUEUE_KEY = 'tepiha_offline_queue_v1';

const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;

// ---------------- HELPERS ----------------
function extractArray(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(obj[k]) && obj[k].length) return obj[k];
    if (obj.data && typeof obj.data === 'object' && Array.isArray(obj.data[k]) && obj.data[k].length) return obj.data[k];
    if (typeof obj.data === 'string') {
      try {
        const p = JSON.parse(obj.data);
        if (Array.isArray(p[k]) && p[k].length) return p[k];
      } catch {}
    }
  }
  return [];
}

function getTepihaRows(order){ return extractArray(order,'tepiha','tepihaRows'); }
function getStazaRows(order){ return extractArray(order,'staza','stazaRows'); }

function getStairsQty(order){
  let q =
    Number(order?.shkallore?.qty) ||
    Number(order?.data?.shkallore?.qty) ||
    Number(order?.stairsQty) ||
    Number(order?.data?.stairsQty) ||
    0;
  if(!q && typeof order?.data === 'string'){
    try{
      const p = JSON.parse(order.data);
      q = Number(p?.shkallore?.qty) || Number(p?.stairsQty) || 0;
    }catch{}
  }
  return q;
}

function getStairsPer(order){
  let p =
    Number(order?.shkallore?.per) ||
    Number(order?.data?.shkallore?.per) ||
    Number(order?.stairsPer) ||
    Number(order?.data?.stairsPer) ||
    0.3;
  if(p===0.3 && typeof order?.data === 'string'){
    try{
      const pr = JSON.parse(order.data);
      p = Number(pr?.shkallore?.per) || Number(pr?.stairsPer) || 0.3;
    }catch{}
  }
  return p;
}

function computeM2(order){
  if(!order) return 0;
  let total = 0;
  for(const r of getTepihaRows(order))
    total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0)||0) * (Number(r?.qty ?? r?.pieces ?? 0)||0);
  for(const r of getStazaRows(order))
    total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0)||0) * (Number(r?.qty ?? r?.pieces ?? 0)||0);
  total += getStairsQty(order) * getStairsPer(order);
  return Number(total.toFixed(2));
}

function computePieces(order){
  if(!order) return 0;
  let p = 0;
  for(const r of getTepihaRows(order))
    p += (Number(r?.qty ?? r?.pieces ?? 0)||0);
  for(const r of getStazaRows(order))
    p += (Number(r?.qty ?? r?.pieces ?? 0)||0);
  p += getStairsQty(order);
  return p;
}

export default function PastrimiPage(){ return null }

// PATCH NOTE:
// openEdit in original file must be replaced with:
//
// const tList = getTepihaRows(ord);
// const sList = getStazaRows(ord);
//
// setTepihaRows(
//   tList.length
//     ? tList.map((x,i)=>({
//         id:`t${i+1}`,
//         m2:String(x?.m2 ?? x?.m ?? x?.area ?? ''),
//         qty:String(x?.qty ?? x?.pieces ?? ''),
//         photoUrl:x?.photoUrl||''
//       }))
//     : [{id:'t1', m2:'', qty:'', photoUrl:''}]
// );
//
// setStazaRows(
//   sList.length
//     ? sList.map((x,i)=>({
//         id:`s${i+1}`,
//         m2:String(x?.m2 ?? x?.m ?? x?.area ?? ''),
//         qty:String(x?.qty ?? x?.pieces ?? ''),
//         photoUrl:x?.photoUrl||''
//       }))
//     : [{id:'s1', m2:'', qty:'', photoUrl:''}]
// );
//
// setStairsQty(getStairsQty(ord));
// setStairsPer(getStairsPer(ord));
