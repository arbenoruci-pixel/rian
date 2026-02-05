'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';
import { reserveTransportCode, markTransportCodeUsed } from '@/lib/transportCodes';
import { insertTransportOrder, saveOfflineTransportOrder } from '@/lib/transport/transportDb'; // ✅ Importi i saktë
import { recordCashMove } from '@/lib/arkaCashSync';

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
const DRAFT_KEY = 'transport_drafts_v1'; // Çelësi për draftet lokale

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
  let bg = 'rgba(39, 39, 42, 1)'; 
  let border = 'rgba(63, 63, 70, 0.5)';
  let text = '#e4e4e7';
  if (active) { bg = 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'; border = 'transparent'; text = '#ffffff'; } 
  else {
    if (n >= 5.8) { border = 'rgba(249,115,22,0.4)'; text = '#fdba74'; } 
    else if (Math.abs(n - 3.2) < 0.051) { border = 'rgba(239,68,68,0.4)'; text = '#fca5a5'; } 
    else if (n >= 3.5) { border = 'rgba(236,72,153,0.4)'; text = '#f9a8d4'; } 
    else if (n >= 2.2) { border = 'rgba(245,158,11,0.4)'; text = '#fcd34d'; } 
  }
  return { background: bg, border: `1px solid ${border}`, color: text, boxShadow: active ? '0 4px 12px rgba(37, 99, 235, 0.4)' : 'none', transform: active ? 'scale(1.05)' : 'scale(1)' };
}

// --- MAIN COMPONENT ---
export default function TransportPranim() {
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get('id') || '';

  const [me, setMe] = useState(null);
  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');

  // Data States
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
  const [saveIncomplete, setSaveIncomplete] = useState(false);

  // Modals
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false); // ✅ Drafts Modal
  
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);
  const [payAdd, setPayAdd] = useState(0);
  const [drafts, setDrafts] = useState([]); // ✅ Drafts List

  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);
  const draftTimerRef = useRef(null);

  // Auth & Init
  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) { router.push('/transport'); return; }
    setMe(s);
  }, [router]);

  useEffect(() => {
    if (!me?.transport_id) return;
    (async () => {
      try {
        refreshDrafts(); // Load drafts on start
        if (editId) { setOid(editId); setCreating(false); return; }
        const id = `tord_${Date.now()}`;
        setOid(id);
        const tcode = await reserveTransportCode();
        setCodeRaw(tcode);
        setCreating(false);
      } catch (e) { console.error(e); setCreating(false); }
    })();
  }, [me, editId]);

  // ✅ AUTO-SAVE DRAFTS LOGIC
  useEffect(() => {
    if (creating || !oid) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);

    draftTimerRef.current = setTimeout(() => {
        // Ruaj vetëm nëse ka diçka të shkruar
        const hasData = name || phone || address || tepihaRows.length > 0;
        if (hasData) {
            saveDraftLocal();
        }
    }, 1000); // Ruaj çdo 1 sekond pasi ndalon së shkruari

    return () => clearTimeout(draftTimerRef.current);
  });

  // Calculations
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

  // Helpers UI
  function vibrateTap(ms = 15) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} }
  function bumpEl(el) { try { if (!el) return; el.classList.remove('chip-bump'); void el.offsetWidth; el.classList.add('chip-bump'); setTimeout(() => el.classList.remove('chip-bump'), 140); } catch {} }

  // --- DRAFTS FUNCTIONS ---
  function refreshDrafts() {
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        const list = raw ? JSON.parse(raw) : [];
        // Sort by newest
        list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        setDrafts(list);
    } catch {}
  }

  function saveDraftLocal() {
    try {
        const draft = {
            id: oid,
            ts: Date.now(),
            codeRaw,
            name, phone, phonePrefix, clientPhotoUrl,
            address, gpsLat, gpsLng, clientDesc,
            tepihaRows, stazaRows,
            stairsQty, stairsPer, stairsPhotoUrl,
            pricePerM2, clientPaid, notes
        };
        
        let list = [];
        try { list = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); } catch {}
        
        // Remove existing version of this draft
        list = list.filter(d => d.id !== oid);
        // Add updated version to top
        list.unshift(draft);
        // Keep only last 50 drafts
        if (list.length > 50) list = list.slice(0, 50);

        localStorage.setItem(DRAFT_KEY, JSON.stringify(list));
        setDrafts(list);
    } catch {}
  }

  function loadDraft(d) {
      if(!confirm("A je i sigurt? Kjo do të zëvendësojë fushat aktuale.")) return;
      setOid(d.id);
      setCodeRaw(d.codeRaw);
      setName(d.name || '');
      setPhone(d.phone || '');
      setPhonePrefix(d.phonePrefix || PHONE_PREFIX_DEFAULT);
      setClientPhotoUrl(d.clientPhotoUrl || '');
      setAddress(d.address || '');
      setGpsLat(d.gpsLat || '');
      setGpsLng(d.gpsLng || '');
      setClientDesc(d.clientDesc || '');
      setTepihaRows(d.tepihaRows || []);
      setStazaRows(d.stazaRows || []);
      setStairsQty(d.stairsQty || 0);
      setStairsPer(d.stairsPer || SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl(d.stairsPhotoUrl || '');
      setPricePerM2(d.pricePerM2 || PRICE_DEFAULT);
      setClientPaid(d.clientPaid || 0);
      setNotes(d.notes || '');
      setShowDraftsSheet(false);
  }

  function deleteDraft(id) {
      if(!confirm("A je i sigurt që do ta fshish?")) return;
      let list = [];
      try { list = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]'); } catch {}
      list = list.filter(d => d.id !== id);
      localStorage.setItem(DRAFT_KEY, JSON.stringify(list));
      setDrafts(list);
  }

  // Rows Logic
  function addRow(kind) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; const prefix = kind === 'tepiha' ? 't' : 's'; setter((rows) => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '0', photoUrl: '' }]); }
  function removeRow(kind) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; setter((rows) => (rows.length ? rows.slice(0, -1) : rows)); }
  function handleRowChange(kind, id, field, value) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; setter((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: value } : r))); }

  // Photos
  async function handleRowPhotoChange(kind, id, file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, `${kind}_${id}`); if (url) handleRowChange(kind, id, 'photoUrl', url); } catch (e) { alert('❌ Gabim Foto: ' + e.message); } finally { setPhotoUploading(false); } }
  async function handleStairsPhotoChange(file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, 'shkallore'); if (url) setStairsPhotoUrl(url); } catch (e) { alert('❌ Gabim Foto: ' + e.message); } finally { setPhotoUploading(false); } }
  async function handleClientPhotoChange(file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, 'client'); if (url) setClientPhotoUrl(url); } catch (e) { alert('❌ Gabim Foto: ' + e.message); } finally { setPhotoUploading(false); } }

  function applyChip(kind, val, ev) {
    vibrateTap(15);
    if (ev?.currentTarget) bumpEl(ev.currentTarget);
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
    if (!rows || rows.length === 0) { const prefix = kind === 'tepiha' ? 't' : 's'; setter([{ id: `${prefix}1`, m2: String(val), qty: '1', photoUrl: '' }]); return; }
    const emptyIdx = rows.findIndex((r) => !r.m2);
    if (emptyIdx !== -1) { const nr = [...rows]; const curQty = String(nr[emptyIdx]?.qty ?? '').trim(); nr[emptyIdx] = { ...nr[emptyIdx], m2: String(val), qty: curQty && curQty !== '0' ? curQty : '1' }; setter(nr); } 
    else { const prefix = kind === 'tepiha' ? 't' : 's'; setter([...rows, { id: `${prefix}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]); }
  }

  function getGps() { if (typeof navigator === 'undefined' || !navigator.geolocation) { alert('GPS s’mund të merret.'); return; } navigator.geolocation.getCurrentPosition((pos) => { setGpsLat(String(pos.coords.latitude)); setGpsLng(String(pos.coords.longitude)); alert('✅ GPS OK'); }, () => alert('S’u mor GPS. Lejo Location.'), { enableHighAccuracy: true, timeout: 8000 }); }

  function openPay() { const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2)); setPayAdd(dueNow > 0 ? dueNow : 0); setShowPaySheet(true); }
  function applyPayAndClose() { const cashGiven = Number((Number(payAdd) || 0).toFixed(2)); if (cashGiven <= 0) { setShowPaySheet(false); return; } const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2))); const applied = Number(Math.min(cashGiven, due).toFixed(2)); setClientPaid(Number((Number(clientPaid || 0) + applied).toFixed(2))); setShowPaySheet(false); }
  function startPayHold() { payHoldTriggeredRef.current = false; if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = setTimeout(() => { payHoldTriggeredRef.current = true; vibrateTap(25); setPriceTmp(Number(pricePerM2) || PRICE_DEFAULT); setShowPriceSheet(true); }, 1000); }
  function endPayHold() { if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = null; if (!payHoldTriggeredRef.current) openPay(); payHoldTriggeredRef.current = false; }
  function cancelPayHold() { if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = null; payHoldTriggeredRef.current = false; }

  function validate() {
    if (saveIncomplete) return true;
    if (!name.trim()) return alert('Shkruaj emrin dhe mbiemrin.'), false;
    const ph = sanitizePhone(phonePrefix + phone);
    if (!ph || ph.length < 6) return alert('Shkruaj një numër telefoni të vlefshëm.'), false;
    const allRows = [...(tepihaRows || []), ...(stazaRows || [])];
    for (const r of allRows) { const m2 = parseFloat(String(r.m2 || '0').replace(',', '.')) || 0; const q = parseInt(String(r.qty || '0'), 10) || 0; if (m2 > 0 && q <= 0) return alert('COPË duhet me qenë > 0 për çdo rresht që ka m².'), false; }
    if (totalM2 <= 0) return alert('Shto të paktën 1 m².'), false;
    return true;
  }

  // --- SAVE LOGIC ---
  async function saveOrder() {
    if (!me?.transport_id) { alert("❌ Gabim Sesioni: Identifikohu prapë."); return; }
    if (!validate()) return;
    setSaving(true);

    try {
      const codeStr = normalizeTCode(codeRaw); 
      const codeNum = Number(codeStr.replace(/\D+/g, '')) || 0; 
      
      const orderData = {
        id: oid,
        code: codeNum, 
        code_n: codeNum,
        scope: 'transport', transport_id: String(me.transport_id), transport_name: me.transport_name || me.transport_id,
        status: saveIncomplete ? 'transport_incomplete' : 'pastrim',
        created_at: new Date().toISOString(),
        data: {
          scope: 'transport', transport_id: String(me.transport_id), transport_name: me.transport_name || me.transport_id,
          status: saveIncomplete ? 'transport_incomplete' : 'pastrim',
          client: { name: name.trim(), phone: phonePrefix + (phone || ''), code: codeStr, photoUrl: clientPhotoUrl || '' },
          transport: { address: address || '', lat: gpsLat || '', lng: gpsLng || '', desc: clientDesc || '' },
          tepiha: tepihaRows.map((r) => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0), photoUrl: r.photoUrl || '' })),
          staza: stazaRows.map((r) => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0), photoUrl: r.photoUrl || '' })),
          shkallore: { qty: parseNum(stairsQty, 0), per: parseNum(stairsPer, SHKALLORE_M2_PER_STEP_DEFAULT), photoUrl: stairsPhotoUrl || '' },
          pay: { price: parseNum(pricePerM2, 0), m2: Number(totalM2) || 0, euro: Number(totalEuro) || 0, paid: Number(paidEuro) || 0, debt: Number(debt) || 0, method: 'CASH' },
          notes: notes || '',
        },
      };

      // 1. Provo ONLINE
      const res = await insertTransportOrder(orderData);
      
      if (!res?.ok) {
        throw new Error(res?.error || "Insert failed.");
      }

      await markTransportCodeUsed(codeStr);
      if (paidEuro > 0) { await recordCashMove({ amount: paidEuro, method: 'CASH', type: 'TRANSPORT', status: 'COLLECTED', order_id: orderData.id, order_code: codeStr, client_name: name.trim(), stage: 'PRANIMI', note: `TRANSPORT ${codeStr}`, created_by_pin: String(me.transport_id), created_by_name: me.transport_name || me.transport_id, approved_by_pin: null }); }
      
      // ✅ Fshi draftin pasi u ruajt me sukses
      deleteDraft(oid);

      if (saveIncomplete) router.push('/transport/te-pa-plotsuara'); else router.push(`/pastrimi?id=${orderData.id}`);
    } catch (e) {
      console.error("Online failed, trying local...", e);
      // ✅ RUAJTJE OFFLINE NËSE DËSHTON INTERNETI
      const savedOffline = saveOfflineTransportOrder({ ...orderData, saved_at: Date.now(), is_offline: true });
      if (savedOffline) {
        alert("⚠️ S'ka rrjet! Porosia u ruajt LOKALISHT. Mos harro ta bësh Sync më vonë.");
        deleteDraft(oid); // E fshijmë nga draftet se kaloi në Offline Queue
        router.push('/transport/te-pa-plotsuara');
      } else {
        alert(`❌ DËSHTOI RUAJTJA!\n\n${e.message || JSON.stringify(e)}`);
      }
    } finally { setSaving(false); }
  }

  if (creating) { return (<div className="wrap"><header className="header-row"><div><h1 className="title">TRANSPORT</h1><div className="subtitle">DUKE HAPUR...</div></div></header><section className="card"><div className="muted">Duke gjeneruar kodin T...</div></section></div>); }

  return (
    <div className="wrap">
      <header className="header-glass">
        <div><h1 className="title-lg">TRANSPORT</h1><div className="subtitle-sm">{me?.transport_name || 'SHOFER'}</div></div>
        <div className="flex flex-col items-end gap-2">
             <Link className="menu-btn" href="/transport/menu">MENU</Link>
             <div className="code-badge">{normalizeTCode(codeRaw)}</div>
        </div>
      </header>

      {/* ✅ BUTTON TE PA PLOTSUARAT */}
      <section style={{marginTop: 8, marginBottom: 12}}>
        <button type="button" className="w-full bg-zinc-800 text-gray-300 py-3 rounded-xl border border-zinc-700 font-bold text-sm shadow-md" onClick={() => { refreshDrafts(); setShowDraftsSheet(true); }}>
            📝 TË PA PLOTSUARAT {drafts.length > 0 ? `(${drafts.length})` : ''}
        </button>
      </section>

      <section className="glass-card">
        <div className="card-header"><h2 className="card-title">KLIENTI</h2><label className="checkbox-label"><input type="checkbox" checked={saveIncomplete} onChange={(e) => setSaveIncomplete(e.target.checked)} /><span className="ml-2">E PA PLOTSUAR</span></label></div>
        <div className="form-group"><div className="input-row"><input className="input-modern flex-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Emri Mbiemri" /><label className="icon-btn-lg relative">{clientPhotoUrl ? <img src={clientPhotoUrl} className="w-full h-full object-cover rounded-full border border-green-500" alt="" /> : '📷'}<input type="file" accept="image/*" hidden onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} /></label></div>{clientPhotoUrl && <button className="text-xs text-red-400 mt-1 text-right w-full" onClick={() => setClientPhotoUrl('')}>Fshi Foton</button>}</div>
        <div className="form-group mt-3"><div className="input-row"><input className="input-modern w-20 text-center" value={phonePrefix} onChange={(e) => setPhonePrefix(e.target.value)} /><input className="input-modern flex-1" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="4x xxx xxx" /></div></div>
        <div className="divider" />
        <div className="form-group"><div className="input-row"><input className="input-modern flex-1" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Adresa / Rruga" /><button type="button" className="action-btn-sm" onClick={getGps}>📍 GPS</button></div>{(gpsLat || gpsLng) && <div className="text-xs text-green-500 mt-1 font-mono text-right">{gpsLat.slice(0,7)}, {gpsLng.slice(0,7)}</div>}</div>
        <div className="form-group mt-2"><textarea className="input-modern min-h-[50px]" value={clientDesc} onChange={(e) => setClientDesc(e.target.value)} placeholder="Përshkrim (Kati, Hyrja...)" /></div>
      </section>

      <section className="glass-card">
        <h2 className="card-title">TEPIHA</h2>
        <div className="chips-container">{TEPIHA_CHIPS.map((v) => ( <button key={v} type="button" className="chip-modern" onClick={(e) => applyChip('tepiha', v, e)} style={chipStyleForVal(v, false)}>{v.toFixed(1)}</button> ))}</div>
        <div className="rows-container">{tepihaRows.map((row) => ( <div className="row-item" key={row.id}><input className="input-qty w-20" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" /><input className="input-qty w-16" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="Copë" /><div className="flex-1 flex justify-end gap-2"><label className="icon-btn-sm relative">{row.photoUrl ? <div className="w-full h-full bg-green-500 rounded-full" /> : '📷'}<input type="file" accept="image/*" hidden onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} /></label>{row.photoUrl && <button className="text-xs text-red-400" onClick={() => handleRowChange('tepiha', row.id, 'photoUrl', '')}>🗑️</button>}</div></div> ))}</div>
        <div className="row-actions"><button className="add-btn" onClick={() => addRow('tepiha')}>+ SHTO</button><button className="remove-btn" onClick={() => removeRow('tepiha')}>- HIQ</button></div>
      </section>

      <section className="glass-card">
        <h2 className="card-title">STAZA</h2>
        <div className="chips-container">{STAZA_CHIPS.map((v) => ( <button key={v} type="button" className="chip-modern" onClick={(e) => applyChip('staza', v, e)} style={chipStyleForVal(v, false)}>{v.toFixed(1)}</button> ))}</div>
        <div className="rows-container">{stazaRows.map((row) => ( <div className="row-item" key={row.id}><input className="input-qty w-20" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" /><input className="input-qty w-16" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="Copë" /><div className="flex-1 flex justify-end gap-2"><label className="icon-btn-sm relative">{row.photoUrl ? <div className="w-full h-full bg-green-500 rounded-full" /> : '📷'}<input type="file" accept="image/*" hidden onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} /></label>{row.photoUrl && <button className="text-xs text-red-400" onClick={() => handleRowChange('staza', row.id, 'photoUrl', '')}>🗑️</button>}</div></div> ))}</div>
        <div className="row-actions"><button className="add-btn" onClick={() => addRow('staza')}>+ SHTO</button><button className="remove-btn" onClick={() => removeRow('staza')}>- HIQ</button></div>
      </section>

      <section className="glass-card summary-card">
        <div className="flex gap-2 mb-4"><button className="util-btn" onClick={() => setShowStairsSheet(true)}>🪜 SHKALLORE</button><button className="util-btn pay-btn-trigger" onMouseDown={startPayHold} onMouseUp={endPayHold} onMouseLeave={cancelPayHold} onTouchStart={startPayHold} onTouchEnd={(e) => { e.preventDefault(); endPayHold(); }}>€ PAGESA</button></div>
        <div className="summary-row"><span>M² Total:</span> <span className="text-white">{totalM2}</span></div><div className="summary-row"><span>Copë:</span> <span className="text-white">{copeCount}</span></div><div className="summary-row text-lg"><span>Total:</span> <span className="text-blue-400 font-bold">{totalEuro.toFixed(2)} €</span></div><div className="summary-divider" /><div className="summary-row"><span>Paguar:</span> <span className="text-green-500">{paidEuro.toFixed(2)} €</span></div>{debt > 0 && <div className="summary-row"><span>Borxh:</span> <span className="text-red-500 font-bold">{debt.toFixed(2)} €</span></div>}{currentChange > 0 && <div className="summary-row"><span>Kthim:</span> <span className="text-blue-500">{currentChange.toFixed(2)} €</span></div>}
      </section>

      <section className="glass-card"><h2 className="card-title">SHËNIME</h2><textarea className="input-modern min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="..." /></section>
      <div style={{height: 100}} /> 
      <footer className="footer-glass"><button className="footer-btn secondary" onClick={() => router.push('/')}>🏠 HOME</button><button className="footer-btn primary" onClick={saveOrder} disabled={saving || photoUploading}>{saving ? '⏳...' : (photoUploading ? '📷...' : 'RUAJ')}</button></footer>

      {/* --- MODALS --- */}
      {showPaySheet && (<div className="sheet-overlay"><div className="sheet-content"><div className="sheet-header"><h2>PAGESA</h2><button onClick={() => setShowPaySheet(false)}>✕</button></div><div className="sheet-body"><div className="text-center mb-6"><div className="text-3xl font-bold text-white mb-1">{totalEuro.toFixed(2)} €</div><div className="text-sm text-gray-400">Totali i Porosisë</div></div><div className="mb-4"><label className="text-xs text-gray-500 block mb-1">KLIENTI DHA (€)</label><input type="number" className="input-modern text-center text-2xl font-bold" value={payAdd || ''} onChange={(e) => setPayAdd(Number(e.target.value))} placeholder="0" /></div><div className="grid grid-cols-5 gap-2 mb-6">{PAY_CHIPS.map(v => (<button key={v} onClick={() => setPayAdd(v)} className="bg-zinc-800 p-2 rounded-lg text-sm font-bold border border-zinc-700 active:bg-blue-600 transition">{v}</button>))}</div><button className="w-full bg-blue-600 py-4 rounded-xl font-bold text-white text-lg shadow-lg active:scale-95 transition" onClick={applyPayAndClose}>KONFIRMO</button></div></div></div>)}
      {showPriceSheet && (<div className="sheet-overlay"><div className="sheet-content"><div className="sheet-header"><h2>NDËRRO QMIMIN</h2><button onClick={() => setShowPriceSheet(false)}>✕</button></div><div className="sheet-body p-4"><input type="number" step="0.1" className="input-modern text-center text-3xl h-16" value={priceTmp} onChange={(e) => setPriceTmp(Number(e.target.value))} /><button className="w-full bg-blue-600 mt-4 py-3 rounded-xl font-bold" onClick={() => {setPricePerM2(priceTmp); setShowPriceSheet(false);}}>RUAJ</button></div></div></div>)}
      {showStairsSheet && (<div className="sheet-overlay"><div className="sheet-content"><div className="sheet-header"><h2>SHKALLORE</h2><button onClick={() => setShowStairsSheet(false)}>✕</button></div><div className="sheet-body p-4 overflow-y-auto max-h-[70vh]"><div className="mb-4"><label className="text-gray-400 text-xs mb-2 block">COPË</label><div className="flex flex-wrap gap-2 mb-2">{SHKALLORE_QTY_CHIPS.map(n => <button key={n} onClick={() => setStairsQty(n)} className={`p-2 rounded border ${stairsQty === n ? 'bg-blue-600 border-blue-500' : 'bg-zinc-800 border-zinc-700'}`}>{n}</button>)}</div><input type="number" className="input-modern" value={stairsQty || ''} onChange={(e) => setStairsQty(Number(e.target.value))} /></div><div className="mb-4"><label className="text-gray-400 text-xs mb-2 block">M² / COPË</label><div className="flex flex-wrap gap-2 mb-2">{SHKALLORE_PER_CHIPS.map(n => <button key={n} onClick={() => setStairsPer(n)} className={`p-2 rounded border ${stairsPer === n ? 'bg-blue-600 border-blue-500' : 'bg-zinc-800 border-zinc-700'}`}>{n}</button>)}</div><input type="number" className="input-modern" value={stairsPer} onChange={(e) => setStairsPer(Number(e.target.value))} /></div><div className="mb-4"><label className="icon-btn-lg w-full flex justify-center items-center gap-2 bg-zinc-800"><span>📷 SHTO FOTO</span><input type="file" hidden onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} /></label>{stairsPhotoUrl && <div className="text-center text-green-500 text-xs mt-2">Foto u ngarkua!</div>}</div><button className="w-full bg-blue-600 py-3 rounded-xl font-bold" onClick={() => setShowStairsSheet(false)}>RUAJ</button></div></div></div>)}

      {/* ✅ DRAFTS MODAL */}
      {showDraftsSheet && (
        <div className="sheet-overlay">
          <div className="sheet-content h-[90vh]">
            <div className="sheet-header"><h2>TË PA PLOTSUARAT</h2><button onClick={() => setShowDraftsSheet(false)}>✕</button></div>
            <div className="sheet-body p-4 overflow-y-auto max-h-[80vh]">
                {drafts.length === 0 ? <div className="text-center text-gray-500 mt-10">S'ka asgjë të ruajtur.</div> : drafts.map(d => (
                    <div key={d.id} className="glass-card flex justify-between items-center mb-2">
                        <div>
                            <div className="text-white font-bold">{normalizeTCode(d.codeRaw)}</div>
                            <div className="text-xs text-gray-400">{d.name || 'Pa Emër'} • {d.phone || '-'}</div>
                            <div className="text-xs text-gray-500 mt-1">{new Date(d.ts).toLocaleString()}</div>
                        </div>
                        <div className="flex gap-2">
                            <button className="bg-blue-600 px-3 py-1 rounded text-xs font-bold text-white" onClick={() => loadDraft(d)}>HAP</button>
                            <button className="bg-red-600 px-3 py-1 rounded text-xs font-bold text-white" onClick={() => deleteDraft(d.id)}>FSHI</button>
                        </div>
                    </div>
                ))}
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        body { background-color: #09090b; color: #e4e4e7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-tap-highlight-color: transparent; }
        .wrap { padding: 80px 16px 120px 16px; max-width: 600px; margin: 0 auto; }
        .header-glass { position: fixed; top: 0; left: 0; right: 0; z-index: 50; background: rgba(9, 9, 11, 0.85); backdrop-filter: blur(16px); border-bottom: 1px solid rgba(255,255,255,0.08); padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
        .title-lg { font-size: 18px; font-weight: 900; letter-spacing: -0.5px; color: #fff; line-height: 1; }
        .subtitle-sm { font-size: 11px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
        .menu-btn { font-size: 10px; font-weight: 700; background: #27272a; padding: 4px 10px; border-radius: 99px; border: 1px solid #3f3f46; color: #fff; }
        .code-badge { background: #2563eb; color: #fff; font-size: 12px; font-weight: 800; padding: 2px 8px; border-radius: 6px; }
        .glass-card { background: #18181b; border: 1px solid #27272a; border-radius: 20px; padding: 16px; margin-bottom: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .card-title { font-size: 13px; font-weight: 800; color: #71717a; letter-spacing: 1px; }
        .checkbox-label { display: flex; align-items: center; font-size: 11px; font-weight: 700; color: #f59e0b; cursor: pointer; }
        .input-row { display: flex; gap: 10px; align-items: center; }
        .input-modern { background: #09090b; border: 1px solid #27272a; color: #fff; padding: 12px; border-radius: 12px; font-size: 15px; font-weight: 500; outline: none; transition: all 0.2s; width: 100%; }
        .input-modern:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
        .icon-btn-lg { width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; background: #27272a; border-radius: 12px; cursor: pointer; border: 1px solid #3f3f46; font-size: 20px; }
        .icon-btn-sm { width: 42px; height: 42px; display: flex; align-items: center; justify-content: center; background: #27272a; border-radius: 10px; cursor: pointer; border: 1px solid #3f3f46; }
        .chips-container { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
        .chip-modern { padding: 10px 16px; border-radius: 14px; font-weight: 700; font-size: 14px; transition: all 0.15s ease; flex-grow: 1; text-align: center; }
        .chip-bump { animation: bump 0.2s ease; }
        @keyframes bump { 50% { transform: scale(0.95); } }
        .rows-container { display: flex; flex-col; gap: 10px; }
        .row-item { display: flex; gap: 10px; align-items: center; padding-bottom: 10px; border-bottom: 1px dashed #27272a; }
        .row-item:last-child { border-bottom: none; }
        .input-qty { background: #09090b; border: 1px solid #27272a; color: #fff; padding: 10px; border-radius: 10px; text-align: center; font-weight: 700; outline: none; }
        .input-qty:focus { border-color: #3b82f6; }
        .row-actions { display: flex; gap: 10px; margin-top: 12px; }
        .add-btn { flex: 2; background: #27272a; color: #fff; padding: 10px; border-radius: 12px; font-weight: 700; font-size: 12px; border: 1px solid #3f3f46; }
        .remove-btn { flex: 1; background: #27272a; color: #ef4444; padding: 10px; border-radius: 12px; font-weight: 700; font-size: 12px; border: 1px solid #3f3f46; }
        .divider { height: 1px; background: #27272a; margin: 16px 0; }
        .summary-card { border: 1px solid #3b82f6; background: rgba(30, 58, 138, 0.1); }
        .util-btn { flex: 1; background: #1e3a8a; color: #bfdbfe; padding: 12px; border-radius: 12px; font-weight: 700; font-size: 13px; border: 1px solid #2563eb; }
        .pay-btn-trigger { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: white; border: none; box-shadow: 0 4px 12px rgba(37,99,235,0.3); }
        .summary-row { display: flex; justify-content: space-between; font-size: 14px; color: #a1a1aa; margin-bottom: 6px; font-weight: 500; }
        .summary-divider { height: 1px; background: rgba(255,255,255,0.1); margin: 10px 0; }
        .footer-glass { position: fixed; bottom: 20px; left: 16px; right: 16px; max-width: 568px; margin: 0 auto; background: rgba(24, 24, 27, 0.9); backdrop-filter: blur(12px); padding: 8px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); display: flex; gap: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); z-index: 50; }
        .footer-btn { flex: 1; padding: 14px; border-radius: 14px; font-weight: 800; font-size: 14px; transition: transform 0.1s; }
        .footer-btn:active { transform: scale(0.96); }
        .footer-btn.secondary { background: #27272a; color: #a1a1aa; flex: 0.4; }
        .footer-btn.primary { background: linear-gradient(to right, #2563eb, #3b82f6); color: white; box-shadow: 0 4px 15px rgba(37,99,235,0.4); }
        .sheet-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 100; display: flex; align-items: flex-end; }
        .sheet-content { width: 100%; background: #18181b; border-radius: 24px 24px 0 0; border-top: 1px solid #27272a; animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1); }
        .sheet-header { display: flex; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #27272a; }
        .sheet-header h2 { font-weight: 800; font-size: 16px; color: #fff; }
        .sheet-body { padding: 20px; }
        .action-btn-sm { font-size: 12px; font-weight: 700; background: #27272a; color: #a1a1aa; padding: 10px; border-radius: 10px; border: 1px solid #3f3f46; white-space: nowrap; }
        @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>
    </div>
  );
}
