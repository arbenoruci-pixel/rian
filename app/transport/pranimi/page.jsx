"use client";
import { computeM2FromRows } from '@/lib/baseCodes';
import { reserveTransportCode } from '@/lib/transportCodes';
import { getOrAssignTransportClientCode, normalizePhoneDigits } from '@/lib/transport/clientCodes';
import { upsertTransportClient } from '@/lib/transport/transportDb';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { saveOrderLocal, pushOp } from '@/lib/offlineStore';
import { getTransportSession, getTransportContext } from '@/lib/transportAuth';
import { recordCashMove } from '@/lib/arkaCashSync';
import PosModal from '@/components/PosModal';
import { enqueueTransportOrder, syncNow } from '@/lib/syncManager';
import { addTransportCollected } from '@/lib/transportArkaStore';
const BUCKET = 'tepiha-photos';
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;
const PAY_CHIPS = [5, 10, 20, 30, 50];
const PREFIX_OPTIONS = [
  { flag: '🇽🇰', code: '+383', label: 'KOSOVË' },
  { flag: '🇦🇱', code: '+355', label: 'SHQIPËRI' },
  { flag: '🇲🇰', code: '+389', label: 'MAQEDONI' },
  { flag: '🇨🇭', code: '+41',  label: 'ZVICËR' },
  { flag: '🇩🇪', code: '+49',  label: 'GJERMANI' },
  { flag: '🇦🇹', code: '+43',  label: 'AUSTRI' },
];
const DRAFT_LIST_KEY = 'transport_draft_orders_v1';
const DRAFT_ITEM_PREFIX = 'transport_draft_order_';
const COMPANY_PHONE_DISPLAY = '+383 44 735 312';
const AUTO_MSG_KEY = 'transport_pranimi_auto_msg_after_save';
const PRICE_KEY = 'transport_pranimi_price_per_m2';
const OFFLINE_MODE_KEY = 'transport_offline_mode_v1';
function normalizeTcode(raw) {
  if (!raw) return 'T0';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return `T${n || '0'}`;
}
const ACTIVE_CODE_KEY = 'transport_pranimi_active_code_v1';
const CODE_LEASE_KEY = 'transport_code_lease_v1';
const DRAFTS_FOLDER = 'transport_drafts';
const SETTINGS_FOLDER = 'transport_settings';
// ---------------- HELPERS ----------------
function sanitizePhone(phone) { return String(phone || '').replace(/\D+/g, ''); }
function normDigits(s) { return String(s || '').replace(/\D+/g, ''); }
function readCodeLease() { try { return JSON.parse(localStorage.getItem(CODE_LEASE_KEY)); } catch { return null; } }
function writeCodeLease(tid, code) { try { localStorage.setItem(CODE_LEASE_KEY, JSON.stringify({ tid: String(tid), code: String(code), at: Date.now() })); } catch {} }
async function getOrReserveTransportCode(tid) {
  const TID = String(tid || '').trim();
  if (!TID) return '';
  const lease = readCodeLease();
  if (lease && lease.tid === TID && (Date.now() - Number(lease.at || 0) < 60*60*1000)) return String(lease.code);
  const c = await reserveTransportCode(TID);
  if (c) writeCodeLease(TID, c);
  return c;
}
function readClientCodeMap(tid) {
  try {
    const key = `transport_client_code_map_v1_${String(tid || '')}`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
async function searchClientsLive(transportId, q) {
  const tid = String(transportId || '').trim();
  const qq = String(q || '').trim();
  if (!qq) return [];
  const qLower = qq.toLowerCase();
  const qDigits = normalizePhoneDigits(qq);
  const isDigitsOnly = qDigits && qDigits === qq.replace(/\s+/g, '');
  const isTCode = /^t\d+$/i.test(qLower) || (qLower.startsWith('t') && normalizePhoneDigits(qLower.slice(1)).length > 0);
  const tDigits = isTCode ? normalizePhoneDigits(qLower.replace(/^t/i, '')) : '';
  const out = [];
  const seen = new Set();
  const push = (x) => {
    const key = [
      String(x?.id || ''),
      String(x?.tcode || x?.client_tcode || ''),
      normalizePhoneDigits(x?.phone_digits || x?.phone || ''),
      String(x?.name || '').trim().toLowerCase(),
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(x);
  };
  if (qDigits.length >= 3) {
    const { data, error } = await supabase
      .from('transport_clients')
      .select('id, tcode, name, phone, phone_digits, address, gps_lat, gps_lng, updated_at')
      .ilike('phone_digits', `%${qDigits}%`)
      .order('updated_at', { ascending: false })
      .limit(12);
    if (!error) {
      (data || []).forEach((c) => {
        const digits = normalizePhoneDigits(c.phone_digits || c.phone || '');
        push({
          id: c.id, kind: 'client', tcode: String(c.tcode || ''), name: String(c.name || ''),
          phone: String(c.phone || ''), phone_digits: digits, address: c.address || '', gps_lat: c.gps_lat, gps_lng: c.gps_lng,
        });
      });
    }
  }
  if (isTCode && tDigits) {
    const { data, error } = await supabase
      .from('transport_clients')
      .select('id, tcode, name, phone, phone_digits, address, gps_lat, gps_lng, updated_at')
      .ilike('tcode', `T${tDigits}%`)
      .order('updated_at', { ascending: false })
      .limit(12);
    if (!error) {
      (data || []).forEach((c) => {
        const digits = normalizePhoneDigits(c.phone_digits || c.phone || '');
        push({
          id: c.id, kind: 'client', tcode: String(c.tcode || ''), name: String(c.name || ''),
          phone: String(c.phone || ''), phone_digits: digits, address: c.address || '', gps_lat: c.gps_lat, gps_lng: c.gps_lng,
        });
      });
    }
  }
  if (tid && isDigitsOnly && qDigits.length >= 1 && qDigits.length <= 6) {
    const codeWanted = Number(qDigits);
    if (Number.isFinite(codeWanted) && codeWanted > 0) {
      const map = readClientCodeMap(tid);
      const phoneDigitsMatches = Object.keys(map || {}).filter((pd) => Number(map[pd]) === codeWanted);
      if (phoneDigitsMatches.length > 0) {
        const { data, error } = await supabase
          .from('transport_clients')
          .select('id, tcode, name, phone, phone_digits, address, gps_lat, gps_lng, updated_at')
          .in('phone_digits', phoneDigitsMatches)
          .order('updated_at', { ascending: false })
          .limit(12);
        if (!error) {
          (data || []).forEach((c) => {
            const digits = normalizePhoneDigits(c.phone_digits || c.phone || '');
            push({
              id: c.id, kind: 'client', tcode: String(c.tcode || ''), name: String(c.name || ''),
              phone: String(c.phone || ''), phone_digits: digits, address: c.address || '', gps_lat: c.gps_lat, gps_lng: c.gps_lng,
              code_n: Number(map[digits] || null),
            });
          });
        }
      }
    }
  }
  if (qq.length >= 2) {
    const { data, error } = await supabase
      .from('transport_clients')
      .select('id, tcode, name, phone, phone_digits, address, gps_lat, gps_lng, updated_at')
      .ilike('name', `%${qq}%`)
      .order('updated_at', { ascending: false })
      .limit(12);
    if (!error) {
      (data || []).forEach((c) => {
        const digits = normalizePhoneDigits(c.phone_digits || c.phone || '');
        push({
          id: c.id, kind: 'client', tcode: String(c.tcode || ''), name: String(c.name || ''),
          phone: String(c.phone || ''), phone_digits: digits, address: c.address || '', gps_lat: c.gps_lat, gps_lng: c.gps_lng,
        });
      });
    }
  }
  try {
    let qOrders = supabase
      .from('transport_orders')
      .select('id, client_tcode, client_name, client_phone, data, created_at')
      .eq('transport_id', tid)
      .order('created_at', { ascending: false })
      .limit(20);
    if (isTCode && tDigits) qOrders = qOrders.ilike('client_tcode', `T${tDigits}%`);
    else if (qDigits.length >= 3) qOrders = qOrders.ilike('client_phone', `%${qDigits}%`);
    else if (qq.length >= 2) qOrders = qOrders.ilike('client_name', `%${qq}%`);
    const { data: ordersData, error: ordersErr } = await qOrders;
    if (!ordersErr) {
      (ordersData || []).forEach((row) => {
        const d = row?.data || {};
        const c = d?.client || {};
        const phone = String(row?.client_phone || c?.phone || '');
        push({
          id: row.id, kind: 'order', tcode: String(row?.client_tcode || c?.tcode || c?.code || ''),
          name: String(row?.client_name || c?.name || ''), phone, phone_digits: normalizePhoneDigits(phone),
          address: c?.address || '', gps_lat: c?.gps?.lat || '', gps_lng: c?.gps?.lng || '',
        });
      });
    }
  } catch {}
  return out.slice(0, 20);
}
 
async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true });
  if (error) return null;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}
function chipStyleForVal(v) {
  return { background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', fontWeight: '700' };
}

function getSafeTransportActorScope() {
  if (typeof window === 'undefined') return { role: 'UNKNOWN', pin: '', transport_id: '', name: '' };

  const safeParse = (raw) => {
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  };

  try {
    if (typeof getTransportContext === 'function') {
      const ctx = getTransportContext();
      if (ctx && (ctx.role || ctx.transport_id || ctx.transport_pin || ctx.pin)) {
        return {
          role: String(ctx.role || '').toUpperCase() || 'UNKNOWN',
          pin: String(ctx.pin || ctx.transport_pin || '').trim(),
          transport_id: String(ctx.transport_id || ctx.pin || ctx.transport_pin || '').trim(),
          name: String(ctx.name || ctx.transport_name || '').trim(),
        };
      }
    }
  } catch {}

  try {
    if (typeof getTransportSession === 'function') {
      const ts = getTransportSession();
      if (ts?.transport_id) {
        return {
          role: 'TRANSPORT',
          pin: String(ts.pin || ts.transport_pin || ts.transport_id || '').trim(),
          transport_id: String(ts.transport_id || '').trim(),
          name: String(ts.name || ts.transport_name || '').trim(),
        };
      }
    }
  } catch {}

  try {
    const rawTransport = localStorage.getItem('tepiha_transport_session_v1');
    const t = safeParse(rawTransport);
    if (t?.transport_id) {
      return {
        role: 'TRANSPORT',
        pin: String(t.pin || t.transport_pin || t.transport_id || '').trim(),
        transport_id: String(t.transport_id || '').trim(),
        name: String(t.name || t.transport_name || '').trim(),
      };
    }
  } catch {}

  try {
    const rawMain = localStorage.getItem('tepiha_session_v1');
    const m = safeParse(rawMain);
    const u = m?.user || m?.actor || m || null;
    const role = String(u?.role || '').trim().toUpperCase();
    const pin = String(u?.pin || '').trim();
    if (role || pin) {
      return {
        role: role || 'UNKNOWN',
        pin,
        transport_id: role === 'TRANSPORT' ? pin : (pin ? `ADMIN_${pin}` : ''),
        name: String(u?.name || '').trim(),
      };
    }
  } catch {}

  return { role: 'UNKNOWN', pin: '', transport_id: '', name: '' };
}

// Local Drafts Helpers
function safeJsonParse(s, f) { try { return JSON.parse(s); } catch { return f; } }
function loadDraftIds() { const raw = localStorage.getItem(DRAFT_LIST_KEY); return safeJsonParse(raw || '[]', []); }
function saveDraftIds(ids) { localStorage.setItem(DRAFT_LIST_KEY, JSON.stringify(ids)); }
function upsertDraftLocal(d) {
  if (!d?.id) return;
  const next = { ...d, transport_id: String(d?.transport_id || '').trim() || null };
  localStorage.setItem(`${DRAFT_ITEM_PREFIX}${d.id}`, JSON.stringify(next));
  const ids = loadDraftIds();
  if (!ids.includes(d.id)) { ids.unshift(d.id); saveDraftIds(ids); } 
}
function removeDraftLocal(id) {
  if (!id) return;
  localStorage.removeItem(`${DRAFT_ITEM_PREFIX}${id}`);
  saveDraftIds(loadDraftIds().filter((x) => x !== id));
}
function readAllDraftsLocal(scopeTid = '') {
  const wantedTid = String(scopeTid || '').trim();
  return loadDraftIds()
    .map(id => safeJsonParse(localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`), null))
    .filter(Boolean)
    .filter((d) => !wantedTid || String(d?.transport_id || '').trim() === wantedTid)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
function buildDraftPayload(d = {}, scopeTid = '') {
  return {
    ...d,
    id: d.id,
    ts: Date.now(),
    transport_id: String(scopeTid || d?.transport_id || '').trim() || null,
    addressDesc: d?.addressDesc ?? '',
    gpsLat: d?.gpsLat ?? '',
    gpsLng: d?.gpsLng ?? '',
    clientPhotoUrl: d?.clientPhotoUrl ?? '',
  };
}
// ---------------- COMPONENT ----------------
export default function PranimiPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = String(searchParams?.get('id') || '').trim();
  const isEdit = Boolean(editId);
  const newStatusRaw = String(searchParams?.get('new_status') || '').trim().toLowerCase();
  
  // ✅ FIX: Default status 'loaded' (Kamion) - Porosia e re shkon direkt në Kamion
  const createStatus = (newStatusRaw === 'pickup' || newStatusRaw === 'loaded') ? newStatusRaw : 'loaded';
  const [editRowStatus, setEditRowStatus] = useState('loaded');
  const [phonePrefix, setPhonePrefix] = useState('+383');
  const [showPrefixSheet, setShowPrefixSheet] = useState(false);
  const [me, setMe] = useState(null);
  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [savingContinue, setSavingContinue] = useState(false);
  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false);
  // Client Data
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');
  const [addressDesc, setAddressDesc] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientId, setClientId] = useState(null);
  const [clientCode, setClientCode] = useState(null);
  const [clientTcode, setClientTcode] = useState('');
  // Rows
  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');
  // Pay
  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [arkaRecordedPaid, setArkaRecordedPaid] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');
  const [notes, setNotes] = useState('');
  // Sheets
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showMsgSheet, setShowMsgSheet] = useState(false);
  const [showReceiptSheet, setShowReceiptSheet] = useState(false);
  const [receiptText, setReceiptText] = useState('');
  const [msgKind, setMsgKind] = useState('start'); // 'start' | 'receipt'
  const [autoMsgAfterSave, setAutoMsgAfterSave] = useState(true);
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);
  const [payAdd, setPayAdd] = useState(0);
  const [clientGive, setClientGive] = useState(0); // KLIENTI DHA
  const [offlineMode, setOfflineMode] = useState(false);
  const [netState, setNetState] = useState({ ok: true, reason: '' });
  const [currentStep, setCurrentStep] = useState(1);
  // ADMIN/DISPATCH can create transport orders without being a transport actor.
  // Prevent leaking orders to a driver just because a stale transport session exists.
  const [actor, setActor] = useState(null); // { role, pin }
  const [assignTid, setAssignTid] = useState(''); // transport_id to write into order.data.transport_id
  const [transportUsers, setTransportUsers] = useState([]); // [{pin,name}]
  // Detect actor/session changes (logout/login) without full page reload.
  // Safari/PWA can keep this page alive; without this, a new PIN can inherit the previous actor's code/oid.
  const actorSigRef = useRef('');
  const draftTimer = useRef(null);
  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);
  function getCurrentDraftTransportId() {
    return String((actor?.role === 'TRANSPORT' ? me?.transport_id : assignTid) || '').trim();
  }
  // --- INIT ---
  useEffect(() => {
    (async () => {
        const scope = getSafeTransportActorScope();
        const role = String(scope?.role || 'UNKNOWN').toUpperCase();
        const pin = String(scope?.pin || '').trim();
        const actorObj = { role, pin };
        setActor(actorObj);
        let transportScope = null;
        let adminTidLocal = null;
        if (role === 'TRANSPORT') {
          transportScope = scope?.transport_id ? scope : (getTransportSession() || null);
          if (!transportScope?.transport_id) { router.push('/transport/menu'); return; }
          setMe({ ...transportScope, role: 'TRANSPORT', pin });
          setAssignTid(String(transportScope.transport_id));
        } else {
          const adminTid = String(scope?.transport_id || (pin ? `ADMIN_${pin}` : 'ADMIN'));
          adminTidLocal = adminTid;
          setMe({ transport_id: null, role, pin });
          setAssignTid(adminTid);
          try {
            const { data } = await supabase
              .from('users')
              .select('name,pin,role')
              .eq('role', 'TRANSPORT')
              .order('name', { ascending: true })
              .limit(200);
            const rows = Array.isArray(data) ? data : [];
            setTransportUsers(
              rows
                .filter((r) => r?.pin)
                .map((r) => ({ pin: String(r.pin), name: String(r.name || r.pin) }))
            );
          } catch {}
        }
        
        try { setDrafts(readAllDraftsLocal(getCurrentDraftTransportId())); } catch {}
        if (isEdit) {
            const { data: row } = await supabase.from('transport_orders').select('*').eq('id', editId).single();
            if (row) {
                setOid(row.id); setCodeRaw(row.code_str); setEditRowStatus(row.status);
                const d = row.data || {};
                const c = d.client || {};
                setName(c.name || ''); 
                try { setPhone((c.phone||'').replace('+383','')); } catch{}
                setClientPhotoUrl(c.photoUrl||'');
                setAddressDesc(c.address||''); 
                if(c.gps){ setGpsLat(c.gps.lat); setGpsLng(c.gps.lng); }
                
                try { setTepihaRows((d.tepiha||[]).map((r,i)=>({...r, id:`t${i}`}))); } catch{}
                try { setStazaRows((d.staza||[]).map((r,i)=>({...r, id:`s${i}`}))); } catch{}
                
                setStairsQty(d.shkallore?.qty||0); 
                setStairsPer(d.shkallore?.per||SHKALLORE_M2_PER_STEP_DEFAULT); 
                setStairsPhotoUrl(d.shkallore?.photoUrl||'');
                
                setClientPaid(d.pay?.paid||0); 
                setPricePerM2(d.pay?.rate||PRICE_DEFAULT); 
                setArkaRecordedPaid(d.pay?.arkaRecordedPaid||0);
                setNotes(d.notes||'');
                if (searchParams?.get('focus') === 'pay') { setTimeout(() => setShowPaySheet(true), 200); }
            }
        } else {
            const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
              ? crypto.randomUUID()
              : `ord_${Date.now()}`;
            setOid(id);
            try {
              const tidForCode = (role === 'TRANSPORT')
                ? String(transportScope?.transport_id || scope?.transport_id || '')
                : String(adminTidLocal || scope?.transport_id || assignTid || '');
              const c = await getOrReserveTransportCode(tidForCode);
              setCodeRaw(c);
            } catch (e) {
              setCodeRaw('');
              try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
              alert('⚠️ S’MUND TË MERRET KODI (TRANSPORT). Do të ruhet si DRAFT/OFFLINE deri sa të kthehet lidhja.');
            }
        }
        setCreating(false);
    })();
  }, []);
  // --- SESSION WATCH (PIN SWITCH) ---
  useEffect(() => {
    // Polling is the most reliable option because localStorage changes in the same tab
    // do not fire the 'storage' event.
    let alive = true;
    const resetFor = async (role, pin, transport_id) => {
      // Reset all form state so the new actor never inherits the previous actor's order.
      setClientQuery('');
      setClientHits([]);
      setName('');
      setPhone('');
      setClientPhotoUrl('');
      setAddressDesc('');
      setGpsLat(null);
      setGpsLng(null);
      setTepihaRows([]);
      setStazaRows([]);
      setStairsQty(0);
      setStairsPer(SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl('');
      setNotes('');
      setClientPaid(0);
      setPayAdd(0);
      setClientGive(0);
      setArkaRecordedPaid(0);
      setShowPaySheet(false);
      setShowDraftsSheet(false);
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `ord_${Date.now()}`;
      setOid(id);
      // Reserve / reuse code for the new actor scope.
      try {
        const c = await getOrReserveTransportCode(String(transport_id || ''));
        setCodeRaw(c);
      } catch {
        setCodeRaw('');
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
      }
    };
    const tick = async () => {
      if (!alive) return;
      const scope = getSafeTransportActorScope();
      const role = String(scope?.role || 'UNKNOWN').toUpperCase();
      const pin = String(scope?.pin || '').trim();
      const tid = String(scope?.transport_id || (pin ? `ADMIN_${pin}` : 'ADMIN')).trim();
      const sig = `${role}|${pin}|${tid}`;
      if (!actorSigRef.current) {
        actorSigRef.current = sig;
        return;
      }
      if (sig !== actorSigRef.current) {
        actorSigRef.current = sig;
        // Update actor scope + reset order session.
        setActor({ role: role || 'UNKNOWN', pin });
        if (role === 'TRANSPORT') {
          if (!scope?.transport_id) { router.push('/transport/menu'); return; }
          setMe({ ...scope, role: 'TRANSPORT', pin });
          setAssignTid(String(scope.transport_id));
          await resetFor(role, pin, String(scope.transport_id));
        } else {
          setMe({ transport_id: null, role, pin });
          setAssignTid(tid);
          await resetFor(role, pin, tid);
        }
      }
    };
    const t = setInterval(() => { tick(); }, 1200);
    return () => { alive = false; clearInterval(t); };
  }, [router]);
  // Search Live (TEL / KOD / T-CODE / EMËR)
  useEffect(() => {
      const q = String(clientQuery || '').trim();
      const digits = normalizePhoneDigits(q);
      const isT = /^t\d+$/i.test(q) || (q.toLowerCase().startsWith('t') && normalizePhoneDigits(q.slice(1)).length > 0);
      // allow:
      // - phone (>=3 digits)
      // - client code (any digits)
      // - T-code (T + digits)
      // - name (>=2 chars)
      const should = (digits.length >= 1) || isT || (q.length >= 2);
      if (!should) { setClientHits([]); return; }
      setClientsLoading(true);
      // Search should follow the current assignment scope.
      // Transport drivers search within their own transport_id.
      // Admin/Dispatch search within the currently selected transport user OR admin namespace.
      const tid = (actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid;
      searchClientsLive(tid, q).then(r => { setClientHits(r); setClientsLoading(false); });
  }, [clientQuery, me?.transport_id, assignTid, actor?.role]);
  // Autosave Draft
  useEffect(() => {
      if(creating || !oid) return;
      clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
          const d = buildDraftPayload({
            id: oid,
            codeRaw,
            name,
            phone,
            tepihaRows,
            stazaRows,
            stairsQty,
            stairsPer,
            addressDesc,
            gpsLat,
            gpsLng,
            notes,
            clientPaid,
            pricePerM2
          }, getCurrentDraftTransportId());
          if(name || phone) { upsertDraftLocal(d); }
      }, 800);
  }, [creating, oid, name, phone, tepihaRows, stazaRows, stairsQty, stairsPer, addressDesc, gpsLat, gpsLng, notes, clientPaid, pricePerM2, actor?.role, me?.transport_id, assignTid]);
  const totalM2 = useMemo(() => {
    const tepihaM2 = (Array.isArray(tepihaRows) ? tepihaRows : []).reduce(
      (sum, row) => sum + (Number(row?.m2) || 0) * (Number(row?.qty) || 0),
      0
    );
    const stazaM2 = (Array.isArray(stazaRows) ? stazaRows : []).reduce(
      (sum, row) => sum + (Number(row?.m2) || 0) * (Number(row?.qty) || 0),
      0
    );
    const shkalloreM2 = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
    return Number((tepihaM2 + stazaM2 + shkalloreM2).toFixed(2));
  }, [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const totalEuro = useMemo(() => Number((totalM2 * pricePerM2).toFixed(2)), [totalM2, pricePerM2]);
  const copeCount =
    tepihaRows.reduce((a,b)=>a+(Number(b.qty)||0),0) +
    stazaRows.reduce((a,b)=>a+(Number(b.qty)||0),0) +
    (Number(stairsQty) || 0);
  const currentDebt = Math.max(0, totalEuro - clientPaid);
  const remainingDue = currentDebt;
  const payNow = Math.min(remainingDue, Math.max(0, Number(payAdd || 0)));
  const giveNow = Math.max(0, Number(clientGive || 0));
  const changeDue = Math.max(0, giveNow - payNow);
  // When opening the payment sheet: prefill "Klienti dha" with exact remaining due (BASE behavior)
  useEffect(() => {
      if(!showPaySheet) return;
      // only prefill if nothing is entered yet
      if(Number(clientGive || 0) > 0 || Number(payAdd || 0) > 0) return;
      setPayAdd(remainingDue);
      setClientGive(remainingDue);
  }, [showPaySheet, remainingDue]);
  function addRow(kind) {
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      const p = kind === 'tepiha' ? 't' : 's';
      setter(prev => [...prev, { id: `${p}${Date.now()}`, m2: '', qty: '0', photoUrl: '' }]);
  }
  function removeRow(kind) {
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      setter(prev => prev.slice(0, -1));
  }
  function handleRowChange(kind, id, f, v) {
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      setter(prev => prev.map(r => r.id === id ? { ...r, [f]: v } : r));
  }
  
  async function handleRowPhotoChange(kind, id, file) {
      if(!file || !oid) return;
      setPhotoUploading(true);
      const url = await uploadPhoto(file, oid, `${kind}_${id}`);
      if(url) handleRowChange(kind, id, 'photoUrl', url);
      setPhotoUploading(false);
  }
  async function handleStairsPhotoChange(file) {
      if(!file || !oid) return;
      setPhotoUploading(true);
      const url = await uploadPhoto(file, oid, 'shkallore');
      if(url) setStairsPhotoUrl(url);
      setPhotoUploading(false);
  }
  function applyChip(kind, val) {
      const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      const p = kind === 'tepiha' ? 't' : 's';
      if(!rows.length) setter([{ id: `${p}1`, m2: String(val), qty: '1', photoUrl: '' }]);
      else {
          const empty = rows.findIndex(r => !r.m2);
          if(empty !== -1) { const n=[...rows]; n[empty].m2=String(val); n[empty].qty=(n[empty].qty!=='0'?n[empty].qty:'1'); setter(n); }
          else setter([...rows, { id: `${p}${Date.now()}`, m2: String(val), qty: '1', photoUrl: '' }]);
      }
  }
  async function handleGetGPS() {
      navigator.geolocation.getCurrentPosition(p => { setGpsLat(p.coords.latitude); setGpsLng(p.coords.longitude); });
  }
  // ✅ FIX: MESAZHI I GATSHËM PËR SMS/VIBER
  function buildStartMessage() {
      const code = normalizeTcode(codeRaw);
      const pieces = Number(copeCount || 0);
      return [
        `Përshëndetje ${name || ''},`,
        `Porosia juaj u pranua me sukses.`,
        `KODI: ${code}`,
        `COPË: ${pieces}`,
        `TOTALI: ${Number(totalEuro || 0).toFixed(2)} €`,
        ``,
        `Kur porosia të jetë gati, do t'ju njoftojmë për konfirmim.`,
        `Pa konfirmimin tuaj, porosia nuk sillet.`,
        `Nëse nuk lajmëroheni brenda 3 ditëve, porosia dërgohet në depo (storage) dhe duhet ta merrni vetë,`,
        `ose do të aplikohet një tarifë ekstra për ta risjellë.`,
        ``,
        `Tel: ${COMPANY_PHONE_DISPLAY}`
      ].join('\n');
  }
  function buildReceiptMessage() {
      const paid = Number(clientPaid || 0);
      const debt = Math.max(0, Number(totalEuro || 0) - paid);
      return [
        `TEPIHA - RECITË`,
        `KODI: ${normalizeTcode(codeRaw)}`,
        `KLIENTI: ${name || ''}`,
        `TOTAL: ${Number(totalEuro || 0).toFixed(2)} €`,
        `PAGUAR: ${paid.toFixed(2)} €`,
        `BORXH: ${debt.toFixed(2)} €`,
        `Tel: ${COMPANY_PHONE_DISPLAY}`,
      ].join('\n');
  }
  function buildCurrentMessage() {
      return msgKind === 'receipt' ? buildReceiptMessage() : buildStartMessage();
  }
  // ✅ FIX: RUAJTJA -> KAMION -> MESAZH
  async function handleContinue() {
      if(!name) return alert("Shkruaj emrin!");
      // transport_id written to DB = assignment scope
      // - TRANSPORT user: own tid
      // - ADMIN/DISPATCH: selected driver tid OR ADMIN_<pin>
      const tid = (actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid;
      if(!tid) return alert("S'je i kyçur (PIN)!");
      setSavingContinue(true);
      // 1) Upsert transport client (transport-only client book)
      const phoneFull = sanitizePhone(phonePrefix + phone);
      const phoneDigits = normalizePhoneDigits(phoneFull);
      const clientCodeN = getOrAssignTransportClientCode(tid, phoneDigits);
      let tcodeForClient = String((clientTcode || normalizeTcode(codeRaw)) || '').toUpperCase().trim();
      // Nëse nuk kemi T-KOD (p.sh. lease/pool ra), provoj edhe 1 herë me e rezervu.
      if (!tcodeForClient || tcodeForClient === 'T0' || tcodeForClient === '0') {
        try {
          const fresh = await getOrReserveTransportCode(tid);
          if (fresh) {
            setCodeRaw(fresh);
            tcodeForClient = String(fresh).toUpperCase().trim();
          }
        } catch {}
      }
      if (!tcodeForClient || tcodeForClient === 'T0' || tcodeForClient === '0') {
        // S’ka kod => ruaje si draft dhe mos e humb klientin
        try { upsertDraftLocal(buildDraftPayload({ id: oid, codeRaw, name, phone, tepihaRows, stazaRows, stairsQty, stairsPer, addressDesc, gpsLat, gpsLng, clientPhotoUrl, notes, clientPaid, pricePerM2 }, getCurrentDraftTransportId())); } catch {}
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
        alert('⚠️ S’MORI T-KOD. U RUAJT SI DRAFT. Provo prap kur të ketë lidhje.');
        setSavingContinue(false);
        return;
      }
      let clientId = null;
      try {
        const r = await upsertTransportClient({
          name,
          phone: phoneFull,
          phone_digits: phoneDigits,
          tcode: tcodeForClient,
          address: addressDesc || '',
          gps_lat: gpsLat ?? null,
          gps_lng: gpsLng ?? null,
          notes: notes || ''
        });
        clientId = r?.id || r?.client_id || null;
      } catch (e) {
        // If RLS blocks writes to transport_clients, we still allow order save.
        console.warn('upsertTransportClient failed:', e?.message);
      }
      const order = {
          id: oid, ts: Date.now(),
          client: { id: clientId, tcode: tcodeForClient, code_n: clientCodeN, name, phone: phonePrefix+phone, code: tcodeForClient, photoUrl: clientPhotoUrl, address: addressDesc, gps: { lat: gpsLat || null, lng: gpsLng || null } },
          tepiha: tepihaRows, staza: stazaRows, shkallore: { qty: stairsQty, per: stairsPer, photoUrl: stairsPhotoUrl },
          pay: { m2: totalM2, euro: totalEuro, paid: clientPaid, rate: pricePerM2, arkaRecordedPaid },
          notes
      };
      
      // Visit number (how many times this client has had an order)
      let visitNr = 1;
      try {
        if (tcodeForClient) {
          const { data: vrows, error: verr } = await supabase
            .from('transport_orders')
            .select('visit_nr')
            .eq('client_tcode', tcodeForClient)
            .order('visit_nr', { ascending: false })
            .limit(1);
          if (!verr && Array.isArray(vrows) && vrows[0]) {
            const last = Number(vrows[0].visit_nr || 0);
            visitNr = (Number.isFinite(last) ? last : 0) + 1;
          }
        }
      } catch {}
      if (!Number.isFinite(visitNr) || visitNr < 1) visitNr = 1;
      const payload = {
          id: oid, 
          code_str: tcodeForClient, 
          client_tcode: tcodeForClient,
          visit_nr: visitNr,
          client_id: clientId,
          client_name: name, 
          client_phone: phoneFull,
          // ⚠️ transport_id është GENERATED ALWAYS (data->>'transport_id').
          // Pra NUK guxojmë me e fut në INSERT/UPDATE (kthen error "cannot insert a non-DEFAULT value...").
          // Board e lexon transport_id nga kolona e gjeneruar, sepse ne e ruajmë gjithmonë te data.transport_id.
          status: isEdit ? editRowStatus : 'loaded', // ✅ FORCE KAMION (LOADED)
          data: { ...order, transport_id: tid, created_by_pin: actor?.pin || null, created_by_role: actor?.role || null, gps_lat: gpsLat || null, gps_lng: gpsLng || null }
      };
      // In edit mode, keep original client_tcode/visit_nr (don't overwrite)
      if (isEdit) {
        delete payload.client_tcode;
        delete payload.visit_nr;
      }
      try {
        // ✅ Robust Outbox: persist PENDING first, then attempt immediate sync.
        // DB triggers will auto-mark pool codes as USED only when INSERT/UPSERT succeeds.
        try { enqueueTransportOrder(payload); } catch {}
        try { await syncNow(); } catch {}
        
        removeDraftLocal(oid);
        setSavingContinue(false);
        
        if(autoMsgAfterSave) { setMsgKind('start'); setShowMsgSheet(true); } // ✅ HAP MESAZHIN
        else router.push('/transport/board');
      } catch (e) {
          // Nëse DB bie/RLS/rrjeti, mos e humb porosinë — ruaje si DRAFT.
          try {
            upsertDraftLocal(buildDraftPayload({
              id: oid,
              codeRaw,
              name,
              phone,
              tepihaRows,
              stazaRows,
              stairsQty,
              stairsPer,
              addressDesc,
              gpsLat,
              gpsLng,
              clientPhotoUrl,
              clientPaid,
              pricePerM2,
              notes,
            }, getCurrentDraftTransportId()));
          } catch {}
          try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
          alert("⚠️ RUJTJA NË SERVER DËSHTOI. U RUAJT SI DRAFT/OFFLINE.\n" + (e?.message || ''));
          setSavingContinue(false);
      }
  }
  async function applyPayAndClose() {
      // "KLIENTI DHA" (clientGive) -> system computes "SOT PAGUAN" (payNow) and "KTHIM" (changeDue)
      const paid = Number(payNow || 0);
      const gave = Number(giveNow || 0);
      const change = Number(changeDue || 0);
      // Nothing to save
      if (!(paid > 0) && !(gave > 0)) {
          setShowPaySheet(false);
          return;
      }
      // OPTIMISTIC UI: përditëso menjëherë totals
      if (paid > 0) {
          const newVal = Number((clientPaid + paid).toFixed(2));
          setClientPaid(newVal);
          if (payMethod === 'CASH') {
              const newArka = Number((arkaRecordedPaid + paid).toFixed(2));
              setArkaRecordedPaid(newArka);
          }
      }
      // Receipt text (simple)
      const debtAfter = Math.max(0, Number((totalEuro - (clientPaid + paid)).toFixed(2)));
      const receipt = [
          `TEPIHA - RECITË`,
          `KODI: ${normalizeTcode(codeRaw)}`,
          `KLIENTI: ${name}`,
          `TOTAL: ${Number(totalEuro).toFixed(2)}€`,
          `BORXH PARA: ${Number(remainingDue).toFixed(2)}€`,
          `KLIENTI DHA: ${Number(gave).toFixed(2)}€`,
          `SOT PAGUAN: ${Number(paid).toFixed(2)}€`,
          `KTHIM: ${Number(change).toFixed(2)}€`,
          `BORXH PAS: ${Number(debtAfter).toFixed(2)}€`,
          `DATA: ${new Date().toLocaleString()}`,
      ].join('\n');
      setReceiptText(receipt);
      setShowReceiptSheet(true);
      // Close payment sheet immediately
      setShowPaySheet(false);
      setPayAdd(0);
      setClientGive(0);
      // Background network work (mos blloko UI)
      void (async () => {
        try {
          if (paid > 0 && payMethod === 'CASH') {
              const actorPin = String(actor?.pin || me?.transport_pin || me?.pin || '').trim();
              const actorTid = String(me?.transport_id || assignTid || '').trim();
              try {
                if (actorTid) {
                  addTransportCollected(actorTid, {
                    id: `cash_${Date.now()}`,
                    amount: paid,
                    order_code: normalizeTcode(codeRaw),
                    client_name: name,
                    note: `PAGESA ${paid}€ - ${name}`,
                    created_at: new Date().toISOString(),
                    created_by_pin: actorPin || null,
                  });
                }
              } catch {}
              await recordCashMove({
                  amount: paid,
                  note: `PAGESA ${paid}€ - ${name}`,
                  type: 'TRANSPORT',
                  status: 'COLLECTED',
                  order_code: normalizeTcode(codeRaw),
                  source: 'ORDER_PAY',
                  created_by_pin: actorPin || null
              });
          }
        } catch(e) {}
      })();
  }
  // --- DRAFTS ---
  function openDrafts() { setDrafts(readAllDraftsLocal(getCurrentDraftTransportId())); setShowDraftsSheet(true); }
  function loadDraft(d) {
      setOid(d.id); setCodeRaw(d.codeRaw); setName(d.name || ''); setPhone(d.phone || ''); 
      setTepihaRows(d.tepihaRows||[]); setStazaRows(d.stazaRows||[]); setClientPaid(d.clientPaid||0);
      setStairsQty(d.stairsQty || 0); setStairsPer(d.stairsPer || SHKALLORE_M2_PER_STEP_DEFAULT);
      setAddressDesc(d.addressDesc || ''); setGpsLat(d.gpsLat || ''); setGpsLng(d.gpsLng || '');
      setClientPhotoUrl(d.clientPhotoUrl || '');
      setNotes(d.notes || '');
      setCurrentStep(1);
      setShowDraftsSheet(false);
  }
  function deleteDraft(id) { removeDraftLocal(id); setDrafts(readAllDraftsLocal(getCurrentDraftTransportId())); }
  // --- LONG PRESS PRICE ---
  function startPayHold() { payHoldTriggeredRef.current = false; if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = setTimeout(() => { payHoldTriggeredRef.current = true; openPriceEditor(); }, 1200); }
  function endPayHold() { if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); if (!payHoldTriggeredRef.current) setShowPaySheet(true); payHoldTriggeredRef.current = false; }
  function cancelPayHold() { if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTriggeredRef.current = false; }
  function openPriceEditor() { setPriceTmp(pricePerM2); setShowPriceSheet(true); }
  async function savePriceAndClose() {
      const v = Number(priceTmp);
      if(v>0) setPricePerM2(v);
      setShowPriceSheet(false);
  }
  if (creating) return <div className="wrap"><p style={{textAlign:'center', paddingTop:30}}>Duke u hapur...</p></div>;
  const totalSteps = 5;
  const stepPct = (currentStep / totalSteps) * 100;
  return (
    <div className="wrap">
        <header className="header-row">
            <div><h1 className="title">PRANIMI</h1><div className="subtitle">KRIJO POROSI</div></div>
            <div className="code-badge"><span className="badge">KODI: {normalizeTcode(codeRaw)}</span></div>
        </header>
        {/* ADMIN/DISPATCH: choose which transport driver this order belongs to (or keep ADMIN-only) */}
        {actor?.role !== 'TRANSPORT' && (
          <section style={{marginTop: 10}}>
            <div className="card" style={{padding:'12px 14px', borderRadius:18}}>
              <div style={{fontSize:12, opacity:.75, marginBottom:8}}>KUJT ME IA QIT?</div>
              <select
                value={assignTid}
                onChange={async (e) => {
                  const v = String(e.target.value || '').trim();
                  setAssignTid(v);
                  // When changing assignment, reserve code in the new pool (only for new orders).
                  if (!isEdit) {
                    try {
                      const c = await getOrReserveTransportCode(v);
                      setCodeRaw(c);
                    } catch {}
                  }
                }}
                style={{width:'100%', padding:'10px 12px', borderRadius:12, background:'#0f172a', color:'#fff', border:'1px solid rgba(255,255,255,0.12)'}}
              >
                <option value={assignTid}>{assignTid.startsWith('ADMIN_') || assignTid==='ADMIN' ? 'VETEM ADMIN' : assignTid}</option>
                {/* Ensure ADMIN option always exists */}
                {actor?.pin && (
                  <option value={`ADMIN_${actor.pin}`}>VETEM ADMIN</option>
                )}
                {transportUsers.map(u => (
                  <option key={u.pin} value={u.pin}>{u.name} ({u.pin})</option>
                ))}
              </select>
              <div style={{fontSize:12, opacity:.7, marginTop:8}}>
                • TRANSPORTUSI sheh vetem porositë me transport_id të tij. • ADMIN sheh vetem ADMIN_{actor?.pin || ''}.
              </div>
            </div>
          </section>
        )}
        {/* --- DRAFTS BUTTON --- */}
        <section style={{marginTop: 10}}>
            <button className="btn secondary" style={{width:'100%', padding:'12px 14px', borderRadius:18}} onClick={openDrafts}>
                📝 TË PA PLOTSUARAT {drafts.length>0 ? `(${drafts.length})` : ''}
            </button>
        </section>
        <section className="card" style={{marginTop:16, padding:'14px 14px 12px'}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', gap:12, marginBottom:10}}>
            <div>
              <div className="card-title" style={{marginBottom:4}}>WIZARD I PRANIMIT</div>
              <div style={{fontSize:12, opacity:.75}}>HAPI {currentStep} / {totalSteps}</div>
            </div>
            <div style={{fontSize:12, opacity:.75, fontWeight:800}}>{Math.round(stepPct)}%</div>
          </div>
          <div style={{height:10, borderRadius:999, background:'rgba(255,255,255,0.08)', overflow:'hidden'}}>
            <div style={{height:'100%', width:`${stepPct}%`, borderRadius:999, background:'linear-gradient(90deg, #0ea5e9, #22c55e)', transition:'width .25s ease'}} />
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:8, marginTop:12}}>
            {[
              '1. KLIENTI',
              '2. ADRESA',
              '3. TEPIHA',
              '4. STAZA',
              '5. SHKALLORE & TOTALI'
            ].map((label, idx) => {
              const step = idx + 1;
              const active = currentStep === step;
              const done = currentStep > step;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => setCurrentStep(step)}
                  style={{
                    minHeight: 42,
                    borderRadius: 12,
                    border: active ? '1px solid rgba(14,165,233,.9)' : '1px solid rgba(255,255,255,0.12)',
                    background: done ? 'rgba(34,197,94,.14)' : (active ? 'rgba(14,165,233,.14)' : 'rgba(255,255,255,.04)'),
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 800,
                    padding: '8px 6px'
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </section>
        {currentStep === 1 && (
          <>
            {/* --- KLIENTI (SMART CARD STYLE) --- */}
            <section className="card" style={{padding: 0, overflow: 'hidden', background: '#111', border: '1px solid rgba(255,255,255,0.1)', marginTop: 16}}>
                <div style={{background: '#1C1C1E', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)'}}>
                    <div style={{display:'flex', alignItems:'center', gap: 10, background: 'rgba(255,255,255,0.08)', borderRadius: 10, padding: '8px 12px'}}>
                        <span style={{fontSize: 16, opacity: 0.5}}>🔍</span>
                        <input style={{background:'transparent', border:'none', color:'#fff', fontSize:15, width:'100%', outline:'none'}} placeholder="KËRKO: TEL • KOD • Txx • EMËR" value={clientQuery} onChange={e => setClientQuery(e.target.value)} />
                    </div>
                    {clientHits.length > 0 && (
                        <div style={{marginTop: 8}}>
                            {clientHits.map((c, i) => (
                                <div
                                  key={c.id || i}
                                  style={{padding: '10px 0', borderBottom: '1px solid #333', fontSize: 14, color: '#DDD'}}
                                  onClick={() => {
                                    setName(c.name);
                                    const digits = normalizePhoneDigits(c.phone_digits || c.phone);
                                    if (digits) {
                                      if (String(c.phone || '').startsWith('+')) {
                                        setPhonePrefix(String(c.phone).slice(0, 4));
                                        setPhone(digits.replace(/^383/, ''));
                                      } else {
                                        setPhone(digits);
                                      }
                                    }
                                    setClientId(c.id || null);
                                    const tc = String(c.tcode || '').trim();
                                    if (tc) { setClientTcode(tc); setCodeRaw(tc); }
                                    setClientCode(getOrAssignTransportClientCode((actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid, digits));
                                    if (c.address) setAddressDesc(c.address);
                                    if (c.gps_lat) setGpsLat(c.gps_lat);
                                    if (c.gps_lng) setGpsLng(c.gps_lng);
                                    setClientQuery('');
                                  }}
                                >
                                    <b style={{color:'#fff'}}>
                                      {(String(c.tcode || '').trim()
                                        ? `${String(c.tcode).toUpperCase()} `
                                        : (c.code_n
                                          ? `#${c.code_n} `
                                          : (getOrAssignTransportClientCode((actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid, normalizePhoneDigits(c.phone_digits || c.phone))
                                            ? `#${getOrAssignTransportClientCode((actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid, normalizePhoneDigits(c.phone_digits || c.phone))} `
                                            : '')))}
                                    </b>
                                    {c.name} • {c.phone}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                <div style={{display: 'grid', gridTemplateColumns: '70px 1fr', padding: 16, gap: 16, alignItems: 'center'}}>
                    <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap: 4}}>
                        <label style={{width: 60, height: 60, borderRadius: '50%', background: '#2C2C2E', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', border: '1px solid #333', cursor: 'pointer'}}>
                            {clientPhotoUrl ? <img src={clientPhotoUrl} style={{width:'100%', height:'100%', objectFit:'cover'}} /> : <span style={{fontSize:24}}>📷</span>}
                            <input type="file" hidden accept="image/*" onChange={e => uploadPhoto(e.target.files[0], oid, 'client').then(u => u && setClientPhotoUrl(u))} />
                        </label>
                        <span style={{fontSize: 9, color: '#666', fontWeight: '700'}}>FOTO</span>
                    </div>
                    <div style={{display:'flex', flexDirection:'column', gap: 8}}>
                        <input style={{background:'transparent', border:'none', color:'#fff', fontSize: 20, fontWeight:'700', width:'100%', outline:'none', padding: 0}} placeholder="EMRI MBIEMRI" value={name} onChange={e => setName(e.target.value)} />
                        <div style={{display:'flex', alignItems:'center', gap: 8}}>
                            <button onClick={()=>setShowPrefixSheet(true)} style={{background: '#2C2C2E', border: 'none', borderRadius: 6, padding: '4px 8px', color: '#007AFF', fontWeight: '600', fontSize: 14}}>{phonePrefix}</button>
                            <input style={{background:'transparent', border:'none', color:'#CCC', fontSize: 16, width:'100%', outline:'none', padding: 0}} placeholder="44xxxxxx" type="tel" value={phone} onChange={e => setPhone(e.target.value)} />
                        </div>
                    </div>
                </div>
            </section>
            <footer className="footer-bar">
              <button className="btn secondary" onClick={() => router.push('/transport/menu')}>↩ MENU</button>
              <button className="btn primary" onClick={() => setCurrentStep(2)} disabled={!String(name || '').trim()}>
                NEXT ▶
              </button>
            </footer>
          </>
        )}
        {currentStep === 2 && (
          <>
            <section className="card" style={{marginTop:16}}>
              <h2 className="card-title">ADRESA</h2>
              <div style={{display:'grid', gap:12}}>
                <textarea
                  className="input"
                  rows={5}
                  placeholder="PËRSHKRUAJ ADRESËN, LAGJEN, KATIN, HYRJEN, OBORRIN..."
                  value={addressDesc}
                  onChange={e => setAddressDesc(e.target.value)}
                />
                <button
                  type="button"
                  onClick={handleGetGPS}
                  style={{
                    minHeight: 62,
                    borderRadius: 16,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: gpsLat ? 'rgba(34,197,94,.18)' : 'rgba(255,255,255,.05)',
                    color:'#fff',
                    fontWeight:900,
                    fontSize:18
                  }}
                >
                  📍 {gpsLat ? 'GPS U MOR' : 'MERRE GPS'}
                </button>
                {(gpsLat || gpsLng) && (
                  <div style={{fontSize:12, opacity:.8}}>
                    GPS: {String(gpsLat || '')} {gpsLng ? `• ${String(gpsLng)}` : ''}
                  </div>
                )}
              </div>
            </section>
            <footer className="footer-bar">
              <button className="btn secondary" onClick={() => setCurrentStep(1)}>◀ BACK</button>
              <button className="btn primary" onClick={() => setCurrentStep(3)}>NEXT ▶</button>
            </footer>
          </>
        )}
        {currentStep === 3 && (
          <>
            {/* TEPIHA */}
            <section className="card" style={{marginTop:16}}>
              <h2 className="card-title">TEPIHA</h2>
              <div className="chip-row modern">
                {TEPIHA_CHIPS.map((v) => (
                  <button key={v} type="button" className="chip chip-modern" onClick={() => applyChip('tepiha', v)} style={chipStyleForVal(v)}>
                    {v.toFixed(1)}
                  </button>
                ))}
              </div>
              {tepihaRows.map((row) => (
                <div className="piece-row" key={row.id}>
                  <div className="row">
                    <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" />
                    <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="copë" />
                    <label className="camera-btn">
                        {row.photoUrl ? <img src={row.photoUrl} style={{width:'100%', height:'100%', borderRadius:12, objectFit:'cover'}} /> : '📷'}
                        <input type="file" hidden accept="image/*" onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} />
                    </label>
                  </div>
                </div>
              ))}
              <div className="row btn-row">
                <button className="btn secondary" onClick={() => addRow('tepiha')}>+ RRESHT</button>
                <button className="btn secondary" onClick={() => removeRow('tepiha')}>− RRESHT</button>
              </div>
            </section>
            <footer className="footer-bar">
              <button className="btn secondary" onClick={() => setCurrentStep(2)}>◀ BACK</button>
              <button className="btn primary" onClick={() => setCurrentStep(4)}>NEXT ▶</button>
            </footer>
          </>
        )}
        {currentStep === 4 && (
          <>
            {/* STAZA */}
            <section className="card" style={{marginTop:16}}>
              <h2 className="card-title">STAZA</h2>
              <div className="chip-row modern">
                {STAZA_CHIPS.map((v) => (
                  <button key={v} type="button" className="chip chip-modern" onClick={() => applyChip('staza', v)} style={chipStyleForVal(v)}>
                    {v.toFixed(1)}
                  </button>
                ))}
              </div>
              {stazaRows.map((row) => (
                <div className="piece-row" key={row.id}>
                  <div className="row">
                    <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" />
                    <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="copë" />
                    <label className="camera-btn">
                        {row.photoUrl ? <img src={row.photoUrl} style={{width:'100%', height:'100%', borderRadius:12, objectFit:'cover'}} /> : '📷'}
                        <input type="file" hidden accept="image/*" onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} />
                    </label>
                  </div>
                </div>
              ))}
              <div className="row btn-row">
                <button className="btn secondary" onClick={() => addRow('staza')}>+ RRESHT</button>
                <button className="btn secondary" onClick={() => removeRow('staza')}>− RRESHT</button>
              </div>
            </section>
            <footer className="footer-bar">
              <button className="btn secondary" onClick={() => setCurrentStep(3)}>◀ BACK</button>
              <button className="btn primary" onClick={() => setCurrentStep(5)}>NEXT ▶</button>
            </footer>
          </>
        )}
        {currentStep === 5 && (
          <>
            {/* UTIL */}
            <section className="card" style={{marginTop:16}}>
              <div className="row util-row" style={{ gap: 10 }}>
                <button className="btn secondary" style={{ flex: 1, minHeight: 54, fontSize: 16, fontWeight: 900 }} onClick={() => setShowStairsSheet(true)}>
                  🪜 SHKALLORE
                </button>
                <button className="btn secondary" style={{ flex: 1, minHeight: 54, fontSize: 16, fontWeight: 900 }} 
                  onMouseDown={startPayHold} onMouseUp={endPayHold} onMouseLeave={cancelPayHold}
                  onTouchStart={startPayHold} onTouchEnd={endPayHold}
                >
                  € PAGESA
                </button>
              </div>
              <div style={{ marginTop: 10 }}>
                <button className="btn secondary" style={{ width: '100%' }} onClick={() => {
                  const focusPay = String(searchParams?.get('focus') || '').toLowerCase() === 'pay';
                  setMsgKind((focusPay || showPaySheet) ? 'receipt' : 'start');
                  setShowMsgSheet(true);
                }}>
                  📩 DËRGO MESAZH
                </button>
              </div>
              <div className="tot-line">M² Total: <strong>{totalM2.toFixed(2)}</strong></div>
              <div className="tot-line">Copë: <strong>{copeCount}</strong></div>
              <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
              <div className="tot-line" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 10, paddingTop: 10 }}>
                Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong>
              </div>
              <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
                Regjistru n&apos;ARKË: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong>
              </div>
              {currentDebt > 0 && <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>}
            </section>
            {/* NOTES */}
            <section className="card">
              <h2 className="card-title">SHËNIME</h2>
              <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </section>
            <footer className="footer-bar">
              <button className="btn secondary" onClick={() => setCurrentStep(4)}>◀ BACK</button>
              <button className="btn primary" onClick={handleContinue} disabled={photoUploading || savingContinue}>
                {savingContinue ? '⏳ DUKE RUJT...' : (isEdit ? '💾 RUAJ' : '💾 RUAJ / VAZHDO')}
              </button>
            </footer>
          </>
        )}
      {/* PAY SHEET */}
      {showPaySheet && (
        <PosModal
          open={showPaySheet}
          onClose={() => setShowPaySheet(false)}
          title="PAGESA (ARKË)"
          subtitle={`KODI: ${normalizeTcode(codeRaw)} • ${name}`}
          total={totalEuro}
          alreadyPaid={Number(clientPaid || 0)}
          amount={giveNow}
          setAmount={(v) => {
            const n = Number(v || 0);
            setClientGive(n);
          }}
          payChips={PAY_CHIPS}
          confirmText="KRYEJ PAGESËN"
          cancelText="ANULO"
          disabled={savingContinue}
          onConfirm={applyPayAndClose}
          footerNote={`SOT PAGUAN: ${Number(payNow || 0).toFixed(2)}€ • KTHIM: ${Number(changeDue || 0).toFixed(2)}€`}
        />
      )}
      {/* SHKALLORE SHEET */}
      {showStairsSheet && (
        <div className="modal-overlay" onClick={() => setShowStairsSheet(false)}>
          <div className="modal-content dark" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="card-title" style={{ margin: 0, color: '#fff' }}>SHKALLORE</h3>
              <button className="btn secondary" onClick={() => setShowStairsSheet(false)}>✕</button>
            </div>
            <div className="field-group" style={{ marginTop: 12 }}>
              <label className="label">COPË</label>
              <div className="chip-row">
                {SHKALLORE_QTY_CHIPS.map((n) => <button key={n} className="chip" onClick={() => setStairsQty(n)}>{n}</button>)}
              </div>
              <input type="number" className="input" value={stairsQty||''} onChange={(e) => setStairsQty(e.target.value)} placeholder="" />
            </div>
            <div className="field-group">
              <label className="label">m² PËR COPË</label>
              <div className="chip-row">
                {SHKALLORE_PER_CHIPS.map((v) => <button key={v} className="chip" onClick={() => setStairsPer(v)}>{v}</button>)}
              </div>
              <input type="number" step="0.01" className="input" value={stairsPer||''} onChange={(e) => setStairsPer(e.target.value)} />
            </div>
            <div className="field-group">
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                  <label className="label">FOTO</label>
                  <label className="camera-btn">
                      {stairsPhotoUrl ? <img src={stairsPhotoUrl} style={{width:'100%', height:'100%', borderRadius:12, objectFit:'cover'}} /> : '📷'}
                      <input type="file" hidden accept="image/*" onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} />
                  </label>
              </div>
            </div>
            <button className="btn primary" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowStairsSheet(false)}>MBYLL</button>
          </div>
        </div>
      )}
      {/* DRAFTS SHEET */}
      {showDraftsSheet && (
        <div className="draftsOverlay" onClick={() => setShowDraftsSheet(false)}>
          <div className="draftsModal" onClick={(e) => e.stopPropagation()}>
            <div className="draftsTop">
              <div>
                <div className="draftsTitle">TË PA PLOTSUARAT</div>
                <div className="draftsSub">Zgjidh një draft për të vazhduar ose fshije nëse nuk të duhet më.</div>
              </div>
              <button className="btn secondary" onClick={() => setShowDraftsSheet(false)}>✕</button>
            </div>
            <div className="draftsBody">
              {drafts.length === 0 ? (
                <div className="draftsEmpty">S'ka porosi të pambarura.</div>
              ) : (
                drafts.map((d) => (
                  <div key={d.id} className="draftCardWrap">
                    <button type="button" className="draftCard" onClick={() => loadDraft(d)}>
                      <div className="draftCode">{d.codeRaw || 'PA KOD'}</div>
                      <div className="draftName">{d.name || 'Pa emër klienti'}</div>
                    </button>
                    <button
                      type="button"
                      className="draftDelete"
                      onClick={() => deleteDraft(d.id)}
                      aria-label="Fshi draftin"
                      title="Fshi draftin"
                    >
                      🗑
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* PREFIX SHEET */}
      {showPrefixSheet && (
        <div className="modalCenterOverlay" onClick={() => setShowPrefixSheet(false)}>
            <div className="modalCenter" onClick={e => e.stopPropagation()}>
                {PREFIX_OPTIONS.map(o => (
                    <div key={o.code} className="prefixOpt" onClick={() => {setPhonePrefix(o.code); setShowPrefixSheet(false);}}>
                        <span className="poFlag">{o.flag}</span><span className="poCode">{o.code}</span>
                    </div>
                ))}
            </div>
        </div>
      )}
      {/* PRICE SHEET */}
      {showPriceSheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div className="payfs-title">NDËRRO QMIMIN</div>
            <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>✕</button>
          </div>
          <div className="payfs-body">
            <input type="number" className="input" value={priceTmp} onChange={e=>setPriceTmp(e.target.value)} />
            <button className="btn primary" style={{marginTop:20, width:'100%'}} onClick={savePriceAndClose}>RUJ</button>
          </div>
        </div>
      )}
      {/* MESSAGE SHEET */}
      {showReceiptSheet && (
        <div className="msgOverlay" onClick={() => { setShowReceiptSheet(false); router.push('/transport/board'); }}>
          <div className="msgModal" onClick={(e) => e.stopPropagation()}>
            <div className="msgModalTop">
              <div>
                <div className="msgModalTitle">RECITË E PAGESËS</div>
                <div className="msgModalSub">Shpërndaje recitën nga këtu ose mbylle për t'u kthyer te lista.</div>
              </div>
              <button className="btn secondary" onClick={() => { setShowReceiptSheet(false); router.push('/transport/board'); }}>MBYLL</button>
            </div>
            <div className="msgPreview">
              <pre style={{color:'#E5E7EB', fontSize:14, whiteSpace:'pre-wrap', lineHeight:1.55, margin:0}}>{receiptText}</pre>
            </div>
            <div className="msgActions">
              <button className="btn secondary" onClick={() => {
                try { navigator.clipboard?.writeText(receiptText); } catch(e){}
              }}>KOPJO</button>
              <button className="btn secondary" onClick={() => {
                const ph = sanitizePhone(phonePrefix + phone);
                window.open(`https://wa.me/${ph}?text=${encodeURIComponent(receiptText)}`, '_blank');
              }}>WHATSAPP</button>
              <button className="btn secondary" onClick={() => {
                const ph = sanitizePhone(phonePrefix + phone);
                window.open(`viber://chat?number=%2B${ph}`, '_blank');
              }}>VIBER</button>
              <button className="btn primary" onClick={() => {
                const ph = sanitizePhone(phonePrefix + phone);
                window.open(`sms:${ph}?&body=${encodeURIComponent(receiptText)}`, '_blank');
              }}>SMS</button>
            </div>
          </div>
        </div>
      )}
      {/* MESSAGE MODAL FULL SCREEN */}
      {showMsgSheet && (
        <div className="msgOverlay" onClick={() => router.push('/transport/board')}>
          <div className="msgModal" onClick={(e) => e.stopPropagation()}>
            <div className="msgModalTop">
              <div>
                <div className="msgModalTitle">MESAZHI PËR KLIENTIN</div>
                <div className="msgModalSub">Dërgoje nga këtu para se ta mbyllësh porosinë.</div>
              </div>
              <button className="btn secondary" onClick={() => router.push('/transport/board')}>MBYLL</button>
            </div>
            <div className="msgPreview">
              <pre style={{color:'#E5E7EB', fontSize:14, whiteSpace:'pre-wrap', lineHeight:1.55, margin:0}}>{buildCurrentMessage()}</pre>
            </div>
            <div className="msgActions">
              <button className="btn secondary" onClick={() => {
                const txt = buildCurrentMessage();
                try { navigator.clipboard?.writeText(txt); } catch {}
              }}>KOPJO</button>
              <button className="btn secondary" onClick={() => {
                const txt = buildCurrentMessage();
                const ph = sanitizePhone(phonePrefix + phone);
                window.open(`https://wa.me/${ph}?text=${encodeURIComponent(txt)}`, '_blank');
              }}>WHATSAPP</button>
              <button className="btn secondary" onClick={() => {
                const txt = buildCurrentMessage();
                const ph = sanitizePhone(phonePrefix + phone);
                window.open(`viber://chat?number=%2B${ph}`, '_blank');
              }}>VIBER</button>
              <button className="btn primary" onClick={() => {
                const txt = buildCurrentMessage();
                const ph = sanitizePhone(phonePrefix + phone);
                window.open(`sms:${ph}?&body=${encodeURIComponent(txt)}`, '_blank');
              }}>SMS</button>
            </div>
          </div>
        </div>
      )}
      <style jsx>{`
        .wrap { padding: 10px 10px 80px; max-width: 600px; margin: 0 auto; color: white; }
        .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .title { font-size: 24px; font-weight: 900; margin: 0; }
        .subtitle { font-size: 12px; opacity: 0.7; font-weight: 700; letter-spacing: 1px; }
        .code-badge { background: #222; padding: 6px 12px; borderRadius: 12px; font-weight: 800; }
        .card { background: #111; border-radius: 18px; padding: 16px; margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); }
        .card-title { font-size: 14px; font-weight: 900; margin-bottom: 12px; color: rgba(255,255,255,0.6); }
        .field-group { margin-bottom: 14px; }
        .label { font-size: 12px; font-weight: 800; margin-bottom: 6px; display: block; opacity: 0.8; }
        .input { width: 100%; background: #222; border: 1px solid #333; color: white; padding: 12px; border-radius: 12px; font-size: 16px; font-weight: 600; }
        .row { display: flex; gap: 10px; }
        .btn { border: none; padding: 14px; border-radius: 14px; font-weight: 900; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .primary { background: white; color: black; }
        .secondary { background: #222; color: white; }
        .footer-bar { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.9); padding: 16px; display: flex; gap: 10px; border-top: 1px solid #222; backdrop-filter: blur(10px); }
        .chip-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
        .chip { padding: 10px 14px; border-radius: 12px; background: #222; color: white; font-weight: 700; border: 1px solid #333; }
        .piece-row { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #222; }
        .tot-line { font-size: 14px; display: flex; justify-content: space-between; margin-bottom: 6px; }
        .camera-btn { width: 44px; height: 44px; background: #222; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 20px; cursor: pointer; border: 1px solid #333; }
        .modalCenterOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 10000; display: flex; align-items: center; justify-content: center; }
        .modalCenter { width: 300px; background: #111; padding: 20px; border-radius: 20px; border: 1px solid #333; }
        .prefixOpt { padding: 12px; border-bottom: 1px solid #222; display: flex; justify-content: space-between; font-weight: 700; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999; display: flex; alignItems: center; justifyContent: center; padding: 20px; }
        .modal-content { width: 100%; max-width: 420px; padding: 18px; border-radius: 18px; background: white; }
        .draftsOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.82); z-index: 11050; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .draftsModal { width: min(860px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: linear-gradient(180deg, #0b1220, #111827); border: 1px solid rgba(255,255,255,0.12); border-radius: 22px; box-shadow: 0 24px 80px rgba(0,0,0,0.45); padding: 18px; }
        .draftsTop { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:14px; }
        .draftsTitle { font-size: 18px; font-weight: 900; letter-spacing: .4px; }
        .draftsSub { font-size: 12px; opacity: .72; margin-top: 4px; }
        .draftsBody { display:flex; flex-direction:column; gap:12px; }
        .draftsEmpty { text-align:center; padding:28px 16px; color:#94a3b8; background: rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:18px; }
        .draftCardWrap { display:flex; gap:10px; align-items:stretch; }
        .draftCard { flex:1; text-align:left; padding:16px; border-radius:18px; background: rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.10); color:#fff; cursor:pointer; }
        .draftCode { color:#22c55e; font-weight:900; font-size:18px; line-height:1.15; }
        .draftName { margin-top:8px; font-size:15px; font-weight:700; color:#e5e7eb; }
        .draftDelete { width:52px; min-width:52px; border-radius:16px; border:1px solid rgba(255,255,255,0.10); background: rgba(239,68,68,0.14); color:#fecaca; font-size:22px; cursor:pointer; }
        .msgOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.82); z-index: 11000; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .msgModal { width: min(760px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: linear-gradient(180deg, #0b1220, #111827); border: 1px solid rgba(255,255,255,0.12); border-radius: 22px; box-shadow: 0 24px 80px rgba(0,0,0,0.45); padding: 18px; }
        .msgModalTop { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
        .msgModalTitle { font-size: 18px; font-weight: 900; letter-spacing: .4px; }
        .msgModalSub { font-size: 12px; opacity: .72; margin-top: 4px; }
        .msgPreview { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 16px; }
        .msgActions { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; margin-top:14px; }
        .modal-content.dark { background: #0b0b0b; color: #fff; border: 1px solid rgba(255,255,255,0.1); }
        
        /* MODERN CHIPS STYLE */
        .chip-modern { padding: 10px 14px; border-radius: 14px; font-weight: 900; font-size: 16px; letter-spacing: 0.2px; text-shadow: 0 1px 0 rgba(0,0,0,0.35); }
        .gpsBtn { width: 44px; background: #222; border: 1px solid #333; border-radius: 12px; color: white; font-size: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      `}</style>
    </div>
  );
}