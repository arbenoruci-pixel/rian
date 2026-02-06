"use client";

import {
  computeM2FromRows,
  normalizeCode,
  reserveSharedCode,
  markCodeUsed,
  releaseLocksForCode,
} from '@/lib/tepihaCode';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { fetchOrdersFromDb, fetchClientsFromDb, saveOrderToDb } from '@/lib/ordersDb';
import { recordCashMove } from '@/lib/arkaCashSync';
import { getActor } from '@/lib/actorSession';

const BUCKET = 'tepiha-photos';

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];

// SHKALLORE CHIPS
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];

const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;

// PAGESA CHIPS
const PAY_CHIPS = [5, 10, 20, 30, 50];

const DAILY_CAPACITY_M2 = 400;

// Draft keys
const DRAFT_LIST_KEY = 'draft_orders_v1';
const DRAFT_ITEM_PREFIX = 'draft_order_';

// company contact
const COMPANY_PHONE_DISPLAY = '+383 44 735 312';

// settings keys
const AUTO_MSG_KEY = 'pranimi_auto_msg_after_save';
const PRICE_KEY = 'pranimi_price_per_m2';

// OFFLINE safety
const OFFLINE_MODE_KEY = 'tepiha_offline_mode_v1';
const OFFLINE_QUEUE_KEY = 'tepiha_offline_queue_v1';

// Remote folders
const DRAFTS_FOLDER = 'drafts';
const SETTINGS_FOLDER = 'settings';

// ---------------- HELPERS ----------------
function sanitizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

function normDigits(s) {
  return String(s || '').replace(/\D+/g, '');
}

async function searchClientsLive(q) {
  const qq = String(q || '').trim();
  if (!qq) return [];

  const qDigits = normDigits(qq);
  const qText = qq.toLowerCase();

  let query = supabase
    .from('clients')
    .select('id, code, full_name, first_name, last_name, phone, photo_url, updated_at')
    .order('updated_at', { ascending: false })
    .limit(15);

  if (qDigits) {
    query = query.or(
      `code.eq.${Number(qDigits)},phone.ilike.%${qDigits}%,first_name.ilike.%${qText}%,last_name.ilike.%${qText}%`
    );
  } else {
    query = query.or(`first_name.ilike.%${qText}%,last_name.ilike.%${qText}%,phone.ilike.%${qText}%`);
  }

  const { data: clients, error } = await query;
  if (error) throw error;

  const list = Array.isArray(clients) ? clients : [];
  if (!list.length) return [];

  // ... (pjesa e mbetur e search logic - e pandryshuar për thjeshtësi)
  return list.map((c) => {
    const full = c.full_name || `${c.first_name||''} ${c.last_name||''}`;
    return {
      code: String(c.code||''),
      name: full || 'Pa Emër',
      phone: String(c.phone||'').replace('+383', ''),
    };
  });
}
 
async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, cacheControl: '0' });
  if (error) throw error;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

function chipStyleForVal(v, active) {
  const n = Number(v);
  let a = 'rgba(59,130,246,0.18)', b = 'rgba(59,130,246,0.06)', br = 'rgba(59,130,246,0.35)';
  if (n >= 5.8) { a = 'rgba(249,115,22,0.20)'; b = 'rgba(249,115,22,0.08)'; br = 'rgba(249,115,22,0.38)'; } 
  else if (Math.abs(n - 3.2) < 0.051) { a = 'rgba(239,68,68,0.20)'; b = 'rgba(239,68,68,0.08)'; br = 'rgba(239,68,68,0.38)'; } 
  else if (n >= 3.5) { a = 'rgba(236,72,153,0.18)'; b = 'rgba(236,72,153,0.06)'; br = 'rgba(236,72,153,0.35)'; } 
  else if (n >= 2.2) { a = 'rgba(245,158,11,0.18)'; b = 'rgba(245,158,11,0.06)'; br = 'rgba(245,158,11,0.35)'; } 
  else { a = 'rgba(168,85,247,0.18)'; b = 'rgba(168,85,247,0.06)'; br = 'rgba(168,85,247,0.35)'; }
  return { background: `linear-gradient(180deg, ${a}, ${b})`, border: `1px solid ${br}`, outline: active ? '2px solid rgba(255,255,255,0.22)' : 'none' };
}

// ... (Draft helpers omitted for brevity, logic remains same) ...
function safeJsonParse(s, f) { try { return JSON.parse(s); } catch { return f; } }
function loadDraftIds() { return safeJsonParse(localStorage.getItem(DRAFT_LIST_KEY) || '[]', []); }
function saveDraftIds(ids) { localStorage.setItem(DRAFT_LIST_KEY, JSON.stringify(ids)); }
function upsertDraftLocal(d) { 
    if(!d?.id) return; localStorage.setItem(`${DRAFT_ITEM_PREFIX}${d.id}`, JSON.stringify(d)); 
    const ids = loadDraftIds(); if(!ids.includes(d.id)) { ids.unshift(d.id); saveDraftIds(ids); }
}
function removeDraftLocal(id) { localStorage.removeItem(`${DRAFT_ITEM_PREFIX}${id}`); saveDraftIds(loadDraftIds().filter(x=>x!==id)); }
function readAllDraftsLocal() { return loadDraftIds().map(id => safeJsonParse(localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`), null)).filter(Boolean).sort((a,b)=>b.ts-a.ts); }

// ---------- SETTINGS REMOTE (SHARED PRICE) ----------
async function readSharedPrice() {
  try {
    const { data } = await supabase.storage.from(BUCKET).download(`${SETTINGS_FOLDER}/price.json`);
    if (data) { const j = JSON.parse(await data.text()); if (Number(j?.pricePerM2)>0) return Number(j.pricePerM2); }
  } catch {}
  return null;
}
async function writeSharedPrice(v) {
  const blob = new Blob([JSON.stringify({ pricePerM2: v, at: new Date().toISOString() })], { type: 'application/json' });
  await supabase.storage.from(BUCKET).upload(`${SETTINGS_FOLDER}/price.json`, blob, { upsert: true, cacheControl: '0' });
}

// ---------------- COMPONENT ----------------
export default function PranimiPage() {
  const router = useRouter();
  const phonePrefix = '+383';

  // --- SMART DEBUG STATE ---
  const [logs, setLogs] = useState([]);
  
  function addLog(msg) {
      const t = new Date().toLocaleTimeString();
      setLogs(prev => [`[${t}] ${msg}`, ...prev]);
      console.log(`[DEBUG] ${msg}`);
  }

  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [savingContinue, setSavingContinue] = useState(false);

  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');

  // drafts UI
  const [drafts, setDrafts] = useState([]);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false);

  // client
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');

  // client search
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);

  // rows
  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);

  // shkallore
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');

  // pay
  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [arkaRecordedPaid, setArkaRecordedPaid] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');

  // sheets
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showMsgSheet, setShowMsgSheet] = useState(false);
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);

  // settings
  const [autoMsgAfterSave, setAutoMsgAfterSave] = useState(true);
  const [pendingNavTo, setPendingNavTo] = useState('');
  const [payAdd, setPayAdd] = useState(0);
  const [notes, setNotes] = useState('');

  // offline
  const [offlineMode, setOfflineMode] = useState(false);
  const [netState, setNetState] = useState({ ok: true, reason: '' });
  const [showOfflinePrompt, setShowOfflinePrompt] = useState(false);

  const RESET_ON_SHOW_KEY = 'tepiha_pranimi_reset_on_show_v1';

  async function resetForNewOrder() {
    try {
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `ord_${Date.now()}`;
      setOid(id);
      addLog("Duke rezervuar kodin e ri...");
      const c = await reserveSharedCode(id);
      setCodeRaw(c);
      addLog(`Kodi u rezervua: ${c}`);

      setName(''); setPhone(''); setClientPhotoUrl(''); setClientQuery(''); setClientHits([]);
      setTepihaRows([]); setStazaRows([]);
      setStairsQty(0); setStairsPer(SHKALLORE_M2_PER_STEP_DEFAULT); setStairsPhotoUrl('');
      setClientPaid(0); setArkaRecordedPaid(0); setPayMethod('CASH'); setNotes('');
      setSavingContinue(false); setPhotoUploading(false);
    } catch (e) {
        addLog("Reset Error: " + e.message);
    }
  }

  // --- INIT ---
  useEffect(() => {
    (async () => {
        addLog("Duke inicializuar Pranimin...");
        const initOff = localStorage.getItem(OFFLINE_MODE_KEY) === '1';
        setOfflineMode(initOff);
        
        try {
            const shared = await readSharedPrice();
            if (shared) setPricePerM2(shared);
        } catch {}

        await resetForNewOrder();
        setCreating(false);
    })();
  }, []);

  // --- CALC ---
  const totalM2 = useMemo(() => computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer), [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const diff = useMemo(() => Number((totalEuro - Number(clientPaid || 0)).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;
  const currentChange = diff < 0 ? Math.abs(diff) : 0;
  const copeCount = useMemo(() => {
    return tepihaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0) +
           stazaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0) +
           (Number(stairsQty) > 0 ? 1 : 0);
  }, [tepihaRows, stazaRows, stairsQty]);

  // --- AUTOSAVE DRAFT ---
  const draftTimer = useRef(null);
  useEffect(() => {
    if (creating || !oid) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
        const hasData = name || phone || tepihaRows.length > 0;
        if(hasData) upsertDraftLocal({ id: oid, codeRaw, name, phone, tepihaRows, stazaRows, stairsQty, pricePerM2, clientPaid });
    }, 1000);
    return () => clearTimeout(draftTimer.current);
  }, [name, phone, tepihaRows, stazaRows, stairsQty, clientPaid, oid]);

  // --- ACTIONS ---
  function addRow(kind) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; const prefix = kind === 'tepiha' ? 't' : 's'; setter(rows => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '0', photoUrl: '' }]); }
  function removeRow(kind) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; setter(rows => (rows.length ? rows.slice(0, -1) : rows)); }
  function handleRowChange(kind, id, field, value) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; setter(rows => rows.map(r => (r.id === id ? { ...r, [field]: value } : r))); }
  
  function applyChip(kind, val) {
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
      if (!rows.length) { setter([{ id: `${kind[0]}1`, m2: String(val), qty: '1', photoUrl: '' }]); return; }
      const emptyIdx = rows.findIndex(r => !r.m2);
      if (emptyIdx !== -1) { const nr = [...rows]; nr[emptyIdx] = { ...nr[emptyIdx], m2: String(val), qty: '1' }; setter(nr); }
      else { setter([...rows, { id: `${kind[0]}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]); }
  }

  // --- VALIDATION & SAVE ---
  function validateBeforeContinue() {
    if (!name.trim()) return alert('Shkruaj emrin!'), false;
    if (!phone.trim() || phone.length < 3) return alert('Shkruaj telefonin!'), false;
    if (totalM2 <= 0) return alert('Shto të paktën 1 m².'), false;
    return true;
  }

  async function handleContinue() {
    addLog("--- START PROCESI VAZHDO ---");
    
    if (!validateBeforeContinue()) {
        addLog("Dështoi validimi i të dhënave.");
        return;
    }

    if (savingContinue) return;
    setSavingContinue(true);
    addLog("Duke përgatitur objektin e porosisë...");

    try {
      const order = {
        id: oid,
        ts: Date.now(),
        status: 'pastrim',
        client: { name: name.trim(), phone: phonePrefix + (phone || ''), code: normalizeCode(codeRaw), photoUrl: clientPhotoUrl || '' },
        tepiha: tepihaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: { m2: totalM2, rate: Number(pricePerM2) || PRICE_DEFAULT, euro: totalEuro, paid: Number(clientPaid) || 0, debt: currentDebt, method: payMethod, arkaRecordedPaid: Number(arkaRecordedPaid) || 0 },
        notes: notes || '',
      };

      addLog(`Objekti gati. Code: ${order.client.code}, Phone: ${order.client.phone}`);

      // 1. OFFLINE CHECK
      if (offlineMode) {
          addLog("Offline Mode AKTIV. Duke ruajtur lokalisht...");
          // saveOfflineQueueItem(order);
          alert('✅ U RUAJT OFFLINE.');
          setSavingContinue(false);
          return;
      }

      // 2. DB SAVE
      addLog("Duke thirrur saveOrderToDb...");
      const db = await saveOrderToDb(order);
      
      if (db && db.order_id) {
          addLog(`✅ SUKSES! DB ID: ${db.order_id}, Client ID: ${db.client_id}`);
      } else {
          addLog("⚠️ Paralajmërim: DB nuk ktheu order_id, por as error.");
      }

      // 3. FINALIZE
      addLog("Duke shënuar kodin si të përdorur...");
      try { await markCodeUsed(codeRaw, oid); } catch(e) { addLog("Code Mark Error: " + e.message); }

      // 4. CLEANUP
      addLog("Duke fshirë draftet dhe duke pastruar...");
      try { removeDraftLocal(oid); } catch {}

      if (autoMsgAfterSave) {
        addLog("Hapja e dritares së mesazhit...");
        setPendingNavTo('/pastrimi');
        setShowMsgSheet(true);
        setSavingContinue(false);
        return;
      }

      router.push('/pastrimi');

    } catch (e) {
      // ✅ SMART LOGGING PËR GABIMIN
      const errMsg = e.message || JSON.stringify(e);
      addLog(`❌ GABIM KRITIK: ${errMsg}`);
      console.error(e);

      let userMsg = `❌ RUJTJA DËSHTOI!\n\n${errMsg}`;
      
      if (errMsg.includes("duplicate key") || errMsg.includes("clients_phone_uniq")) {
          userMsg = "❌ Numri i telefonit ekziston te një klient tjetër!\nSistemi u mundua ta rregullojë por dështoi.";
          addLog("ANALIZA: Duplicate Phone Error. Duhet update lib/ordersDb.js");
      }

      alert(userMsg);
      setSavingContinue(false);
    }
  }

  // --- Render (UI) ---
  if (creating) return <div className="wrap" style={{textAlign:'center', paddingTop:30}}>Duke hapur...</div>;

  return (
    <div className="wrap" style={{paddingBottom: 200}}>
      {/* HEADER */}
      <header className="header-row" style={{ alignItems: 'flex-start' }}>
        <div><h1 className="title">PRANIMI</h1><div className="subtitle">KRIJO POROSI</div></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            <div style={{fontSize:10, opacity:0.5}}>SMART DEBUG</div>
        </div>
        <div className="code-badge"><span className="badge">{normalizeCode(codeRaw)}</span></div>
      </header>

      {/* KLIENTI */}
      <section className="card">
        <h2 className="card-title">KLIENTI</h2>
        <div className="field-group">
          <label className="label">EMRI</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="field-group">
          <label className="label">TELEFONI</label>
          <div className="row"><input className="input small" value={phonePrefix} readOnly /><input className="input" value={phone} onChange={e => setPhone(e.target.value)} /></div>
        </div>
      </section>

      {/* TEPIHA */}
      <section className="card">
        <h2 className="card-title">TEPIHA</h2>
        <div className="chip-row modern">{TEPIHA_CHIPS.map(v => <button key={v} className="chip chip-modern" onClick={() => applyChip('tepiha', v)} style={chipStyleForVal(v, false)}>{v}</button>)}</div>
        {tepihaRows.map(r => <div key={r.id} className="piece-row"><div className="row"><input className="input small" value={r.m2} onChange={e=>handleRowChange('tepiha',r.id,'m2',e.target.value)} placeholder="m²"/><input className="input small" value={r.qty} onChange={e=>handleRowChange('tepiha',r.id,'qty',e.target.value)} placeholder="copë"/></div></div>)}
        <div className="row btn-row"><button className="btn secondary" onClick={()=>addRow('tepiha')}>+ RRESHT</button></div>
      </section>

      {/* FOOTER */}
      <footer className="footer-bar">
        <button className="btn secondary" onClick={() => router.push('/')}>HOME</button>
        <button className="btn primary" onClick={handleContinue} disabled={savingContinue}>{savingContinue ? '⏳...' : 'VAZHDO'}</button>
      </footer>

      {/* ✅ SMART DEBUG BOX (E ZEZË POSHTË) */}
      <div style={{background: '#000', color: '#0f0', padding: 10, fontSize: 10, fontFamily: 'monospace', maxHeight: 150, overflow: 'auto', borderTop: '1px solid #333', marginTop: 20}}>
          <div style={{fontWeight: 'bold', borderBottom: '1px solid #333', marginBottom: 5}}>LOGU I DIAGNOSTIKIMIT:</div>
          {logs.length === 0 ? <div style={{opacity:0.5}}>...Duke pritur veprim...</div> : logs.map((l, i) => <div key={i}>{l}</div>)}
      </div>

      <style jsx>{`
        /* Minimal styles for context */
        .chip-row.modern { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .chip-modern { padding: 10px 14px; border-radius: 14px; font-weight: 900; }
      `}</style>
    </div>
  );
}
