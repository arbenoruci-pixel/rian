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

// --- CHIP STYLE (APPLE STYLE UPDATE) ---
function chipStyleForVal(v, active) {
  const n = Number(v);
  
  // Apple Logic: Ngjyra pasteli (shumë të lehta) për sfond, dhe ngjyra të forta për tekst.
  // Pa border, vetëm hije të butë.
  
  let bg = '#eff6ff'; // Blueish default
  let txt = '#1d4ed8'; // Strong Blue

  if (n >= 5.8) { 
    // High value -> Orange/Red Warning
    bg = '#fff7ed'; txt = '#c2410c'; 
  } 
  else if (Math.abs(n - 3.2) < 0.051) { 
    // Specific value -> Redish
    bg = '#fef2f2'; txt = '#b91c1c'; 
  } 
  else if (n >= 3.5) { 
    // Pinkish
    bg = '#fdf2f8'; txt = '#be185d'; 
  } 
  else if (n >= 2.2) { 
    // Amber
    bg = '#fffbeb'; txt = '#b45309'; 
  } 
  else { 
    // Default Purple/Blue mix
    bg = '#f5f3ff'; txt = '#7c3aed';
  }

  // Nëse është aktiv, bëhet komplet solid me ngjyrën e fortë
  /* Kjo krijon efektin "iOS Toggle":
     Jo aktiv: Sfond i hapur, tekst i errët.
     Aktiv: Sfond i errët, tekst i bardhë, hije.
  */
  
  return {
    backgroundColor: active ? txt : bg,
    color: active ? '#ffffff' : txt,
    border: active ? `1px solid ${txt}` : '1px solid transparent', // No border when inactive for cleaner look
    fontWeight: '600',
    fontSize: '15px',
    padding: '12px 16px',
    borderRadius: '12px',
    boxShadow: active 
      ? `0 4px 12px ${txt}66` // Colored shadow when active
      : '0 2px 5px rgba(0,0,0,0.03)', // Subtle shadow when inactive
    transition: 'all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1)',
    transform: active ? 'scale(1.02)' : 'scale(1)',
  };
}

export default function TransportPranim() {
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get('id') || '';

  const [me, setMe] = useState(null);
  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');

  // Data
  const [name, setName] = useState('');
  const [phonePrefix, setPhonePrefix] = useState(PHONE_PREFIX_DEFAULT);
  const [phone, setPhone] = useState('');

  // KËRKO KLIENT (HISTORI)
  const [clientSearch, setClientSearch] = useState('');
  const [clientHits, setClientHits] = useState([]);
  const [clientSearching, setClientSearching] = useState(false);
  const [clientSearchErr, setClientSearchErr] = useState('');
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

  // DEBUG & Modals
  const [logs, setLogs] = useState([]);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);
  const [payAddRaw, setPayAddRaw] = useState('');
  const [drafts, setDrafts] = useState([]);

  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);
  const draftTimerRef = useRef(null);

  function addLog(msg) { setLogs(prev => [`> ${msg}`, ...prev]); console.log(`[DEBUG] ${msg}`); }

  // Init
  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) { router.push('/transport'); return; }
    setMe(s);
  }, [router]);

  useEffect(() => {
    if (!me?.transport_id) return;
    (async () => {
      try {
        refreshDrafts();
        if (editId) { setOid(editId); setCreating(false); return; }
        const id = crypto.randomUUID(); 
        setOid(id);
        const tcode = await reserveTransportCode();
        setCodeRaw(tcode);
        setCreating(false);
      } catch (e) { console.error(e); setCreating(false); }
    })();
  }, [me, editId]);

  useEffect(() => {
    if (creating || !oid) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
        const hasData = (name && name.length > 1) || (phone && phone.length > 3) || tepihaRows.length > 0;
        if (hasData) { saveDraftLocal(); }
    }, 1000);
    return () => clearTimeout(draftTimerRef.current);
  }); // Fixed dependency

  // SEARCH LOGIC
  useEffect(() => {
    const q = String(clientSearch || '').trim();
    if (!me?.transport_id) return;
    if (q.length < 2) { setClientHits([]); setClientSearchErr(''); setClientSearching(false); return; }
    let alive = true;
    setClientSearching(true);
    setClientSearchErr('');
    const t = setTimeout(async () => {
      try {
        const hits = await searchTransportClients(q);
        if (!alive) return;
        setClientHits(hits);
      } catch (e) { if (!alive) return; setClientHits([]); setClientSearchErr('GABIM NË KËRKIM'); } 
      finally { if (!alive) return; setClientSearching(false); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [clientSearch, me?.transport_id]);

  async function searchTransportClients(q) {
    const term = q.trim();
    const qLower = term.toLowerCase();
    const digits = term.replace(/\D/g, '');
    const looksLikeCode = qLower.startsWith('t') || /^[0-9]+$/.test(digits);
    const r1 = await supabase.from('transport_clients').select('id, full_name, phone').or(`full_name.ilike.%${term}%,phone.ilike.%${term}%`).limit(15);
    let r2;
    if (looksLikeCode) {
      const tCode = term.toUpperCase().startsWith('T') ? term.toUpperCase() : `T${digits || term}`;
      const codeN = Number(digits);
      const orParts = [`code_str.ilike.%${tCode}%`];
      if (Number.isFinite(codeN)) orParts.push(`code_n.eq.${codeN}`);
      r2 = await supabase.from('transport_orders').select('client_name, client_phone, code_str, code_n').or(orParts.join(',')).limit(15);
    } else {
      r2 = await supabase.from('transport_orders').select('client_name, client_phone, code_str, code_n').or(`client_name.ilike.%${term}%,client_phone.ilike.%${term}%`).limit(15);
    }
    const out = [];
    const seen = new Set();
    if (r1?.data?.length) { for (const c of r1.data) { const k = `${c.phone || ''}|${c.full_name || ''}`; if (seen.has(k)) continue; seen.add(k); out.push({ source: 'client', name: c.full_name || '', phone: c.phone || '' }); } }
    if (r2?.data?.length) { for (const o of r2.data) { const k = `${o.client_phone || ''}|${o.client_name || ''}`; if (seen.has(k)) continue; seen.add(k); out.push({ source: 'order', name: o.client_name || '', phone: o.client_phone || '', hint: o.code_str || '' }); } }
    return out.slice(0, 15);
  }

  function pickClient(hit) {
    const nm = String(hit?.name || '').trim();
    const ph = String(hit?.phone || '').trim();
    if (nm) setName(nm);
    if (ph) {
      const m = ph.match(/^(\+\d{3,4})\s*(.*)$/);
      if (m) { setPhonePrefix(m[1]); setPhone(String(m[2] || '').replace(/\s+/g, '')); } 
      else { setPhone(ph.replace(/\s+/g, '')); }
    }
    setClientSearch(''); setClientHits([]);
  }

  function refreshDrafts() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        const list = raw ? JSON.parse(raw) : [];
        list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        setDrafts(list);
    } catch {}
  }

  function saveDraftLocal() {
    try {
        const draft = { id: oid, ts: Date.now(), codeRaw, name, phone, phonePrefix, clientPhotoUrl, address, gpsLat, gpsLng, clientDesc, tepihaRows, stazaRows, stairsQty, stairsPer, stairsPhotoUrl, pricePerM2, clientPaid, notes };
        let list = [];
        try { list = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); } catch {}
        list = list.filter(d => d.id !== oid);
        list.unshift(draft);
        if (list.length > 50) list = list.slice(0, 50);
        localStorage.setItem(DRAFT_KEY, JSON.stringify(list));
        setDrafts(list);
    } catch {}
  }

  function loadDraft(d) {
      if(!confirm("A je i sigurt? Fushat aktuale do zëvendësohen.")) return;
      setOid(d.id); setCodeRaw(d.codeRaw); setName(d.name || ''); setPhone(d.phone || ''); setPhonePrefix(d.phonePrefix || PHONE_PREFIX_DEFAULT); setClientPhotoUrl(d.clientPhotoUrl || ''); setAddress(d.address || ''); setGpsLat(d.gpsLat || ''); setGpsLng(d.gpsLng || ''); setClientDesc(d.clientDesc || ''); setTepihaRows(d.tepihaRows || []); setStazaRows(d.stazaRows || []); setStairsQty(d.stairsQty || 0); setStairsPer(d.stairsPer || SHKALLORE_M2_PER_STEP_DEFAULT); setStairsPhotoUrl(d.stairsPhotoUrl || ''); setPricePerM2(d.pricePerM2 || PRICE_DEFAULT); setClientPaid(d.clientPaid || 0); setNotes(d.notes || ''); setShowDraftsSheet(false);
  }

  function deleteDraft(id) {
      if(!confirm("Fshi?")) return;
      let list = [];
      try { list = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); } catch {}
      list = list.filter(d => d.id !== id);
      localStorage.setItem(DRAFT_KEY, JSON.stringify(list));
      setDrafts(list);
  }

  // CALCS
  const totalM2 = useMemo(() => computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer), [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const totalEuro = useMemo(() => Number((totalM2 * parseNum(pricePerM2, 0)).toFixed(2)), [totalM2, pricePerM2]);
  const paidEuro = useMemo(() => parseNum(clientPaid, 0), [clientPaid]);
  const debt = useMemo(() => { const d = Number((totalEuro - paidEuro).toFixed(2)); return d > 0 ? d : 0; }, [totalEuro, paidEuro]);
  const currentChange = totalEuro - paidEuro < 0 ? Math.abs(totalEuro - paidEuro) : 0;
  const copeCount = useMemo(() => {
    const t = tepihaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const s = stazaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const sh = Number(stairsQty) > 0 ? 1 : 0;
    return t + s + sh;
  }, [tepihaRows, stazaRows, stairsQty]);

  function vibrateTap(ms = 15) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} }
  function bumpEl(el) { try { if (!el) return; el.classList.remove('chip-bump'); void el.offsetWidth; el.classList.add('chip-bump'); setTimeout(() => el.classList.remove('chip-bump'), 140); } catch {} }

  function addRow(kind) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; const prefix = kind === 'tepiha' ? 't' : 's'; setter((rows) => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '0', photoUrl: '' }]); }
  function removeRow(kind) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; setter((rows) => (rows.length ? rows.slice(0, -1) : rows)); }
  function handleRowChange(kind, id, field, value) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; setter((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: value } : r))); }

  async function handleRowPhotoChange(kind, id, file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, `${kind}_${id}`); if (url) handleRowChange(kind, id, 'photoUrl', url); } catch (e) { alert('❌ Gabim Foto'); } finally { setPhotoUploading(false); } }
  async function handleStairsPhotoChange(file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, 'shkallore'); if (url) setStairsPhotoUrl(url); } catch (e) { alert('❌ Gabim Foto'); } finally { setPhotoUploading(false); } }
  async function handleClientPhotoChange(file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, 'client'); if (url) setClientPhotoUrl(url); } catch (e) { alert('❌ Gabim Foto'); } finally { setPhotoUploading(false); } }
  
  function applyChip(kind, val, ev) {
    vibrateTap(15); if (ev?.currentTarget) bumpEl(ev.currentTarget);
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
    if (!rows || rows.length === 0) { const prefix = kind === 'tepiha' ? 't' : 's'; setter([{ id: `${prefix}1`, m2: String(val), qty: '1', photoUrl: '' }]); return; }
    const emptyIdx = rows.findIndex((r) => !r.m2);
    if (emptyIdx !== -1) { const nr = [...rows]; const curQty = String(nr[emptyIdx]?.qty ?? '').trim(); nr[emptyIdx] = { ...nr[emptyIdx], m2: String(val), qty: curQty && curQty !== '0' ? curQty : '1' }; setter(nr); } else { const prefix = kind === 'tepiha' ? 't' : 's'; setter([...rows, { id: `${prefix}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]); }
  }

  function getGps() { if (typeof navigator === 'undefined' || !navigator.geolocation) { alert('GPS s’mund të merret.'); return; } navigator.geolocation.getCurrentPosition((pos) => { setGpsLat(String(pos.coords.latitude)); setGpsLng(String(pos.coords.longitude)); alert('✅ GPS OK'); }, () => { alert('S’u mor GPS.'); }, { enableHighAccuracy: true, timeout: 8000 }); }

  function openPay() { const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2)); setPayAddRaw(dueNow > 0 ? String(dueNow.toFixed(2)) : ''); setShowPaySheet(true); }
  function applyPayAndClose() { const cashGiven = parseNum(payAddRaw, 0); if (!(cashGiven > 0)) { setShowPaySheet(false); return; } const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2))); const applied = Number(Math.min(cashGiven, due).toFixed(2)); setClientPaid(Number((Number(clientPaid || 0) + applied).toFixed(2))); setShowPaySheet(false); setPayAddRaw(''); }
  function startPayHold() { payHoldTriggeredRef.current = false; if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = setTimeout(() => { payHoldTriggeredRef.current = true; vibrateTap(25); setPriceTmp(Number(pricePerM2) || PRICE_DEFAULT); setShowPriceSheet(true); }, 1000); }
  function endPayHold() { if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = null; if (!payHoldTriggeredRef.current) openPay(); payHoldTriggeredRef.current = false; }
  function cancelPayHold() { if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = null; payHoldTriggeredRef.current = false; }

  function validate() {
    const ph = sanitizePhone(phonePrefix + phone);
    if (!ph || ph.length < 6) return alert('Telefoni jo valid!'), false;
    const allRows = [...(tepihaRows || []), ...(stazaRows || [])];
    for (const r of allRows) { const m2 = parseFloat(String(r.m2 || '0').replace(',', '.')) || 0; const q = parseInt(String(r.qty || '0'), 10) || 0; if (m2 > 0 && q <= 0) return alert('COPË duhet > 0'), false; }
    if (totalM2 <= 0) return alert('Shto të paktën 1 m².'), false;
    return true;
  }

  async function saveOrder() {
    addLog("--- START SAVE ---");
    if (!me?.transport_id) { alert("❌ Gabim Sesioni."); return; }
    if (!validate()) return;
    setSaving(true);
    let orderData = null;
    try {
      const codeStr = normalizeTCode(codeRaw); 
      const codeNum = Number(codeStr.replace(/\D+/g, '')) || 0; 
      const needsReview = !name.trim() || sanitizePhone(phonePrefix + phone).length < 6 || Number(totalM2 || 0) <= 0;
      orderData = {
        id: oid, code: codeNum, code_n: codeNum,
        scope: 'transport', transport_id: String(me.transport_id), transport_name: me.transport_name || me.transport_id,
        status: 'pickup', created_at: new Date().toISOString(),
        data: {
          scope: 'transport', transport_id: String(me.transport_id), transport_name: me.transport_name || me.transport_id,
          status: 'pickup', at_base: false, needs_review: needsReview, offloaded_at: null, offloaded_by: null,
          client: { name: name.trim(), phone: phonePrefix + (phone || ''), code: codeStr, photoUrl: clientPhotoUrl || '' },
          transport: { address: address || '', lat: gpsLat || '', lng: gpsLng || '', desc: clientDesc || '' },
          tepiha: tepihaRows.map((r) => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0), photoUrl: r.photoUrl || '' })),
          staza: stazaRows.map((r) => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0), photoUrl: r.photoUrl || '' })),
          shkallore: { qty: parseNum(stairsQty, 0), per: parseNum(stairsPer, SHKALLORE_M2_PER_STEP_DEFAULT), photoUrl: stairsPhotoUrl || '' },
          pay: { rate: parseNum(pricePerM2, 0), price: parseNum(pricePerM2, 0), m2: Number(totalM2) || 0, euro: Number(totalEuro) || 0, paid: Number(paidEuro) || 0, debt: Number(debt) || 0, method: 'CASH', },
          notes: notes || '',
        },
      };
      addLog("Sending to DB...");
      const res = await insertTransportOrder(orderData);
      if (!res?.ok) { throw new Error(res?.error || "Insert failed."); }
      await markTransportCodeUsed(codeStr);
      if (paidEuro > 0) { await recordCashMove({ amount: paidEuro, method: 'CASH', type: 'TRANSPORT', status: 'COLLECTED', order_id: orderData.id, order_code: codeStr, client_name: name.trim(), stage: 'PRANIMI', note: `TRANSPORT ${codeStr}`, created_by_pin: String(me.transport_id), created_by_name: me.transport_name || me.transport_id, approved_by_pin: null }); }
      deleteDraft(oid);
      router.push('/transport/offload');
    } catch (e) {
      addLog(`ERROR: ${e.message}`);
      const savedOffline = orderData ? saveOfflineTransportOrder({ ...orderData, saved_at: Date.now(), is_offline: true }) : false;
      if (savedOffline) { alert("⚠️ S'ka rrjet (Ose DB Error)! U ruajt LOKALISHT."); deleteDraft(oid); router.push('/transport/offload'); } 
      else { alert(`❌ DËSHTOI RUAJTJA!\n\n${e.message}`); }
    } finally { setSaving(false); }
  }

  if (creating) { return (<div className="ios-wrap"><div className="ios-header"><h1 className="ios-title">Transport</h1><span className="ios-sub">Duke u hapur...</span></div></div>); }

  return (
    <div className="ios-wrap">
      
      {/* HEADER: Clean Apple Style */}
      <div className="ios-header">
        <div className="ios-header-left">
          <h1 className="ios-title">Pranimi</h1>
          <div className="ios-sub">{me?.transport_name || 'Shofer'}</div>
        </div>
        <div className="ios-header-right">
          <div className="ios-badge-code">{normalizeTCode(codeRaw)}</div>
          <Link href="/transport/menu" className="ios-btn-text">Menu</Link>
        </div>
      </div>

      {/* DRAFTS NOTIFICATION */}
      <div style={{ padding: '0 20px 10px 20px' }}>
         <button className="ios-btn-glass" onClick={() => { refreshDrafts(); setShowDraftsSheet(true); }}>
            📝 Drafte të pa përfunduara {drafts.length > 0 ? `(${drafts.length})` : ''}
         </button>
      </div>

      {/* SECTION 1: KLIENTI */}
      <div className="ios-card">
        <h2 className="ios-card-title">Informatat e Klientit</h2>
        
        {/* Search Field */}
        <div className="ios-input-group">
          <div className="ios-input-row">
            <span className="ios-icon">🔍</span>
            <input 
               className="ios-input" 
               value={clientSearch}
               onChange={(e) => setClientSearch(e.target.value)}
               placeholder="Kërko (Emri, Tel, Kodi...)"
               inputMode="search"
            />
          </div>
        </div>
        
        {/* Results List */}
        {clientSearching && <div className="ios-hint">Duke kërkuar...</div>}
        {clientHits.length > 0 && (
          <div className="ios-results-list">
            {clientHits.map((h, idx) => (
              <div key={idx} className="ios-result-item" onClick={() => pickClient(h)}>
                <div style={{fontWeight: 600}}>{h.name || 'Pa Emër'}</div>
                <div style={{fontSize: 12, color:'#8e8e93'}}>{h.phone} {h.hint ? `• ${h.hint}` : ''}</div>
              </div>
            ))}
          </div>
        )}

        {/* Client Form */}
        <div className="ios-input-group" style={{marginTop: 15}}>
          <div className="ios-input-row">
            <label className="ios-label">Emri</label>
            <input className="ios-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shkruaj emrin" />
            <label className="ios-icon-btn">
               📷 <input type="file" style={{display:'none'}} onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} />
            </label>
          </div>
          {clientPhotoUrl && <div className="ios-img-preview"><img src={clientPhotoUrl} alt="Client" /> <button onClick={() => setClientPhotoUrl('')}>✕</button></div>}

          <div className="ios-divider" />

          <div className="ios-input-row">
            <label className="ios-label">Tel</label>
            <input className="ios-input small" value={phonePrefix} onChange={(e) => setPhonePrefix(e.target.value)} style={{width: 60}} />
            <input className="ios-input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="4x xxx xxx" type="tel" />
          </div>

          <div className="ios-divider" />

          <div className="ios-input-row">
            <label className="ios-label">Adresa</label>
            <input className="ios-input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Rruga, Nr..." />
            <button className="ios-btn-small" onClick={getGps}>📍 GPS</button>
          </div>
          {(gpsLat || gpsLng) && <div className="ios-hint" style={{paddingLeft: 16, paddingBottom: 8}}>GPS u ruajt</div>}

          <div className="ios-divider" />
          
          <div className="ios-input-row">
            <input className="ios-input" value={clientDesc} onChange={(e) => setClientDesc(e.target.value)} placeholder="Përshkrim shtesë (Kati, etj)..." />
          </div>
        </div>
      </div>

      {/* SECTION 2: TEPIHA (Chips Modern) */}
      <div className="ios-card">
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 12}}>
           <h2 className="ios-card-title" style={{marginBottom:0}}>Tepiha</h2>
           <span className="ios-count-badge">{tepihaRows.length} copa</span>
        </div>
        
        {/* CHIPS CONTAINER */}
        <div className="ios-chips-grid">
          {TEPIHA_CHIPS.map((v) => (
            <button 
              key={v} 
              type="button" 
              className="ios-chip"
              onClick={(e) => applyChip('tepiha', v, e)}
              style={chipStyleForVal(v, false)} // Use new logic
            >
              {v.toFixed(1)}
            </button>
          ))}
        </div>

        {/* ROWS LIST */}
        <div className="ios-rows-container">
          {tepihaRows.map((row) => (
             <div className="ios-row-item" key={row.id}>
                <div className="ios-row-inputs">
                   <div className="ios-input-wrap">
                      <span className="ios-input-tag">m²</span>
                      <input type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} />
                   </div>
                   <div className="ios-input-wrap">
                      <span className="ios-input-tag">Copë</span>
                      <input type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} />
                   </div>
                   <label className="ios-cam-btn">
                      📷 <input type="file" style={{display:'none'}} onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} />
                   </label>
                </div>
                {row.photoUrl && <div className="ios-row-img"><img src={row.photoUrl} alt="" /><button onClick={() => handleRowChange('tepiha', row.id, 'photoUrl', '')}>✕ Fshi</button></div>}
             </div>
          ))}
        </div>

        <div className="ios-actions-row">
           <button className="ios-btn-outline" onClick={() => addRow('tepiha')}>+ Shto Rresht</button>
           {tepihaRows.length > 0 && <button className="ios-btn-outline destr" onClick={() => removeRow('tepiha')}>− Hiq</button>}
        </div>
      </div>

      {/* SECTION 3: STAZA */}
      <div className="ios-card">
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 12}}>
           <h2 className="ios-card-title" style={{marginBottom:0}}>Staza</h2>
           <span className="ios-count-badge">{stazaRows.length} copa</span>
        </div>

        <div className="ios-chips-grid">
          {STAZA_CHIPS.map((v) => (
            <button key={v} type="button" className="ios-chip" onClick={(e) => applyChip('staza', v, e)} style={chipStyleForVal(v, false)}>
              {v.toFixed(1)}
            </button>
          ))}
        </div>

        <div className="ios-rows-container">
          {stazaRows.map((row) => (
             <div className="ios-row-item" key={row.id}>
                <div className="ios-row-inputs">
                   <div className="ios-input-wrap">
                      <span className="ios-input-tag">m²</span>
                      <input type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} />
                   </div>
                   <div className="ios-input-wrap">
                      <span className="ios-input-tag">Copë</span>
                      <input type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} />
                   </div>
                   <label className="ios-cam-btn">
                      📷 <input type="file" style={{display:'none'}} onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} />
                   </label>
                </div>
                {row.photoUrl && <div className="ios-row-img"><img src={row.photoUrl} alt="" /><button onClick={() => handleRowChange('staza', row.id, 'photoUrl', '')}>✕ Fshi</button></div>}
             </div>
          ))}
        </div>
        <div className="ios-actions-row">
           <button className="ios-btn-outline" onClick={() => addRow('staza')}>+ Shto Rresht</button>
           {stazaRows.length > 0 && <button className="ios-btn-outline destr" onClick={() => removeRow('staza')}>− Hiq</button>}
        </div>
      </div>

      {/* SECTION 4: ACTIONS & TOTALS */}
      <div className="ios-card">
        <div className="ios-grid-2">
           <button className="ios-big-btn" onClick={() => setShowStairsSheet(true)}>
             <span className="icon">🪜</span>
             <span>Shkallore</span>
           </button>
           <button 
             className="ios-big-btn money" 
             onMouseDown={startPayHold} onMouseUp={endPayHold} onMouseLeave={cancelPayHold} 
             onTouchStart={(e) => startPayHold()} onTouchEnd={(e) => { e.preventDefault(); endPayHold(); }}
           >
             <span className="icon">💶</span>
             <span>Pagesa</span>
           </button>
        </div>

        <div className="ios-totals">
           <div className="ios-total-row"><span>M² Total</span> <strong>{totalM2}</strong></div>
           <div className="ios-total-row"><span>Totali (€)</span> <strong>{totalEuro.toFixed(2)} €</strong></div>
           <div className="ios-total-row pay"><span>Paguar</span> <strong>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
           {debt > 0 && <div className="ios-total-row debt"><span>Borxh</span> <strong>{debt.toFixed(2)} €</strong></div>}
           {currentChange > 0 && <div className="ios-total-row change"><span>Kthim Kusuri</span> <strong>{currentChange.toFixed(2)} €</strong></div>}
        </div>
      </div>

      <div className="ios-card">
         <h2 className="ios-card-title">Shënime</h2>
         <textarea className="ios-textarea" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shkruaj shënime këtu..." />
      </div>

      {/* FOOTER BAR (Floating) */}
      <div className="ios-bottom-bar">
         <button className="ios-btn-secondary" onClick={() => router.push('/')}>Anulo</button>
         <button className="ios-btn-primary" onClick={saveOrder} disabled={saving || photoUploading}>
            {saving ? 'Duke ruajtur...' : 'RUAJ POROSINË'}
         </button>
      </div>

      <div style={{height: 100}}></div>

      {/* MODALS (Apple Sheets) */}
      
      {/* 1. PAY SHEET */}
      {showPaySheet && (
        <div className="ios-sheet-overlay">
           <div className="ios-sheet">
              <div className="ios-sheet-header">
                 <h3>Pagesa</h3>
                 <button onClick={() => setShowPaySheet(false)}>Mbyll</button>
              </div>
              <div className="ios-sheet-body">
                 <div className="ios-stat-big">
                    <span className="lbl">Për të paguar</span>
                    <span className="val">{parseNum(payAddRaw, 0).toFixed(2)} €</span>
                 </div>
                 <div className="ios-input-group">
                    <input type="number" className="ios-input-big" value={payAddRaw} onChange={(e) => setPayAddRaw(e.target.value)} placeholder="0.00" />
                 </div>
                 <div className="ios-chips-grid">
                    {PAY_CHIPS.map(v => (
                       <button key={v} className="ios-chip simple" onClick={() => setPayAddRaw(String(v))}>{v}€</button>
                    ))}
                    <button className="ios-chip destr" onClick={() => setPayAddRaw('')}>Fshi</button>
                 </div>
                 <button className="ios-btn-primary full" onClick={applyPayAndClose} style={{marginTop: 20}}>Konfirmo Pagesën</button>
              </div>
           </div>
        </div>
      )}

      {/* 2. PRICE SHEET */}
      {showPriceSheet && (
         <div className="ios-sheet-overlay">
            <div className="ios-sheet">
               <div className="ios-sheet-header"><h3>Ndrysho Çmimin</h3><button onClick={() => setShowPriceSheet(false)}>Mbyll</button></div>
               <div className="ios-sheet-body">
                  <div className="ios-input-group">
                     <div className="ios-input-row">
                        <label className="ios-label">Çmimi (€/m²)</label>
                        <input type="number" className="ios-input" value={priceTmp} onChange={(e) => setPriceTmp(e.target.value)} />
                     </div>
                  </div>
                  <button className="ios-btn-primary full" onClick={() => { setPricePerM2(priceTmp); setShowPriceSheet(false); }} style={{marginTop:20}}>Ruaj Çmimin</button>
               </div>
            </div>
         </div>
      )}

      {/* 3. STAIRS SHEET */}
      {showStairsSheet && (
         <div className="ios-sheet-overlay">
            <div className="ios-sheet">
               <div className="ios-sheet-header"><h3>Shkallore</h3><button onClick={() => setShowStairsSheet(false)}>Mbyll</button></div>
               <div className="ios-sheet-body">
                  <h4 className="ios-section-head">Sasia (Copë)</h4>
                  <div className="ios-chips-grid">
                     {SHKALLORE_QTY_CHIPS.map(n => (
                        <button key={n} className="ios-chip simple" style={Number(stairsQty) === n ? {background:'#007AFF', color:'white'} : {}} onClick={() => setStairsQty(n)}>{n}</button>
                     ))}
                  </div>
                  <input type="number" className="ios-input-box" value={stairsQty === 0 ? '' : stairsQty} onChange={(e) => setStairsQty(e.target.value)} placeholder="Manual..." />

                  <h4 className="ios-section-head" style={{marginTop:20}}>Sipërfaqja (m² për shkallë)</h4>
                  <div className="ios-chips-grid">
                     {SHKALLORE_PER_CHIPS.map(v => (
                        <button key={v} className="ios-chip simple" style={Number(stairsPer) === v ? {background:'#007AFF', color:'white'} : {}} onClick={() => setStairsPer(v)}>{v}</button>
                     ))}
                  </div>
                  <input type="number" className="ios-input-box" value={stairsPer} onChange={(e) => setStairsPer(e.target.value)} placeholder="Manual..." />

                  <div style={{marginTop: 20}}>
                     <label className="ios-btn-outline full">
                        📷 Shto Foto Shkalloreve
                        <input type="file" style={{display:'none'}} onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} />
                     </label>
                     {stairsPhotoUrl && <div className="ios-img-preview" style={{marginTop:10}}><img src={stairsPhotoUrl} alt="" /><button onClick={() => setStairsPhotoUrl('')}>Fshi</button></div>}
                  </div>
               </div>
            </div>
         </div>
      )}

      {/* 4. DRAFTS SHEET */}
      {showDraftsSheet && (
         <div className="ios-sheet-overlay">
            <div className="ios-sheet full">
               <div className="ios-sheet-header"><h3>Drafte</h3><button onClick={() => setShowDraftsSheet(false)}>Mbyll</button></div>
               <div className="ios-sheet-body scrollable">
                  {drafts.length === 0 ? <p style={{textAlign:'center', color:'#999', padding:20}}>S'ka drafte të ruajtura.</p> : (
                     <div className="ios-list">
                        {drafts.map(d => (
                           <div className="ios-list-item" key={d.id}>
                              <div className="content">
                                 <div className="title">{normalizeTCode(d.codeRaw)}</div>
                                 <div className="sub">{d.name || 'Pa Emër'} • {d.phone || '-'}</div>
                                 <div className="date">{new Date(d.ts).toLocaleString()}</div>
                              </div>
                              <div className="actions">
                                 <button className="ios-btn-small blue" onClick={() => loadDraft(d)}>Hap</button>
                                 <button className="ios-btn-small red" onClick={() => deleteDraft(d.id)}>Fshi</button>
                              </div>
                           </div>
                        ))}
                     </div>
                  )}
               </div>
            </div>
         </div>
      )}

      {/* --- APPLE STYLE CSS --- */}
      <style jsx>{`
        /* GLOBAL WRAP */
        .ios-wrap {
           background-color: #F2F2F7; /* iOS System Gray 6 */
           min-height: 100vh;
           font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
           padding: 20px 16px;
           color: #1c1c1e;
        }

        /* HEADER */
        .ios-header { display: flex; justify-content: space-between; alignItems: center; padding: 10px 4px 20px 4px; }
        .ios-title { font-size: 34px; font-weight: 800; letter-spacing: -0.5px; margin: 0; color: #000; }
        .ios-sub { font-size: 15px; color: #8e8e93; font-weight: 500; }
        .ios-header-right { text-align: right; }
        .ios-badge-code { background: #e5e5ea; color: #1c1c1e; padding: 4px 10px; border-radius: 8px; font-weight: 700; font-size: 13px; margin-bottom: 4px; display: inline-block; }
        .ios-btn-text { color: #007AFF; font-size: 15px; text-decoration: none; }
        .ios-btn-glass { background: rgba(255,255,255,0.6); backdrop-filter: blur(10px); border: none; padding: 10px 20px; border-radius: 20px; color: #007AFF; font-weight: 600; width: 100%; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }

        /* CARDS */
        .ios-card {
           background: #ffffff;
           border-radius: 16px;
           padding: 20px;
           margin-bottom: 20px;
           box-shadow: 0 2px 10px rgba(0,0,0,0.03);
        }
        .ios-card-title { font-size: 20px; font-weight: 700; margin: 0 0 16px 0; color: #1c1c1e; }
        
        /* INPUT GROUPS (iOS List Style) */
        .ios-input-group { background: #fff; border-radius: 12px; border: 1px solid #e5e5ea; overflow: hidden; }
        .ios-input-row { display: flex; align-items: center; padding: 12px 16px; min-height: 50px; }
        .ios-label { width: 70px; font-size: 16px; font-weight: 500; color: #000; }
        .ios-input { flex: 1; border: none; font-size: 17px; outline: none; background: transparent; color: #000; }
        .ios-input::placeholder { color: #c7c7cc; }
        .ios-icon { margin-right: 10px; font-size: 18px; color: #8e8e93; }
        .ios-divider { height: 1px; background: #e5e5ea; margin-left: 16px; }
        
        /* RESULTS */
        .ios-results-list { background: #fff; border-radius: 12px; margin-top: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .ios-result-item { padding: 12px 16px; border-bottom: 1px solid #f2f2f7; cursor: pointer; }
        .ios-result-item:active { background: #f2f2f7; }

        /* CHIPS GRID */
        .ios-chips-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
        .ios-chip { cursor: pointer; border: none; font-family: inherit; }
        .ios-chip:active { transform: scale(0.96); }
        .ios-chip.simple { background: #f2f2f7; color: #1c1c1e; padding: 10px 18px; border-radius: 20px; font-weight: 600; font-size: 15px; transition: background 0.2s; }
        .ios-chip.destr { background: #fff1f2; color: #e11d48; }

        /* ROW ITEMS */
        .ios-rows-container { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
        .ios-row-item { background: #f9f9f9; border-radius: 12px; padding: 12px; border: 1px solid #f0f0f0; }
        .ios-row-inputs { display: flex; gap: 10px; align-items: center; }
        .ios-input-wrap { flex: 1; display: flex; flex-direction: column; }
        .ios-input-tag { font-size: 10px; color: #8e8e93; text-transform: uppercase; font-weight: 600; margin-bottom: 2px; }
        .ios-input-wrap input { background: #fff; border: 1px solid #e5e5ea; border-radius: 8px; padding: 8px; font-size: 16px; outline: none; width: 100%; -webkit-appearance: none; }
        .ios-input-wrap input:focus { border-color: #007AFF; }
        .ios-cam-btn { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; background: #eef2ff; border-radius: 8px; cursor: pointer; font-size: 18px; }
        .ios-row-img { margin-top: 10px; display: flex; gap: 10px; align-items: center; }
        .ios-row-img img { width: 50px; height: 50px; border-radius: 6px; object-fit: cover; }
        .ios-row-img button { background: none; border: none; color: #e11d48; font-size: 12px; font-weight: 600; }

        /* BUTTONS */
        .ios-btn-small { background: #e5e5ea; color: #000; border: none; padding: 6px 12px; border-radius: 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .ios-btn-small.blue { background: #eef2ff; color: #007AFF; }
        .ios-btn-small.red { background: #fff1f2; color: #e11d48; }
        .ios-btn-outline { background: transparent; border: 1px dashed #c7c7cc; color: #007AFF; padding: 12px; border-radius: 12px; width: 100%; font-weight: 600; cursor: pointer; }
        .ios-btn-outline.destr { border-color: #fca5a5; color: #e11d48; margin-top: 8px; }
        .ios-actions-row { margin-top: 10px; }

        .ios-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
        .ios-big-btn { background: #f2f2f7; border: none; padding: 16px; border-radius: 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; font-weight: 600; color: #1c1c1e; font-size: 15px; }
        .ios-big-btn .icon { font-size: 24px; }
        .ios-big-btn:active { background: #e5e5ea; }
        .ios-big-btn.money { background: #ecfdf5; color: #047857; }
        .ios-big-btn.money:active { background: #d1fae5; }

        /* TOTALS */
        .ios-totals { display: flex; flex-direction: column; gap: 8px; }
        .ios-total-row { display: flex; justify-content: space-between; font-size: 15px; color: #3a3a3c; }
        .ios-total-row strong { font-weight: 700; color: #000; }
        .ios-total-row.pay strong { color: #34c759; }
        .ios-total-row.debt strong { color: #ff3b30; }
        .ios-total-row.change strong { color: #007AFF; }

        .ios-textarea { width: 100%; border: 1px solid #e5e5ea; border-radius: 12px; padding: 12px; font-family: inherit; font-size: 16px; outline: none; background: #f9f9f9; }

        /* BOTTOM BAR */
        .ios-bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(255,255,255,0.85); backdrop-filter: blur(20px); border-top: 1px solid rgba(0,0,0,0.1); padding: 12px 20px 30px 20px; display: flex; gap: 12px; z-index: 1000; }
        .ios-btn-primary { flex: 2; background: #007AFF; color: white; border: none; padding: 14px; border-radius: 14px; font-size: 16px; font-weight: 700; box-shadow: 0 4px 12px rgba(0,122,255,0.3); transition: transform 0.1s; }
        .ios-btn-primary:active { transform: scale(0.98); }
        .ios-btn-primary:disabled { opacity: 0.6; }
        .ios-btn-secondary { flex: 1; background: #f2f2f7; color: #1c1c1e; border: none; padding: 14px; border-radius: 14px; font-size: 16px; font-weight: 600; }

        /* SHEETS (MODALS) */
        .ios-sheet-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 2000; display: flex; align-items: flex-end; }
        .ios-sheet { background: #fff; width: 100%; border-top-left-radius: 20px; border-top-right-radius: 20px; padding-bottom: 40px; max-height: 90vh; display: flex; flex-direction: column; animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
        .ios-sheet.full { height: 90vh; }
        .ios-sheet-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #f2f2f7; }
        .ios-sheet-header h3 { margin: 0; font-size: 18px; }
        .ios-sheet-header button { background: none; border: none; color: #007AFF; font-size: 16px; font-weight: 600; }
        .ios-sheet-body { padding: 20px; overflow-y: auto; }
        .ios-stat-big { text-align: center; margin-bottom: 20px; }
        .ios-stat-big .lbl { display: block; color: #8e8e93; font-size: 13px; text-transform: uppercase; }
        .ios-stat-big .val { font-size: 36px; font-weight: 800; color: #000; }
        .ios-input-big { font-size: 32px; text-align: center; width: 100%; border: none; outline: none; font-weight: 700; color: #007AFF; margin-bottom: 20px; }
        .ios-btn-primary.full { width: 100%; }
        .ios-input-box { width: 100%; padding: 12px; background: #f2f2f7; border-radius: 10px; border: none; font-size: 16px; margin-top: 10px; }
        .ios-section-head { margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; color: #8e8e93; }

        /* LIST VIEW IN SHEET */
        .ios-list { display: flex; flex-direction: column; }
        .ios-list-item { padding: 12px 0; border-bottom: 1px solid #f2f2f7; display: flex; justify-content: space-between; align-items: center; }
        .ios-list-item .title { font-weight: 700; font-size: 16px; }
        .ios-list-item .sub { font-size: 13px; color: #8e8e93; }
        .ios-list-item .date { font-size: 11px; color: #c7c7cc; }
        .ios-list-item .actions { display: flex; gap: 6px; }

        .ios-count-badge { background: #e5e5ea; color: #8e8e93; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
        
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>
    </div>
  );
}
