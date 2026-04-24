"use client";
import { computeM2FromRows } from '@/lib/baseCodes';
import { reserveTransportCode } from '@/lib/transportCodes';
import { normalizePhoneDigits } from '@/lib/transport/clientCodes';
import { upsertTransportClient } from '@/lib/transport/transportDb';
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getPendingOps } from '@/lib/offlineStore';
import { getTransportSession, getTransportContext } from '@/lib/transportAuth';
import { recordCashMove } from '@/lib/arkaCashSync';
import PosModal from '@/components/PosModal';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getClientBalanceByPhone } from '@/lib/clientBalanceDb';
import { enqueueTransportOrder, syncNow } from '@/lib/syncManager';
import { addTransportCollected } from '@/lib/transportArkaStore';
import { fetchTransportOrderById, listTransportOrders, searchTransportClientCandidatesByOrders, updateTransportOrderById } from '@/lib/transportOrdersDb';
import { buildSmsLink } from '@/lib/smartSms';
import { trackRender } from '@/lib/sensor';
import useRouteAlive from '@/lib/routeAlive';
const BUCKET = 'tepiha-photos';
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.5, 3.7, 4.0, 5.0, 6.0, 8.0, 12.0];
const STAZA_CHIPS = [0.5, 0.8, 0.9, 1.2, 1.5, 1.6, 2.0, 2.4, 2.5, 3.0, 4.0, 5.0];
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 1.5;
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
const TRANSPORT_CLIENT_SEARCH_TIMEOUT_MS = 12000;
// ---------------- HELPERS ----------------
function sanitizePhone(phone) { return String(phone || '').replace(/\D+/g, ''); }
function normDigits(s) { return String(s || '').replace(/\D+/g, ''); }
function looksUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim()); }
function isOpaqueUserRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^ADMIN_/i.test(raw)) return true;
  if (looksUuid(raw)) return true;
  return /^\d{3,}$/.test(raw);
}
function cleanVisibleName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return isOpaqueUserRef(raw) ? '' : raw;
}

function readPendingTransportPayload(op) {
  const payload = op?.payload && typeof op.payload === 'object'
    ? op.payload
    : (op?.data && typeof op.data === 'object' ? op.data : {});
  return payload && typeof payload === 'object' ? payload : {};
}

async function hasPendingTransportQueueItem(oid) {
  const targetId = String(oid || '').trim();
  if (!targetId) return false;
  const pendingOps = await getPendingOps().catch(() => []);
  return (Array.isArray(pendingOps) ? pendingOps : []).some((op) => {
    const payload = readPendingTransportPayload(op);
    const table = String(payload?.table || op?.table || payload?._table || '').trim();
    if (table !== 'transport_orders') return false;
    const rowId = String(payload?.id || payload?.local_oid || payload?.oid || op?.id || '').trim();
    return rowId === targetId;
  });
}
function displayTransportName(value, lookup, fallback = '') {
  const direct = cleanVisibleName(value);
  if (direct) return direct;
  const raw = String(value || '').trim();
  const digit = normDigits(raw);
  const byDigit = digit ? String(lookup?.get(digit) || '').trim() : '';
  if (byDigit) return byDigit;
  const byRaw = raw ? String(lookup?.get(raw) || '').trim() : '';
  if (byRaw) return byRaw;
  return fallback;
}
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
async function searchClientsLive(transportId, q, options = {}) {
  const tid = String(transportId || '').trim();
  const qq = String(q || '').trim();
  if (!qq) return [];

  const signal = options?.signal;
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : TRANSPORT_CLIENT_SEARCH_TIMEOUT_MS;
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
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(x);
  };

  const isAbortError = (error) => {
    const code = String(error?.code || '').toUpperCase();
    return error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'SEARCH_ABORTED' || /abort/i.test(String(error?.message || ''));
  };

  const mapClientRow = (c) => {
    const digits = normalizePhoneDigits(c?.phone_digits || c?.phone || '');
    push({
      id: c?.id,
      kind: String(c?.kind || 'client'),
      source: c?.source || 'transport_clients',
      tcode: String(c?.tcode || ''),
      name: String(c?.name || ''),
      phone: String(c?.phone || ''),
      phone_digits: digits,
      address: c?.address || '',
      gps_lat: c?.gps_lat,
      gps_lng: c?.gps_lng,
      brought_by: String(c?.brought_by || ''),
      pieces: Number(c?.pieces || 0),
    });
  };

  const orderFallbackPromise = searchTransportClientCandidatesByOrders({
    transportId: tid,
    query: qq,
    limit: 20,
    signal,
    timeoutMs: Math.max(5000, Math.min(timeoutMs, 9000)),
    timeoutLabel: 'TRANSPORT_CLIENT_FALLBACK_TIMEOUT',
  }).catch((error) => {
    if (isAbortError(error)) throw error;
    return [];
  });

  const runClientLookup = async (column, value) => {
    let query = supabase
      .from('transport_clients')
      .select('id, tcode, name, phone, phone_digits, address, gps_lat, gps_lng, updated_at')
      .ilike(column, value)
      .order('updated_at', { ascending: false })
      .limit(12);

    if (typeof query?.timeout === 'function') {
      query = query.timeout(timeoutMs, 'SUPABASE_TIMEOUT');
    }
    if (signal && typeof query?.abortSignal === 'function') {
      query = query.abortSignal(signal);
    }

    const { data, error } = await query;
    if (error) throw error;
    (data || []).forEach(mapClientRow);
  };

  const tasks = [];
  if (qDigits.length >= 3) tasks.push(runClientLookup('phone_digits', `%${qDigits}%`));
  if ((isTCode && tDigits) || (isDigitsOnly && qDigits.length >= 1 && qDigits.length <= 6)) {
    tasks.push(runClientLookup('tcode', `T${(tDigits || qDigits)}%`));
  }
  if (qq.length >= 2 && !isDigitsOnly && !isTCode) {
    tasks.push(runClientLookup('name', `%${qq}%`));
  }

  const [orderFallback, results] = await Promise.all([
    orderFallbackPromise,
    Promise.allSettled(tasks),
  ]);
  (orderFallback || []).forEach(mapClientRow);

  const realErrors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
    .filter((error) => !isAbortError(error));

  if (!out.length && realErrors.length) {
    throw realErrors[0];
  }

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
function chipStyleForVal(v, active) {
  const n = Number(v);

  let a = 'rgba(56,189,248,0.28)';
  let b = 'rgba(59,130,246,0.14)';
  let br = 'rgba(125,211,252,0.70)';

  if (n >= 5.8) {
    a = 'rgba(251,146,60,0.28)';
    b = 'rgba(249,115,22,0.14)';
    br = 'rgba(253,186,116,0.72)';
  } else if (Math.abs(n - 3.2) < 0.051) {
    a = 'rgba(248,113,113,0.28)';
    b = 'rgba(239,68,68,0.14)';
    br = 'rgba(252,165,165,0.72)';
  } else if (n >= 3.5) {
    a = 'rgba(244,114,182,0.26)';
    b = 'rgba(236,72,153,0.12)';
    br = 'rgba(249,168,212,0.68)';
  } else if (n >= 2.2) {
    a = 'rgba(250,204,21,0.26)';
    b = 'rgba(245,158,11,0.12)';
    br = 'rgba(253,224,71,0.68)';
  } else {
    a = 'rgba(192,132,252,0.26)';
    b = 'rgba(168,85,247,0.12)';
    br = 'rgba(216,180,254,0.68)';
  }

  return {
    background: `linear-gradient(180deg, ${a}, ${b})`,
    border: `1.5px solid ${br}`,
    outline: active ? '2px solid rgba(255,255,255,0.42)' : 'none',
    boxShadow: active
      ? '0 10px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.18)'
      : '0 8px 14px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.14)',
    color: '#fff',
    fontWeight: 900,
  };
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

function getAdvancedTransportStatus(currentStatus = '', fallbackStatus = 'loaded') {
  const current = String(currentStatus || '').trim().toLowerCase();
  const fallback = String(fallbackStatus || 'loaded').trim().toLowerCase() || 'loaded';
  if (!current) return fallback;
  if (current === 'dispatched' || current === 'assigned' || current === 'new' || current === 'inbox' || current === 'pranim') return 'pickup';
  if (current === 'pickup') return 'loaded';
  if (current === 'loaded' || current === 'ngarkim' || current === 'ngarkuar') return 'pastrim';
  return current;
}

// ---------------- COMPONENT ----------------
function PranimiPageInner() {
  useRouteAlive('transport_pranimi_page');
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = String(searchParams?.get('id') || '').trim();
  const isEdit = Boolean(editId);
  const newStatusRaw = String(searchParams?.get('new_status') || '').trim().toLowerCase();
  
  // Flow: në create respektojmë query statusin; default i sigurt = 'pickup'.
  const createStatus = (newStatusRaw === 'pickup' || newStatusRaw === 'loaded') ? newStatusRaw : 'pickup';
  const [editRowStatus, setEditRowStatus] = useState('loaded');
  const [phonePrefix, setPhonePrefix] = useState('+383');
  const [showPrefixSheet, setShowPrefixSheet] = useState(false);
  const [showAddClient, setShowAddClient] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsSaved, setGpsSaved] = useState(false);
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
  const [clientSearchNotice, setClientSearchNotice] = useState('');
  const [oldClientDebt, setOldClientDebt] = useState(0);
  const [clientId, setClientId] = useState(null);
  const [clientTcode, setClientTcode] = useState('');
  const [activeChipKey, setActiveChipKey] = useState('');
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
  const [offlineMode, setOfflineMode] = useState(false);
  const [netState, setNetState] = useState({ ok: true, reason: '' });
  // ADMIN/DISPATCH can create transport orders without being a transport actor.
  // Prevent leaking orders to a driver just because a stale transport session exists.
  const [actor, setActor] = useState(null); // { role, pin }
  const [assignTid, setAssignTid] = useState(''); // transport_id to write into order.data.transport_id
  const [transportUsers, setTransportUsers] = useState([]); // [{pin,name}]
  const transportUserNameMap = useMemo(() => new Map((Array.isArray(transportUsers) ? transportUsers : []).map((u) => [String(u?.pin || u?.transport_id || '').trim(), String(u?.name || '').trim()]).filter((entry) => entry[0] && entry[1])), [transportUsers]);
  // Detect actor/session changes (logout/login) without full page reload.
  // Safari/PWA can keep this page alive; without this, a new PIN can inherit the previous actor's code/oid.
  const actorSigRef = useRef('');
  const draftTimer = useRef(null);
  const secretTapRef = useRef(0);
  const draftSnapshotRef = useRef('');
  const liveSearchSeqRef = useRef(0);
  const liveSearchAbortRef = useRef(null);
  const secretTapTimerRef = useRef(null);
  const codeWarmupTimerRef = useRef(null);
  const debtLookupTimerRef = useRef(null);
  function getCurrentDraftTransportId() {
    return String((actor?.role === 'TRANSPORT' ? me?.transport_id : assignTid) || '').trim();
  }
  useEffect(() => {
    trackRender('TransportPranimiPage');
  }, []);
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
        
        const initDraftScopeTid = String((role === 'TRANSPORT' ? transportScope?.transport_id : adminTidLocal) || '').trim();
        try { setDrafts(readAllDraftsLocal(initDraftScopeTid)); } catch {}
        if (isEdit) {
            const row = await fetchTransportOrderById(editId).catch(() => null);
            if (row) {
                setOid(row.id); setCodeRaw(row.code_str); setEditRowStatus(row.status);
                const d = row.data || {};
                const c = d.client || {};
                setName(c.name || ''); 
                try {
                  const fullPhone = String(c.phone || '');
                  const pref = PREFIX_OPTIONS.find((opt) => fullPhone.startsWith(opt.code));
                  if (pref) {
                    setPhonePrefix(pref.code);
                    setPhone(fullPhone.slice(pref.code.length).replace(/\D+/g, ''));
                  } else {
                    setPhone(fullPhone.replace(/\D+/g, ''));
                  }
                } catch {}
                setClientPhotoUrl(c.photoUrl||'');
                setClientId(row?.client_id || c?.id || null);
                setClientTcode(String(c.tcode || c.code || row.code_str || ''));
                setAddressDesc(c.address || d?.address || row?.address || ''); 
                const lat = c?.gps?.lat ?? c?.gps_lat ?? d?.gps_lat ?? row?.gps_lat ?? '';
                const lng = c?.gps?.lng ?? c?.gps_lng ?? d?.gps_lng ?? row?.gps_lng ?? '';
                if (lat !== '' && lat != null) setGpsLat(lat);
                if (lng !== '' && lng != null) setGpsLng(lng);
                
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
            const tidForCode = (role === 'TRANSPORT')
              ? String(transportScope?.transport_id || scope?.transport_id || '')
              : String(adminTidLocal || scope?.transport_id || assignTid || '');
            const lease = readCodeLease();
            const leasedCode = (lease && String(lease.tid || '') === String(tidForCode || '') && (Date.now() - Number(lease.at || 0) < 60*60*1000))
              ? String(lease.code || '')
              : '';
            setCodeRaw(leasedCode || '');
            clearTimeout(codeWarmupTimerRef.current);
            const offlineNow = (() => {
              try {
                return localStorage.getItem(OFFLINE_MODE_KEY) === '1' || (typeof navigator !== 'undefined' && navigator.onLine === false);
              } catch {
                return typeof navigator !== 'undefined' && navigator.onLine === false;
              }
            })();
            codeWarmupTimerRef.current = setTimeout(async () => {
              try {
                const c = await getOrReserveTransportCode(tidForCode);
                if (c) setCodeRaw(c);
              } catch (e) {
                if (!offlineNow) {
                  try { setOfflineMode(true); } catch {}
                  try { setNetState({ ok: false, reason: 'CODE_RESERVE_FAILED' }); } catch {}
                  try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
                }
              }
            }, offlineNow ? 60 : 700);
        }
        setCreating(false);
    })();
  }, []);

  useEffect(() => {
    return () => {
      try { clearTimeout(codeWarmupTimerRef.current); } catch {}
      try { clearTimeout(debtLookupTimerRef.current); } catch {}
      try { clearTimeout(draftTimer.current); } catch {}
      try { liveSearchAbortRef.current?.abort?.(); } catch {}
      try { secretTapTimerRef.current && clearTimeout(secretTapTimerRef.current); } catch {}
    };
  }, []);

  useEffect(() => {
    if (creating || isEdit || codeRaw) return;
    if (!offlineMode) return;
    const tid = (actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid;
    if (!tid) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const c = await getOrReserveTransportCode(String(tid || ''));
        if (!cancelled && c) setCodeRaw(c);
      } catch {}
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [offlineMode, creating, isEdit, codeRaw, actor?.role, me?.transport_id, assignTid]);

  useEffect(() => {
    try {
      const offlineFlag = localStorage.getItem(OFFLINE_MODE_KEY) === '1';
      setOfflineMode(Boolean(offlineFlag || (typeof navigator !== 'undefined' && navigator.onLine === false)));
      setNetState({
        ok: !(offlineFlag || (typeof navigator !== 'undefined' && navigator.onLine === false)),
        reason: offlineFlag ? 'OFFLINE_FLAG' : ((typeof navigator !== 'undefined' && navigator.onLine === false) ? 'OFFLINE' : ''),
      });
    } catch {}
    const onOnline = () => {
      setOfflineMode(false);
      setNetState({ ok: true, reason: '' });
      try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
    };
    const onOffline = () => {
      setOfflineMode(true);
      setNetState({ ok: false, reason: 'OFFLINE' });
      try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
    };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PRICE_KEY);
      if (raw == null || raw === '') return;
      const saved = Number(raw);
      if (!Number.isFinite(saved) || saved <= 0) return;
      if (saved === 3) {
        setPricePerM2(PRICE_DEFAULT);
        try { localStorage.setItem(PRICE_KEY, String(PRICE_DEFAULT)); } catch {}
        return;
      }
      setPricePerM2(saved);
    } catch {}
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
    const t = setInterval(() => { tick(); }, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [router]);
  // Search Live (TEL / KOD / T-CODE / EMËR)
  useEffect(() => {
      const q = String(clientQuery || '').trim();
      const digits = normalizePhoneDigits(q);
      const isT = /^t\d+$/i.test(q) || (q.toLowerCase().startsWith('t') && normalizePhoneDigits(q.slice(1)).length > 0);
      const should = (digits.length >= 1) || isT || (q.length >= 2);
      try { liveSearchAbortRef.current?.abort?.(); } catch {}
      liveSearchAbortRef.current = null;
      if (!should) {
        setClientHits([]);
        setClientSearchNotice('');
        setClientsLoading(false);
        return;
      }
      const tid = (actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid;
      const seq = ++liveSearchSeqRef.current;
      setClientsLoading(true);
      setClientSearchNotice('');
      const timer = setTimeout(() => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        liveSearchAbortRef.current = controller;
        searchClientsLive(tid, q, {
          signal: controller?.signal,
          timeoutMs: TRANSPORT_CLIENT_SEARCH_TIMEOUT_MS,
        })
          .then((r) => {
            if (liveSearchSeqRef.current !== seq) return;
            setClientHits(Array.isArray(r) ? r : []);
            setClientSearchNotice('');
          })
          .catch((error) => {
            if (liveSearchSeqRef.current !== seq) return;
            const code = String(error?.code || '').toUpperCase();
            const isAbort = error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'SEARCH_ABORTED' || /abort/i.test(String(error?.message || ''));
            if (isAbort) return;
            setClientHits((prev) => (Array.isArray(prev) ? prev : []));
            setClientSearchNotice('Lidhja me serverin është e dobët. Po shfaqen rezultatet që kemi në cache.');
          })
          .finally(() => {
            if (liveSearchSeqRef.current !== seq) return;
            if (liveSearchAbortRef.current === controller) liveSearchAbortRef.current = null;
            setClientsLoading(false);
          });
      }, 400);
      return () => {
        clearTimeout(timer);
        try {
          if (liveSearchAbortRef.current) {
            liveSearchAbortRef.current.abort();
            liveSearchAbortRef.current = null;
          }
        } catch {}
      };
  }, [clientQuery, me?.transport_id, assignTid, actor?.role]);
  // Autosave Draft
  useEffect(() => {
      if(creating || !oid) return;
      clearTimeout(draftTimer.current);
      const draftPayload = buildDraftPayload({
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
        notes,
        clientPaid,
        pricePerM2
      }, getCurrentDraftTransportId());
      const nextSnapshot = JSON.stringify(draftPayload || {});
      draftTimer.current = setTimeout(() => {
          if(!(name || phone)) return;
          if (draftSnapshotRef.current === nextSnapshot) return;
          upsertDraftLocal(draftPayload);
          draftSnapshotRef.current = nextSnapshot;
      }, 800);
      return () => clearTimeout(draftTimer.current);
  }, [creating, oid, codeRaw, name, phone, tepihaRows, stazaRows, stairsQty, stairsPer, addressDesc, gpsLat, gpsLng, clientPhotoUrl, notes, clientPaid, pricePerM2, actor?.role, me?.transport_id, assignTid]);
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
  const copeCount = useMemo(() => {
    const t = (Array.isArray(tepihaRows) ? tepihaRows : []).reduce((s, r) => s + (Number(r?.qty) || 0), 0);
    const st = (Array.isArray(stazaRows) ? stazaRows : []).reduce((s, r) => s + (Number(r?.qty) || 0), 0);
    return t + st + (Number(stairsQty) || 0);
  }, [tepihaRows, stazaRows, stairsQty]);
  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const diff = useMemo(() => Number((totalEuro - Number(clientPaid || 0)).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;
  const currentChange = diff < 0 ? Math.abs(diff) : 0;
  const remainingDue = Math.max(0, Number((totalEuro - Number(clientPaid || 0)).toFixed(2)));

  useEffect(() => {
    let alive = true;
    const phoneFull = sanitizePhone(phonePrefix + (phone || ''));
    try { clearTimeout(debtLookupTimerRef.current); } catch {}
    if (!phoneFull || phoneFull.length < 6) { setOldClientDebt(0); return () => { alive = false; }; }
    debtLookupTimerRef.current = setTimeout(async () => {
      try {
        const res = await getClientBalanceByPhone(phoneFull);
        if (!alive) return;
        setOldClientDebt(Number(res?.debt_eur || 0) || 0);
      } catch {
        if (alive) setOldClientDebt(0);
      }
    }, 500);
    return () => {
      alive = false;
      try { clearTimeout(debtLookupTimerRef.current); } catch {}
    };
  }, [phonePrefix, phone]);

  useEffect(() => {
      if(!showPaySheet) return;
      if(Number(payAdd || 0) > 0) return;
      setPayAdd(remainingDue);
  }, [showPaySheet, remainingDue, payAdd]);
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
      try {
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
          alert('GPS nuk mbështetet në këtë pajisje.');
          return;
        }
        setGpsLoading(true);
        setGpsSaved(false);
        navigator.geolocation.getCurrentPosition(
          (p) => {
            setGpsLat(p.coords.latitude);
            setGpsLng(p.coords.longitude);
            setGpsLoading(false);
            setGpsSaved(true);
          },
          () => {
            setGpsLoading(false);
            setGpsSaved(false);
            alert('Nuk u mor lokacioni. Lejo GPS dhe provo prap.');
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
      } catch {
        setGpsLoading(false);
        setGpsSaved(false);
      }
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
        `Kur porosia të jetë gati, do t'ju njoftojmë për konfirmim. Pa konfirmimin tuaj, porosia nuk sillet.`,
        `Nëse nuk lajmëroheni brenda 3 ditëve, aplikohet tarifë ekstra për ta risjellë.`,
        ``,
        `📍 Ndiqni porosinë live:`,
        `https://tepiha.vercel.app/k/${normalizeTcode(codeRaw)}`,
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
  function saveClientQuick() {
      if (!String(name || '').trim()) return alert('Shkruaj emrin!');
      const normalized = normalizeTcode(clientTcode || codeRaw);
      setClientTcode(normalized);
      setCodeRaw(normalized);
      setShowAddClient(false);
  }

  function handleTcodeChange(raw) {
      const normalized = normalizeTcode(raw);
      setClientTcode(normalized);
      setCodeRaw(normalized);
  }

  // ✅ FIX: RUAJTJA -> KAMION -> MESAZH
  async function handleContinue() {
      if (savingContinue || photoUploading) return;
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
      let nextClientId = null;
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
        nextClientId = r?.id || r?.client_id || null;
        setClientId(nextClientId || null);
      } catch (e) {
        // If RLS blocks writes to transport_clients, we still allow order save.
        console.warn('upsertTransportClient failed:', e?.message);
      }
      const order = {
          id: oid, ts: Date.now(),
          client: { id: nextClientId, tcode: tcodeForClient, name, phone: phonePrefix+phone, code: tcodeForClient, photoUrl: clientPhotoUrl, address: addressDesc, gps: { lat: gpsLat || null, lng: gpsLng || null } },
          tepiha: tepihaRows, staza: stazaRows, shkallore: { qty: stairsQty, per: stairsPer, photoUrl: stairsPhotoUrl },
          pay: { m2: totalM2, euro: totalEuro, paid: clientPaid, rate: Number(pricePerM2) || PRICE_DEFAULT, arkaRecordedPaid },
          notes
      };
      
      // Visit number (how many times this client has had an order)
      let visitNr = 1;
      try {
        if (tcodeForClient) {
          const vrows = await listTransportOrders({
            select: 'visit_nr',
            eq: { client_tcode: tcodeForClient },
            orderBy: 'visit_nr',
            ascending: false,
            limit: 1,
          }).catch(() => []);
          if (Array.isArray(vrows) && vrows[0]) {
            const last = Number(vrows[0].visit_nr || 0);
            visitNr = (Number.isFinite(last) ? last : 0) + 1;
          }
        }
      } catch {}
      if (!Number.isFinite(visitNr) || visitNr < 1) visitNr = 1;
      const nextStatus = isEdit ? getAdvancedTransportStatus(editRowStatus, createStatus) : createStatus;
      const payload = {
          id: oid, 
          code_str: tcodeForClient, 
          client_tcode: tcodeForClient,
          visit_nr: visitNr,
          client_id: nextClientId,
          client_name: name, 
          client_phone: phoneFull,
          // ⚠️ transport_id është GENERATED ALWAYS (data->>'transport_id').
          // Pra NUK guxojmë me e fut në INSERT/UPDATE (kthen error "cannot insert a non-DEFAULT value...").
          // Board e lexon transport_id nga kolona e gjeneruar, sepse ne e ruajmë gjithmonë te data.transport_id.
          status: nextStatus,
          data: { ...order, transport_id: tid, created_by_pin: actor?.pin || null, created_by_role: actor?.role || null, gps_lat: gpsLat || null, gps_lng: gpsLng || null }
      };
      // In edit mode, keep original client_tcode/visit_nr (don't overwrite)
      if (isEdit) {
        delete payload.client_tcode;
        delete payload.visit_nr;
      }
      try {
        if (isEdit) {
          await updateTransportOrderById(oid, payload);
          await syncNow({ scope: 'transport', source: 'transport_pranimi_edit' }).catch(() => ({ ok: false }));
        } else {
          // ✅ Robust Outbox: persist PENDING first, then attempt immediate sync.
          // DB triggers will auto-mark pool codes as USED only when INSERT/UPSERT succeeds.
          await enqueueTransportOrder(payload);
          const syncRes = await syncNow({ scope: 'transport', source: 'transport_pranimi_create' }).catch(() => ({ ok: false }));
          const offlineQueued = Boolean(syncRes?.offline || offlineMode || !netState?.ok || (typeof navigator !== 'undefined' && navigator.onLine === false));
          const pendingOps = await getPendingOps().catch(() => []);
          const currentPending = (Array.isArray(pendingOps) ? pendingOps : []).find((op) => {
            const pl = (op?.payload && typeof op.payload === 'object') ? op.payload : ((op?.data && typeof op.data === 'object') ? op.data : {});
            const rowId = String(pl?.id || pl?.local_oid || pl?.oid || op?.id || '');
            return rowId === String(oid);
          });
          if (currentPending && !offlineQueued) {
            throw new Error(String(currentPending?.lastError?.message || 'Dështoi sinkronizimi me serverin!'));
          }
        }

        removeDraftLocal(oid);
        setSavingContinue(false);

        if(autoMsgAfterSave) { setMsgKind('start'); setShowMsgSheet(true); } // ✅ HAP MESAZHIN
        else {
          const returnTab = String(searchParams?.get('return_tab') || '').toLowerCase();
          const returnMode = String(searchParams?.get('return_mode') || '').toLowerCase();
          if (returnTab === 'loaded') {
            router.push(`/transport/board?tab=loaded&mode=${returnMode === 'out' ? 'out' : 'in'}`);
          } else if (returnTab === 'ready') {
            router.push('/transport/board?tab=ready');
          } else if (returnTab === 'depo') {
            router.push('/transport/board?tab=depo');
          } else {
            router.push('/transport/board');
          }
        }
      } catch (e) {
          let queuedTransportOffline = false;
          try {
            queuedTransportOffline = await hasPendingTransportQueueItem(oid);
            if (!queuedTransportOffline && payload && !isEdit) {
              await enqueueTransportOrder(payload);
              queuedTransportOffline = true;
            }
          } catch {}
          if (!queuedTransportOffline) {
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
          }
          try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
          alert(
            queuedTransportOffline
              ? ("⚠️ RUJTJA NË SERVER DËSHTOI. POROSIA MBETI VETËM NË TRANSPORT OFFLINE QUEUE.\n" + (e?.message || ''))
              : ("⚠️ RUJTJA NË SERVER DËSHTOI. U RUAJT SI TRANSPORT DRAFT/OFFLINE.\n" + (e?.message || ''))
          );
          setSavingContinue(false);
      }
  }
  async function persistTransportPaymentState({ nextPaid, nextArkaRecordedPaid, totalEuroOverride }) {
      if (!isEdit || !oid) return { ok: true, skipped: true };
      const totalToSave = Number(totalEuroOverride ?? totalEuro ?? 0);
      const nextData = {
          client: {
              id: clientId || null,
              tcode: String((clientTcode || normalizeTcode(codeRaw)) || '').toUpperCase().trim(),
              name,
              phone: phonePrefix + phone,
              code: String((clientTcode || normalizeTcode(codeRaw)) || '').toUpperCase().trim(),
              photoUrl: clientPhotoUrl,
              address: addressDesc,
              gps: { lat: gpsLat || null, lng: gpsLng || null },
          },
          tepiha: tepihaRows,
          staza: stazaRows,
          shkallore: { qty: stairsQty, per: stairsPer, photoUrl: stairsPhotoUrl },
          pay: {
              m2: totalM2,
              euro: totalToSave,
              paid: Number(nextPaid || 0),
              rate: Number(pricePerM2) || PRICE_DEFAULT,
              arkaRecordedPaid: Number(nextArkaRecordedPaid || 0),
          },
          notes,
          transport_id: (actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid,
          created_by_pin: actor?.pin || null,
          created_by_role: actor?.role || null,
          gps_lat: gpsLat || null,
          gps_lng: gpsLng || null,
      };
      nextData.totals = { grandTotal: totalToSave };
      await updateTransportOrderById(oid, {
        client_name: name,
        client_phone: sanitizePhone(phonePrefix + phone),
        status: 'done',
        data: nextData,
      });
      return { ok: true };
  }

  async function applyPayAndClose() {
      const cashGiven = Number((Number(payAdd) || 0).toFixed(2));
      const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2)));
      if (due <= 0) { alert('KJO POROSI ËSHTË E PAGUAR PLOTËSISHT.'); return; }
      if (cashGiven < due) { alert('KLIENTI DHA MË PAK SE BORXHI! JU LUTEM PLOTËSONI SHUMËN OSE ANULONI.'); return; }

      const applied = due;
      const kusuri = Math.max(0, cashGiven - due);
      const pinLabel = `PAGESË: ${applied.toFixed(2)}€\nKLIENTI DHA: ${cashGiven.toFixed(2)}€\nKUSURI (RESTO): ${kusuri.toFixed(2)}€\n\n👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;

      const pinData = await requirePaymentPin({ label: pinLabel });
      if (!pinData) return;

      const nextPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
      setClientPaid(nextPaid);

      let nextArkaRecordedPaid = Number(arkaRecordedPaid || 0);
      if (payMethod === 'CASH') {
        nextArkaRecordedPaid = Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2));
        setArkaRecordedPaid(nextArkaRecordedPaid);
      }

      setShowPaySheet(false);

      try {
        await persistTransportPaymentState({
          nextPaid,
          nextArkaRecordedPaid,
          totalEuroOverride: totalEuro,
        });
      } catch (e) {
        alert('Gabim gjatë ruajtjes së pagesës: ' + (e?.message || ''));
        return;
      }

      void (async () => {
        try {
          if (payMethod === 'CASH') {
            const actorPin = String(pinData?.pin || actor?.pin || me?.transport_pin || me?.pin || '').trim();
            const actorTid = String(me?.transport_id || assignTid || '').trim();
            try {
              if (actorTid) {
                const transportCode = normalizeTcode(codeRaw);
                const transportM2 = Number(totalM2 || 0) || 0;
                const transportNote = `PAGESA ${applied}€ - ${name} • ${transportCode || 'T-KOD'} • ${transportM2.toFixed(2)} m²`;
                addTransportCollected(actorTid, {
                  id: `cash_${Date.now()}`,
                  amount: applied,
                  order_code: transportCode,
                  client_name: name,
                  note: transportNote,
                  created_at: new Date().toISOString(),
                  created_by_pin: actorPin || null,
                });
              }
            } catch {}
            const transportCode = normalizeTcode(codeRaw);
            const transportM2 = Number(totalM2 || 0) || 0;
            const transportNote = `PAGESA ${applied}€ - ${name} • ${transportCode || 'T-KOD'} • ${transportM2.toFixed(2)} m²`;
            await recordCashMove({
              amount: applied,
              note: transportNote,
              type: 'TRANSPORT',
              status: 'COLLECTED',
              order_id: oid,
              order_code: transportCode,
              client_name: name,
              source: 'ORDER_PAY',
              actor: {
                pin: actorPin || null,
                name: pinData?.name || me?.name || me?.full_name || me?.username || null,
                role: pinData?.role || me?.role || null,
              },
              created_by_pin: actorPin || null,
              created_by_name: pinData?.name || me?.name || me?.full_name || me?.username || null,
            });
          }
        } catch {}
      })();

      if (typeof window !== 'undefined') {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'transport-payment-complete' }, window.location.origin);
        } else {
          router.replace('/transport/board?tab=delivered');
        }
      }
  }
  // --- DRAFTS ---
  function openDrafts() { setDrafts(readAllDraftsLocal(getCurrentDraftTransportId())); setShowDraftsSheet(true); }
  function loadDraft(d) {
      setOid(d.id); setCodeRaw(d.codeRaw); setName(d.name || ''); setPhone(d.phone || ''); 
      setTepihaRows(d.tepihaRows||[]); setStazaRows(d.stazaRows||[]); setClientPaid(d.clientPaid||0);
      setPricePerM2(Number(d.pricePerM2 || PRICE_DEFAULT));
      setStairsQty(d.stairsQty || 0); setStairsPer(d.stairsPer || SHKALLORE_M2_PER_STEP_DEFAULT);
      setAddressDesc(d.addressDesc || ''); setGpsLat(d.gpsLat || ''); setGpsLng(d.gpsLng || '');
      setClientPhotoUrl(d.clientPhotoUrl || '');
      setNotes(d.notes || '');
      setCurrentStep(1);
      setShowDraftsSheet(false);
  }
  function deleteDraft(id) { removeDraftLocal(id); setDrafts(readAllDraftsLocal(getCurrentDraftTransportId())); }
  // --- PAYMENT / PRICE ---
  function openPay() {
    const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    setPayAdd(dueNow > 0 ? dueNow : 0);
    setPayMethod('CASH');
    setShowPaySheet(true);
  }
  function openPriceEditor() { setPriceTmp(pricePerM2); setShowPriceSheet(true); }
  function handleSecretPriceTap() {
    if (secretTapTimerRef.current) clearTimeout(secretTapTimerRef.current);
    secretTapRef.current += 1;
    if (secretTapRef.current >= 3) {
      secretTapRef.current = 0;
      openPriceEditor();
      return;
    }
    secretTapTimerRef.current = setTimeout(() => {
      secretTapRef.current = 0;
      secretTapTimerRef.current = null;
    }, 1000);
  }

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (secretTapTimerRef.current) clearTimeout(secretTapTimerRef.current);
    };
  }, []);

  async function savePriceAndClose() {
      const v = Number(priceTmp);
      if(!(v > 0)) {
        setShowPriceSheet(false);
        return;
      }

      setPricePerM2(v);
      try { localStorage.setItem(PRICE_KEY, String(v)); } catch {}

      try {
        if (oid) {
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
            notes,
            clientPaid,
            pricePerM2: v,
          }, getCurrentDraftTransportId()));
        }
      } catch {}

      if (isEdit && oid) {
        try {
          await persistTransportPaymentState({
            nextPaid: clientPaid,
            nextArkaRecordedPaid: arkaRecordedPaid,
            totalEuroOverride: Number((totalM2 * v).toFixed(2)),
          });
        } catch (e) {
          alert('Gabim gjatë ruajtjes së çmimit: ' + (e?.message || ''));
          return;
        }
      }

      setShowPriceSheet(false);
  }
  if (creating) return <div className="wrap"><p style={{textAlign:'center', paddingTop:30}}>Duke u hapur...</p></div>;
  return (
    <div className="wrap">
        <header className="header-row" style={{ alignItems: 'flex-start' }}>
            <div><h1 className="title">PRANIMI</h1><div className="subtitle">KRIJO POROSI</div></div>
            <div className="code-badge"><span className="badge" onClick={handleSecretPriceTap} style={{ cursor: "pointer", WebkitTapHighlightColor: "transparent", userSelect: "none", WebkitUserSelect: "none" }}>KODI: {normalizeTcode(codeRaw)}</span></div>
        </header>

        {actor?.role !== 'TRANSPORT' && (
          <section style={{marginTop: 10}}>
            <div className="card" style={{padding:'12px 14px', borderRadius:18}}>
              <div style={{fontSize:12, opacity:.75, marginBottom:8}}>KUJT ME IA QIT?</div>
              <select
                value={assignTid}
                onChange={async (e) => {
                  const v = String(e.target.value || '').trim();
                  setAssignTid(v);
                  if (!isEdit) {
                    try {
                      const c = await getOrReserveTransportCode(v);
                      setCodeRaw(c);
                    } catch {}
                  }
                }}
                style={{width:'100%', padding:'10px 12px', borderRadius:12, background:'#0f172a', color:'#fff', border:'1px solid rgba(255,255,255,0.12)'}}
              >
                <option value={assignTid}>{assignTid.startsWith('ADMIN_') || assignTid==='ADMIN' ? 'VETEM ADMIN' : (displayTransportName(assignTid, transportUserNameMap, 'SHOFER I CAKTUAR') || 'SHOFER I CAKTUAR')}</option>
                {actor?.pin && <option value={`ADMIN_${actor.pin}`}>VETEM ADMIN</option>}
                {transportUsers.map(u => <option key={u.pin} value={u.pin}>{u.name}</option>)}
              </select>
            </div>
          </section>
        )}

        <section className="card">
          <h2 className="card-title">KLIENTI</h2>
          <div className="client-toolbar">
            <button type="button" className="icon-chip search" aria-label="Kërko klient" title="KËRKO KLIENT">🔍</button>
            <button type="button" className="icon-chip drafts" onClick={openDrafts} aria-label="Të pa plotsuarat" title={`TË PA PLOTSUARAT${drafts.length > 0 ? ` (${drafts.length})` : ''}`}>📝{drafts.length > 0 ? <span className="header-icon-badge">{drafts.length}</span> : null}</button>
            <button type="button" className="icon-chip add" onClick={() => setShowAddClient(true)} aria-label="Shto klient" title="SHTO KLIENT">＋</button>
          </div>

          <div className="field-group" style={{ marginTop: 12 }}>
            <input className="input" placeholder="KËRKO: TEL • KOD • Txx • EMËR" value={clientQuery} onChange={e => setClientQuery(e.target.value)} />
            {clientsLoading ? <div style={{ fontSize: 12, opacity: .7, marginTop: 8 }}>DUKE KËRKUAR...</div> : null}
            {clientSearchNotice ? <div style={{ fontSize: 12, opacity: .82, marginTop: 8, color: '#fbbf24', fontWeight: 800 }}>{clientSearchNotice}</div> : null}
            {clientHits.length > 0 ? (
              <div className="client-hits">
                {clientHits.map((c, i) => (
                  <button
                    type="button"
                    key={c.id || i}
                    className="client-hit"
                    onClick={() => {
                      setName(c.name || '');
                      const digits = normalizePhoneDigits(c.phone_digits || c.phone);
                      if (digits) {
                        const fullPhone = String(c.phone || '');
                        const pref = PREFIX_OPTIONS.find((opt) => fullPhone.startsWith(opt.code));
                        if (pref) {
                          setPhonePrefix(pref.code);
                          setPhone(fullPhone.slice(pref.code.length).replace(/\D+/g, ''));
                        } else {
                          setPhone(digits);
                        }
                      }
                      setClientId(c.id || null);
                      const tc = String(c.tcode || '').trim();
                      if (tc) { setClientTcode(tc); setCodeRaw(tc); }
                      if (c.address) setAddressDesc(c.address);
                      if (c.gps_lat) setGpsLat(c.gps_lat);
                      if (c.gps_lng) setGpsLng(c.gps_lng);
                      setClientQuery('');
                    }}
                  >
                    <div style={{fontWeight:900}}>{String(c.tcode || '').trim() ? String(c.tcode).toUpperCase() : 'KLIENT'}</div>
                    <div style={{fontSize:13, opacity:.82}}>{c.name} • {c.phone}</div>
                    {(c.brought_by || Number(c.pieces || 0) > 0) ? (
                      <div style={{fontSize:11, opacity:.72}}>
                        {(displayTransportName(c.brought_by, transportUserNameMap, c.brought_by ? 'TRANSPORT' : 'TRANSPORT') || 'TRANSPORT') ? `🚚 ${displayTransportName(c.brought_by, transportUserNameMap, c.brought_by ? 'TRANSPORT' : 'TRANSPORT')}` : '🚚 TRANSPORT'}{Number(c.pieces || 0) > 0 ? ` • ${Number(c.pieces || 0)} copë` : ''}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {(name || phone || clientPhotoUrl || addressDesc) ? (
            <div className="client-selected-card">
              <div className="client-selected-main">
                {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini large" /> : <div className="client-avatar-fallback">👤</div>}
                <div className="client-selected-copy">
                  <div className="client-copy-topline">
                    <div className="client-code-pill">{normalizeTcode(clientTcode || codeRaw)}</div>
                    <button type="button" className="client-inline-edit" onClick={() => setShowAddClient(true)}>✎</button>
                  </div>
                  <div className="client-selected-name">{name || 'KLIENT I RI'}</div>
                  <div className="client-selected-phone">{String(phone || '').replace(/\D+/g, '') ? `${phonePrefix} ${String(phone || '').replace(/\D+/g, '')}` : 'PA TELEFON'}</div>
                  {addressDesc ? <div className="client-selected-address">📍 {addressDesc}</div> : null}
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(gpsLat || gpsLng) ? (
                      <>
                        <button type="button" className="btn secondary" onClick={() => window.open(`https://maps.google.com/?q=${gpsLat},${gpsLng}`, '_blank')} style={{ padding: '8px 14px', fontSize: 13, minHeight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(45,212,191,0.15)', color: '#2dd4bf', border: '1px solid rgba(45,212,191,0.3)', borderRadius: 12, fontWeight: 900 }}>
                          🗺️ HAP HARTËN
                        </button>
                        <button type="button" className="btn secondary" onClick={handleGetGPS} disabled={gpsLoading} style={{ padding: '8px 14px', fontSize: 13, minHeight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 12, fontWeight: 800 }}>
                          {gpsLoading ? '...' : '📍 NDRYSHO'}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn secondary" onClick={handleGetGPS} disabled={gpsLoading} style={{ padding: '8px 14px', fontSize: 13, minHeight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 12, fontWeight: 800 }}>
                        {gpsLoading ? 'DUKE MARRË...' : '📍 MERR GPS LOKAL'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {oldClientDebt > 0 && <div style={{ marginTop:12, padding:'10px 12px', borderRadius:12, background:'rgba(239,68,68,0.16)', border:'1px solid rgba(239,68,68,0.35)', color:'#fecaca', fontWeight:900, fontSize:12 }}>⚠️ KUJDES: KY KLIENT KA {oldClientDebt.toFixed(2)}€ BORXH TË VJETËR!</div>}

        </section>

        <section className="card">
          <h2 className="card-title">TEPIHA</h2>
          <div className="chip-row modern">
            {TEPIHA_CHIPS.map((v) => (
              <button key={v} type="button" className="chip chip-modern" onClick={() => applyChip('tepiha', v)} style={chipStyleForVal(v, activeChipKey === `tepiha:${Number(v)}`)}>
                {v.toFixed(1)}
              </button>
            ))}
          </div>
          {tepihaRows.map((row) => (
            <div className="piece-row" key={row.id}>
              <div className="row">
                <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" />
                <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="copë" />
                <label className="camera-btn">{row.photoUrl ? <img src={row.photoUrl} style={{width:'100%', height:'100%', borderRadius:12, objectFit:'cover'}} /> : '📷'}<input type="file" hidden accept="image/*" onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} /></label>
              </div>
            </div>
          ))}
          <div className="row btn-row">
            <button className="btn secondary" onClick={() => addRow('tepiha')}>+ RRESHT</button>
            <button className="btn secondary" onClick={() => removeRow('tepiha')}>− RRESHT</button>
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">STAZA</h2>
          <div className="chip-row modern">
            {STAZA_CHIPS.map((v) => (
              <button key={v} type="button" className="chip chip-modern" onClick={() => applyChip('staza', v)} style={chipStyleForVal(v, activeChipKey === `staza:${Number(v)}`)}>
                {v.toFixed(1)}
              </button>
            ))}
          </div>
          {stazaRows.map((row) => (
            <div className="piece-row" key={row.id}>
              <div className="row">
                <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" />
                <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="copë" />
                <label className="camera-btn">{row.photoUrl ? <img src={row.photoUrl} style={{width:'100%', height:'100%', borderRadius:12, objectFit:'cover'}} /> : '📷'}<input type="file" hidden accept="image/*" onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} /></label>
              </div>
            </div>
          ))}
          <div className="row btn-row">
            <button className="btn secondary" onClick={() => addRow('staza')}>+ RRESHT</button>
            <button className="btn secondary" onClick={() => removeRow('staza')}>− RRESHT</button>
          </div>
        </section>

        <section className="card">
          <div className="row util-row" style={{ gap: 10 }}>
            <button className="btn secondary" style={{ flex: 1 }} onClick={() => setShowStairsSheet(true)}>🪜 SHKALLORE</button>
            <button className="btn secondary" style={{ flex: 1 }} onClick={openPay}>€ PAGESA</button>
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn secondary" style={{ width: '100%' }} onClick={() => { setMsgKind('start'); setShowMsgSheet(true); }}>📩 DËRGO MESAZH — FILLON PASTRIMI</button>
          </div>
          <div className="tot-line">M² Total: <strong>{totalM2.toFixed(2)}</strong></div>
          <div className="tot-line">Copë: <strong>{copeCount}</strong></div>
          <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
          <div className="tot-line" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 10, paddingTop: 10 }}>Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
          <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>Regjistru n'ARKË: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong></div>
          {currentDebt > 0 && <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>}
          {currentChange > 0 && <div className="tot-line">Kthim: <strong style={{ color: '#2563eb' }}>{currentChange.toFixed(2)} €</strong></div>}
        </section>

        <section className="card">
          <h2 className="card-title">SHËNIME</h2>
          <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </section>

        <footer className="footer-bar">
          <button className="btn secondary" onClick={() => router.push('/transport/menu')}>↩ MENU</button>
          <button className="btn primary" onClick={handleContinue} disabled={photoUploading || savingContinue}>
            {savingContinue ? '⏳ DUKE RUJT...' : (isEdit ? '💾 RUAJ' : '💾 RUAJ / VAZHDO')}
          </button>
        </footer>

        {showAddClient && (
          <div className="modal-overlay" onClick={() => setShowAddClient(false)}>
            <div className="modal-content dark add-client-modal" onClick={(e) => e.stopPropagation()}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 12 }}>
                <div>
                  <div className="card-title" style={{ margin:0 }}>KLIENT I RI</div>
                  <div style={{ fontSize:12, opacity:.72, marginTop:4 }}>IDENTIKE ME BAZËN + T-CODE & ADRESË GPS</div>
                </div>
                <button className="btn secondary" style={{ padding:'10px 12px' }} onClick={() => setShowAddClient(false)}>✕</button>
              </div>

              <div className="field-group transport-tcode-focus">
                <label className="label">T-CODE</label>
                <input className="input tcodeInput" value={normalizeTcode(clientTcode || codeRaw)} readOnly disabled placeholder="T123" style={{ opacity: 0.7, cursor: 'not-allowed' }} />
              </div>

              <div className="field-group">
                <label className="label">EMRI & MBIEMRI</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="EMRI I KLIENTIT" />
              </div>

              <div className="field-group">
                <label className="label">TELEFONI</label>
                <div className="row">
                  <button type="button" className="prefixBtn" onClick={() => setShowPrefixSheet(true)}>{phonePrefix}</button>
                  <input className="input" value={phone} onChange={(e) => setPhone(String(e.target.value || '').replace(/\D+/g, ''))} inputMode="numeric" placeholder="44XXXXXX" />
                </div>
              </div>

              <div className="field-group">
                <label className="label">ADRESA</label>
                <textarea className="input" rows={4} value={addressDesc} onChange={(e) => setAddressDesc(e.target.value)} placeholder="PËRSHKRUAJ ADRESËN, HYRJEN, KATIN, OBORRIN..." />
              </div>

              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="label">LOKACIONI GPS</label>
                <button type="button" className={`gps-big-btn ${gpsSaved ? 'ok' : ''}`} onClick={handleGetGPS} disabled={gpsLoading}>
                  {gpsLoading ? 'Duke kërkuar...' : (gpsSaved || gpsLat ? '✅ Lokacioni u ruajt' : '📍 MERR LOKACIONIN (GPS)')}
                </button>
                {(gpsLat || gpsLng) ? <div style={{ fontSize:12, opacity:.78, marginTop:8 }}>GPS: {String(gpsLat || '')}{gpsLng ? ` • ${String(gpsLng)}` : ''}</div> : null}
              </div>

              <div style={{ display:'flex', gap:10, marginTop: 14 }}>
                <button type="button" className="btn secondary" style={{ flex:1 }} onClick={() => setShowAddClient(false)}>ANULO</button>
                <button type="button" className="btn primary" style={{ flex:1 }} onClick={saveClientQuick}>RUAJ KLIENTIN</button>
              </div>
            </div>
          </div>
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
          amount={payAdd}
          setAmount={setPayAdd}
          payChips={PAY_CHIPS}
          confirmText="KRYEJ PAGESËN"
          cancelText="ANULO"
          disabled={savingContinue}
          onConfirm={applyPayAndClose}
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
            <input type="number" className="input" value={priceTmp} onChange={e=>setPriceTmp(Number(e.target.value) || 0)} />
            <button className="btn primary" style={{marginTop:20, width:'100%'}} onClick={savePriceAndClose}>RUJ</button>
          </div>
        </div>
      )}
      {/* MESSAGE SHEET */}
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
                const smsHref = buildSmsLink(ph, txt);
                if (smsHref) window.open(smsHref, '_blank');
              }}>SMS</button>
            </div>
          </div>
        </div>
      )}
      <style jsx>{`
        .wrap { padding: 10px 10px 80px; max-width: 600px; margin: 0 auto; color: white; }

        .client-toolbar{ display:flex; gap:10px; margin-top:8px; }
        .icon-chip{ width:54px; height:54px; border:none; border-radius:999px; background:#f2f2f7; color:#111; display:flex; align-items:center; justify-content:center; font-size:28px; font-weight:900; box-shadow:0 10px 26px rgba(0,0,0,0.24); position:relative; }
        .header-icon-badge{ position:absolute; top:-4px; right:-4px; min-width:22px; height:22px; border-radius:999px; background:#ef4444; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:900; padding:0 6px; }
        .client-hits{ display:flex; flex-direction:column; gap:8px; margin-top:10px; }
        .client-hit{ text-align:left; padding:12px; border-radius:14px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.05); color:#fff; }
        .client-selected-card{ margin-top:12px; border-radius:18px; padding:14px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); }
        .client-selected-main{ display:flex; align-items:center; gap:12px; }
        .client-mini.large{ width:58px; height:58px; border-radius:999px; object-fit:cover; border:1px solid rgba(255,255,255,0.08); }
        .client-avatar-fallback{ width:58px; height:58px; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:24px; background:#222; }
        .client-selected-copy{ min-width:0; flex:1; }
        .client-copy-topline{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px; }
        .client-code-pill{ display:inline-flex; align-items:center; justify-content:center; min-height:28px; padding:0 12px; border-radius:999px; background:#16a34a; color:#fff; font-size:12px; font-weight:900; }
        .client-inline-edit{ border:none; background:transparent; color:#93c5fd; font-size:18px; }
        .client-selected-name{ font-size:18px; font-weight:900; line-height:1.15; }
        .client-selected-phone,.client-selected-address{ margin-top:4px; font-size:13px; opacity:.82; }
        .transport-extra-grid{ display:grid; grid-template-columns:1fr; gap:12px; margin-top:14px; }
        .transport-extra-card{ border:1px solid rgba(255,255,255,0.10); background:linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.03)); border-radius:18px; padding:14px; box-shadow:0 10px 24px rgba(0,0,0,0.18); }
        .transport-extra-label{ font-size:11px; font-weight:900; letter-spacing:1px; opacity:.68; margin-bottom:8px; }
        .transport-extra-value{ font-size:14px; font-weight:800; line-height:1.35; }
        .transport-code-hero{ font-size:26px; letter-spacing:1px; color:#7dd3fc; }
        .transport-extra-note{ margin-top:6px; font-size:11px; opacity:.62; line-height:1.35; }
        .transport-extra-actions{ display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
        .transport-gps-inline{ margin-top:8px; font-size:12px; opacity:.74; }
        .transport-tcode-focus .label{ color:#7dd3fc; }
        .tcodeInput{ font-size:22px; font-weight:900; letter-spacing:1px; text-transform:uppercase; color:#7dd3fc; }
        @media (min-width: 860px){ .transport-extra-grid{ grid-template-columns:1fr 1fr; } }
        .add-client-modal{ max-width:520px; }
        .prefixBtn{ min-width:92px; background:#222; border:1px solid #333; color:#fff; border-radius:12px; font-weight:800; }
        .gps-big-btn{ width:100%; min-height:54px; border:none; border-radius:14px; background:#1f2937; color:#fff; font-weight:900; font-size:15px; }
        .gps-big-btn.ok{ background:#166534; }
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
export default function PranimiPage() {
  return (
    <Suspense fallback={null}>
      <PranimiPageInner />
    </Suspense>
  );
}
