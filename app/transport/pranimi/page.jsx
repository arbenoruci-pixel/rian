'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';
import { reserveTransportCode, markTransportCodeUsed } from '@/lib/transportCodes';
import { insertTransportOrder, saveOfflineTransportOrder } from '@/lib/transport/transportDb'; 
import { recordCashMove } from '@/lib/arkaCashSync';
import { addTransportCollected } from '@/lib/transportArkaStore';

// --- CONFIG ---
const BUCKET = 'tepiha-photos'; 
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;
const PHONE_PREFIX_DEFAULT = '+383';
const PAY_CHIPS = [5, 10, 20, 30, 50];
const DRAFT_KEY = 'transport_drafts_v1';

// Drafts are per-transport to avoid mixing drivers.
function draftKeyForTransport(transportId) {
  return `transport_drafts_v1__${String(transportId || 'unknown')}`;
}
function readDraftList(transportId) {
  try {
    const raw = localStorage.getItem(draftKeyForTransport(transportId));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function writeDraftList(transportId, list) {
  try {
    localStorage.setItem(draftKeyForTransport(transportId), JSON.stringify(list || []));
  } catch {}
}
function splitPrefixAndPhone(rawPhone) {
  const p = String(rawPhone || '').trim();
  if (!p) return { prefix: PHONE_PREFIX_DEFAULT, phone: '' };
  if (p.startsWith('+')) {
    // +383 44 123 456  -> prefix +383, phone 44123456
    const m = p.match(/^\+(\d{1,4})\s*(.*)$/);
    if (m) {
      const pref = `+${m[1]}`;
      const rest = String(m[2] || '').replace(/\D+/g, '');
      return { prefix: pref, phone: rest };
    }
  }
  // already digits (no prefix)
  return { prefix: PHONE_PREFIX_DEFAULT, phone: p.replace(/\D+/g, '') };
}


// --- HELPERS ---
function sanitizePhone(phone) { return String(phone || '').replace(/\D+/g, ''); }
function normalizeTCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '0';
    return `T${n}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n ? `T${n}` : '';
}
function computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer) {
  const t = (tepihaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const s = (stazaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
  return Number((t + s + sh).toFixed(2));
}
function parseNum(v, fallback = 0) {
  const s = String(v ?? '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

// --- UPLOAD ---
async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, cacheControl: '0' });
  if (error) { console.error("Upload Error:", error); throw error; }
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

// --- CHIP STYLE ---
function chipStyleForVal(v, active) {
  const n = Number(v);
  let a = 'rgba(59,130,246,0.18)'; 
  let b = 'rgba(59,130,246,0.06)';
  let br = 'rgba(59,130,246,0.35)';

  if (n >= 5.8) { a = 'rgba(249,115,22,0.20)'; b = 'rgba(249,115,22,0.08)'; br = 'rgba(249,115,22,0.38)'; } 
  else if (Math.abs(n - 3.2) < 0.051) { a = 'rgba(239,68,68,0.20)'; b = 'rgba(239,68,68,0.08)'; br = 'rgba(239,68,68,0.38)'; } 
  else if (n >= 3.5) { a = 'rgba(236,72,153,0.18)'; b = 'rgba(236,72,153,0.06)'; br = 'rgba(236,72,153,0.35)'; } 
  else if (n >= 2.2) { a = 'rgba(245,158,11,0.18)'; b = 'rgba(245,158,11,0.06)'; br = 'rgba(245,158,11,0.35)'; } 
  else { a = 'rgba(168,85,247,0.18)'; b = 'rgba(168,85,247,0.06)'; br = 'rgba(168,85,247,0.35)'; }

  return {
    background: `linear-gradient(180deg, ${a}, ${b})`,
    border: `1px solid ${br}`,
    outline: active ? '2px solid rgba(255,255,255,0.22)' : 'none',
    boxShadow: active
      ? '0 10px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.18)'
      : '0 8px 14px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.14)',
  };
}

export default function TransportPranim() {
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get('id') || '';
  const back = sp.get('back') || sp.get('return') || '/transport/offload';
  const openDraftsOnLoad = sp.get('drafts') === '1';

  const [me, setMe] = useState(null);
  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');

  // Data
  const [name, setName] = useState('');
  const [phonePrefix, setPhonePrefix] = useState(PHONE_PREFIX_DEFAULT);
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');
  const [address, setAddress] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [clientDesc, setClientDesc] = useState('');
  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');
  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  // NOTE: "E PA PLOTSUAR" checkbox removed. Drafts are handled via local drafts list.

  // DEBUG & Modals
  const [logs, setLogs] = useState([]);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);
  const [payAddRaw, setPayAddRaw] = useState('');
  const [drafts, setDrafts] = useState([]);

  // Client search (past clients)
  const [clientSearch, setClientSearch] = useState('');
  const [clientHits, setClientHits] = useState([]);
  const [clientSearchBusy, setClientSearchBusy] = useState(false);

  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);
  const payTouchRef = useRef({ x: 0, y: 0, moved: false });
  const draftTimerRef = useRef(null);

  // LOG HELPER
  function addLog(msg) {
      setLogs(prev => [`> ${msg}`, ...prev]);
      console.log(`[DEBUG] ${msg}`);
  }

  
  async function searchPastClients(q) {
    const term = String(q || '').trim();
    if (!term) { setClientHits([]); return; }
    setClientSearchBusy(true);
    try {
      const like = `%${term}%`;
      let hits = [];

      // 1) BASE clients table (same clients you see in PASRTIMI)
      const cRes = await supabase
        .from('clients')
        .select('full_name, phone')
        .or(`full_name.ilike.${like},phone.ilike.${like}`)
        .order('updated_at', { ascending: false })
        .limit(20);

      if (!cRes.error && Array.isArray(cRes.data) && cRes.data.length) {
        hits = cRes.data.map(r => ({ name: r.full_name || '', phone: r.phone || '' }));
      } else {
        // 2) transport_clients if allowed
        const res1 = await supabase
          .from('transport_clients')
          .select('client_name, client_phone')
          .or(`client_name.ilike.${like},client_phone.ilike.${like}`)
          .order('updated_at', { ascending: false })
          .limit(20);

        if (!res1.error && Array.isArray(res1.data) && res1.data.length) {
          hits = res1.data.map(r => ({ name: r.client_name || '', phone: r.client_phone || '' }));
        } else {
          // 3) fallback: distinct from transport_orders
          const res2 = await supabase
            .from('transport_orders')
            .select('client_name, client_phone, updated_at')
            .or(`client_name.ilike.${like},client_phone.ilike.${like}`)
            .order('updated_at', { ascending: false })
            .limit(30);

          if (!res2.error && Array.isArray(res2.data)) {
            const seen = new Set();
            for (const r of res2.data) {
              const key = `${r.client_phone||''}::${r.client_name||''}`;
              if (seen.has(key)) continue;
              seen.add(key);
              hits.push({ name: r.client_name || '', phone: r.client_phone || '' });
              if (hits.length >= 20) break;
            }
          }
        }
      }

      setClientHits(hits);
    } catch (e) {
      console.error('searchPastClients', e);
    } finally {
      setClientSearchBusy(false);
    }
  }
// Init

  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) { router.push('/transport'); return; }
    setMe(s);
  }, [router]);

  useEffect(() => {
    const q = String(clientSearch || '').trim();
    if (!q) { setClientHits([]); return; }
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => { searchPastClients(q); }, 180);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [clientSearch]);

  useEffect(() => {
    if (!me?.transport_id) return;
    (async () => {
      try {
        refreshDrafts();
        if (openDraftsOnLoad) setShowDraftsSheet(true);
        
        // 1. Nëse vjen nga URL (draft / edit)
        if (editId) {
            // try to load from drafts list first (TË PA PLOTSUARAT)
            loadDraftById(editId);
            setCreating(false);
            return;
        }

        // ✅ FIX KRYESOR: Përdor UUID të vërtetë, jo tord_...
        // Kjo e zgjidh problemin e screenshot-it
        const id = crypto.randomUUID(); 
        setOid(id);
        
        const tcode = await reserveTransportCode();
        setCodeRaw(tcode);
        setCreating(false);
      } catch (e) { 
          console.error(e); 
          setCreating(false); 
      }
    })();
  }, [me, editId]);

  // ✅ LOGJIKA E DRAFTEVE (Të pa plotsuara)
  useEffect(() => {
    if (creating || !oid) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);

    // Ruaj draft automatikisht pas 1 sekonde nëse ka ndonjë të dhënë
    draftTimerRef.current = setTimeout(() => {
        const hasData = (name && name.length > 1) || (phone && phone.length > 3) || tepihaRows.length > 0;
        
        // Vetëm nëse ka shkru diçka, ruaje në draft
        if (hasData) {
            saveDraftLocal();
        }
    }, 1000);

    return () => clearTimeout(draftTimerRef.current);
  });

  function refreshDrafts() {
    try {
        const tid = me?.transport_id;
        let list = [];
        if (tid) list = readDraftList(tid);
        // MIGRATE legacy drafts (old key without transport_id suffix)
        if (tid && (!Array.isArray(list) || list.length === 0)) {
          try {
            const legacy = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]');
            const leg = Array.isArray(legacy) ? legacy : [];
            const migrated = leg.map(d => ({ ...d, scope: d?.scope || 'transport', transport_id: String(tid) }))
              .filter(d => d && d.id);
            if (migrated.length) {
              writeDraftList(tid, migrated);
              list = migrated;
              // keep legacy as-is (do not delete) to avoid data loss
            }
          } catch {}
        }

        else { try { list = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); } catch { list = []; } }
        list = Array.isArray(list) ? list : [];
        // keep only transport drafts (new unified source)
        list = list.filter(d => d?.scope === 'transport' || d?.transport_id);
        list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        setDrafts(list);
    } catch {}
  } catch {}
  }

  function saveDraftLocal() {
    try {
        const tid = me?.transport_id;
        const draft = {
          id: oid,
          ts: Date.now(),
          scope: 'transport',
          transport_id: String(tid || ''),
          codeRaw,
          name,
          phone,
          phonePrefix,
          clientPhotoUrl,
          address,
          gpsLat,
          gpsLng,
          clientDesc,
          tepihaRows,
          stazaRows,
          stairsQty,
          stairsPer,
          stairsPhotoUrl,
          pricePerM2,
          clientPaid,
          notes
        };

        let list = [];
        if (tid) {
          list = readDraftList(tid);
        } else {
          try { list = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); } catch { list = []; }
        }
        list = Array.isArray(list) ? list : [];
        list = list.filter(d => d.id !== oid);
        list.unshift(draft);
        if (list.length > 50) list = list.slice(0, 50);

        if (tid) writeDraftList(tid, list);
        else localStorage.setItem(DRAFT_KEY, JSON.stringify(list));

        setDrafts(list);
    } catch {}
  } catch {}
  }

  function loadDraftById(id) {
      try {
        const tid = me?.transport_id;
        let list = [];
        if (tid) list = readDraftList(tid);