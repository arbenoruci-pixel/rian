'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

// ✅ SUPABASE (Sigurohu që ke këtë import saktë)
import { supabase } from '@/lib/supabaseClient';

// ✅ LIBRARITË E TRANSPORTIT
import { getTransportSession } from '@/lib/transportAuth';
import { reserveTransportCode, markTransportCodeUsed } from '@/lib/transportCodes';
import { insertTransportOrder } from '@/lib/transport/transportDb';
import { recordCashMove } from '@/lib/arkaCashSync';

// --- KONFIGURIMET (CHIPS & CMIMET) ---
const BUCKET = 'tepiha-photos'; 

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];

const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;

const PRICE_DEFAULT = 3.0;
const PHONE_PREFIX_DEFAULT = '+383';
const PAY_CHIPS = [5, 10, 20, 30, 50];

// --- FUNKSIONE NDIHMËSE ---

// Pastron numrin e telefonit
function sanitizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

// Rregullon kodin T (p.sh. t5 -> T5)
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

// Llogarit totalin m2
function computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer) {
  const t = (tepihaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const s = (stazaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
  return Number((t + s + sh).toFixed(2));
}

// Siguron që numri është valid
function parseNum(v, fallback = 0) {
  const s = String(v ?? '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

// Upload Foto
async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, cacheControl: '0' });
  
  if (error) {
    console.error("Upload Error:", error);
    throw error;
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

// Stili i butonave (Chips)
function chipStyleForVal(v, active) {
  const n = Number(v);
  let a = 'rgba(59,130,246,0.18)'; 
  let b = 'rgba(59,130,246,0.06)';
  let br = 'rgba(59,130,246,0.35)';

  if (n >= 5.8) {
    a = 'rgba(249,115,22,0.20)'; 
    b = 'rgba(249,115,22,0.08)';
    br = 'rgba(249,115,22,0.38)';
  } else if (Math.abs(n - 3.2) < 0.051) {
    a = 'rgba(239,68,68,0.20)'; 
    b = 'rgba(239,68,68,0.08)';
    br = 'rgba(239,68,68,0.38)';
  } else if (n >= 3.5) {
    a = 'rgba(236,72,153,0.18)'; 
    b = 'rgba(236,72,153,0.06)';
    br = 'rgba(236,72,153,0.35)';
  } else if (n >= 2.2) {
    a = 'rgba(245,158,11,0.18)'; 
    b = 'rgba(245,158,11,0.06)';
    br = 'rgba(245,158,11,0.35)';
  } else {
    a = 'rgba(168,85,247,0.18)'; 
    b = 'rgba(168,85,247,0.06)';
    br = 'rgba(168,85,247,0.35)';
  }

  return {
    background: `linear-gradient(180deg, ${a}, ${b})`,
    border: `1px solid ${br}`,
    outline: active ? '2px solid rgba(255,255,255,0.22)' : 'none',
    boxShadow: active
      ? '0 10px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.18)'
      : '0 8px 14px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.14)',
  };
}

// --- KOMPONENTI KRYESOR ---
export default function TransportPranim() {
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get('id') || '';

  const [me, setMe] = useState(null);
  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);

  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');

  // Klienti
  const [name, setName] = useState('');
  const [phonePrefix, setPhonePrefix] = useState(PHONE_PREFIX_DEFAULT);
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');

  // Transporti
  const [address, setAddress] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [clientDesc, setClientDesc] = useState('');

  // Tepiha & Staza
  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);

  // Shkallore
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');
  
  // Pagesa
  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);

  // Modalet
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);
  const [payAdd, setPayAdd] = useState(0);

  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveIncomplete, setSaveIncomplete] = useState(false);

  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);

  // 1. Kontrollo sesionin e Transportit
  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) {
      router.push('/transport');
      return;
    }
    setMe(s);
  }, [router]);

  // 2. Inicilizo Porosinë e Re
  useEffect(() => {
    if (!me?.transport_id) return;
    (async () => {
      try {
        if (editId) {
          setOid(editId);
          setCreating(false);
          return;
        }
        const id = `tord_${Date.now()}`;
        setOid(id);
        
        // Rezervo Kodin T
        const tcode = await reserveTransportCode();
        setCodeRaw(tcode);
        
        setCreating(false);
      } catch (e) {
        console.error("Gabim gjatë inicializimit:", e);
        alert("Gabim gjatë hapjes së porosisë: " + e.message);
        setCreating(false);
      }
    })();
  }, [me, editId]);

  // Llogaritjet (Memo)
  const totalM2 = useMemo(() => computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer), [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const totalEuro = useMemo(() => Number((totalM2 * parseNum(pricePerM2, 0)).toFixed(2)), [totalM2, pricePerM2]);
  const paidEuro = useMemo(() => parseNum(clientPaid, 0), [clientPaid]);
  const debt = useMemo(() => {
    const d = Number((totalEuro - paidEuro).toFixed(2));
    return d > 0 ? d : 0;
  }, [totalEuro, paidEuro]);
  const currentChange = totalEuro - paidEuro < 0 ? Math.abs(totalEuro - paidEuro) : 0;
  const copeCount = useMemo(() => {
    const t = tepihaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const s = stazaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const sh = Number(stairsQty) > 0 ? 1 : 0;
    return t + s + sh;
  }, [tepihaRows, stazaRows, stairsQty]);

  // Helpers UI
  function vibrateTap(ms = 15) {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms);
    } catch {}
  }

  function bumpEl(el) {
    try {
      if (!el) return;
      el.classList.remove('chip-bump');
      // eslint-disable-next-line no-unused-expressions
      el.offsetWidth;
      el.classList.add('chip-bump');
      setTimeout(() => el.classList.remove('chip-bump'), 140);
    } catch {}
  }

  // --- LOGJIKA E RRESHTAVE ---
  function addRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const prefix = kind === 'tepiha' ? 't' : 's';
    setter((rows) => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '0', photoUrl: '' }]);
  }

  function removeRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter((rows) => (rows.length ? rows.slice(0, -1) : rows));
  }

  function handleRowChange(kind, id, field, value) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  // --- LOGJIKA E FOTOVE (Me Error Handling) ---
  async function handleRowPhotoChange(kind, id, file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, `${kind}_${id}`);
      if (url) handleRowChange(kind, id, 'photoUrl', url);
    } catch (e) {
      alert('❌ Gabim gjatë ngarkimit të fotos: ' + e.message);
    } finally {
      setPhotoUploading(false);
    }
  }

  async function handleStairsPhotoChange(file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'shkallore');
      if (url) setStairsPhotoUrl(url);
    } catch (e) {
      alert('❌ Gabim gjatë ngarkimit të fotos: ' + e.message);
    } finally {
      setPhotoUploading(false);
    }
  }

  async function handleClientPhotoChange(file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'client');
      if (url) setClientPhotoUrl(url);
    } catch (e) {
      alert('❌ Gabim gjatë ngarkimit të fotos: ' + e.message);
    } finally {
      setPhotoUploading(false);
    }
  }

  function applyChip(kind, val, ev) {
    vibrateTap(15);
    if (ev?.currentTarget) bumpEl(ev.currentTarget);

    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const rows = kind === 'tepiha' ? tepihaRows : stazaRows;

    if (!rows || rows.length === 0) {
      const prefix = kind === 'tepiha' ? 't' : 's';
      setter([{ id: `${prefix}1`, m2: String(val), qty: '1', photoUrl: '' }]);
      return;
    }

    const emptyIdx = rows.findIndex((r) => !r.m2);
    if (emptyIdx !== -1) {
      const nr = [...rows];
      const curQty = String(nr[emptyIdx]?.qty ?? '').trim();
      nr[emptyIdx] = { ...nr[emptyIdx], m2: String(val), qty: curQty && curQty !== '0' ? curQty : '1' };
      setter(nr);
    } else {
      const prefix = kind === 'tepiha' ? 't' : 's';
      setter([...rows, { id: `${prefix}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]);
    }
  }

  // --- GPS ---
  function getGps() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      alert('GPS nuk është i disponueshëm në këtë pajisje.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = String(pos?.coords?.latitude ?? '');
        const lng = String(pos?.coords?.longitude ?? '');
        setGpsLat(lat);
        setGpsLng(lng);
        alert('✅ GPS u mor!');
      },
      () => alert('S’u mor GPS. Lejo Location në browser.'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // --- PAGESA ---
  function openPay() {
    const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    setPayAdd(dueNow > 0 ? dueNow : 0);
    setShowPaySheet(true);
  }

  function applyPayAndClose() {
    const cashGiven = Number((Number(payAdd) || 0).toFixed(2));
    if (cashGiven <= 0) {
        setShowPaySheet(false);
        return;
    }
    const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2)));
    const applied = Number(Math.min(cashGiven, due).toFixed(2));
    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
    setClientPaid(newPaid);
    setShowPaySheet(false);
  }

  function startPayHold() {
    payHoldTriggeredRef.current = false;
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);
    payHoldTimerRef.current = setTimeout(() => {
      payHoldTriggeredRef.current = true;
      vibrateTap(25);
      setPriceTmp(Number(pricePerM2) || PRICE_DEFAULT);
      setShowPriceSheet(true);
    }, 1000); 
  }

  function endPayHold() {
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);
    payHoldTimerRef.current = null;
    if (!payHoldTriggeredRef.current) openPay();
    payHoldTriggeredRef.current = false;
  }

  function cancelPayHold() {
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);
    payHoldTimerRef.current = null;
    payHoldTriggeredRef.current = false;
  }

  // --- VALIDIMI ---
  function validate() {
    if (saveIncomplete) return true;
    if (!name.trim()) return alert('Shkruaj emrin dhe mbiemrin.'), false;
    if (name.trim().split(/\s+/).length < 2) return alert('Shkruaj edhe mbiemrin.'), false;
    const ph = sanitizePhone(phonePrefix + phone);
    if (!ph || ph.length < 6) return alert('Shkruaj një numër telefoni të vlefshëm.'), false;
    
    const allRows = [...(tepihaRows || []), ...(stazaRows || [])];
    for (const r of allRows) {
        const m2 = parseFloat(String(r.m2 || '0').replace(',', '.')) || 0;
        const q = parseInt(String(r.qty || '0'), 10) || 0;
        if (m2 > 0 && q <= 0) return alert('COPË duhet me qenë > 0 për çdo rresht që ka m².'), false;
    }

    if (totalM2 <= 0) return alert('Shto të paktën 1 m².'), false;
    return true;
  }

  // --- RUAJTJA (KJO PJESË DËSHTONTE, TANI ME DETAJE) ---
  async function saveOrder() {
    // 1. Kontrolli bazik
    if (!me?.transport_id) {
        alert("❌ Gabim Sesioni: Nuk je i identifikuar si Transportues. Dil dhe hyr prapë.");
        return;
    }
    if (!validate()) return;

    setSaving(true);

    try {
      const code = normalizeTCode(codeRaw);
      
      // Përgatit objektin
      const orderData = {
        id: oid,
        code, 
        code_n: Number(code.replace(/\D+/g, '')) || 0,
        scope: 'transport',
        transport_id: String(me.transport_id),
        transport_name: me.transport_name || me.transport_id,
        status: saveIncomplete ? 'transport_incomplete' : 'pastrim',
        created_at: new Date().toISOString(),
        data: {
          scope: 'transport',
          transport_id: String(me.transport_id),
          transport_name: me.transport_name || me.transport_id,
          status: saveIncomplete ? 'transport_incomplete' : 'pastrim',
          client: {
            name: name.trim(),
            phone: phonePrefix + (phone || ''),
            code,
            photoUrl: clientPhotoUrl || '',
          },
          transport: {
            address: address || '',
            lat: gpsLat || '',
            lng: gpsLng || '',
            desc: clientDesc || '',
          },
          tepiha: tepihaRows.map((r) => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0), photoUrl: r.photoUrl || '' })),
          staza: stazaRows.map((r) => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0), photoUrl: r.photoUrl || '' })),
          shkallore: { qty: parseNum(stairsQty, 0), per: parseNum(stairsPer, SHKALLORE_M2_PER_STEP_DEFAULT), photoUrl: stairsPhotoUrl || '' },
          pay: {
            price: parseNum(pricePerM2, 0),
            m2: Number(totalM2) || 0,
            euro: Number(totalEuro) || 0,
            paid: Number(paidEuro) || 0,
            debt: Number(debt) || 0,
            method: 'CASH',
          },
          notes: notes || '',
        },
      };

      console.log("Duke dërguar porosinë:", orderData); // Debug log

      // 2. Ruaj në DB
      const res = await insertTransportOrder(orderData);
      
      // ✅ KONTROLL I DETAJUAR I GABIMIT NGA DB
      if (!res?.ok) {
        console.error("DB Insert Failed:", res);
        throw new Error(res?.error || "Dështoi insertTransportOrder pa mesazh specifik.");
      }

      // 3. Shëno kodin si të përdorur
      await markTransportCodeUsed(code);

      // 4. Regjistro Pagesën Cash (nëse ka)
      if (paidEuro > 0) {
        const cashRes = await recordCashMove({
          amount: paidEuro,
          method: 'CASH',
          type: 'TRANSPORT',
          status: 'COLLECTED',
          order_id: orderData.id,
          order_code: code,
          client_name: name.trim(),
          stage: 'PRANIMI',
          note: `TRANSPORT PRANIMI ${code}`,
          created_by_pin: String(me.transport_id),
          created_by_name: me.transport_name || me.transport_id,
          approved_by_pin: null,
        });
        
        // Log nëse cash dështon, por mos blloko porosinë
        if (cashRes?.error) {
            console.warn("Cash record failed but order saved:", cashRes.error);
        }
      }

      // 5. Sukses - Navigo
      if (saveIncomplete) {
        router.push('/transport/te-pa-plotsuara');
      } else {
        router.push(`/pastrimi?id=${orderData.id}`);
      }

    } catch (e) {
      console.error("SAVE CRASH:", e);
      
      // ✅ SHFAQ GABIMIN E SAKTË TE PËRDORUESI
      const errMsg = e?.message || e?.error_description || JSON.stringify(e);
      alert(`❌ DËSHTOI RUAJTJA!\n\nArsyeja: ${errMsg}\n\nBëj screenshot këtë error dhe dërgoja programerit.`);
    } finally {
      setSaving(false);
    }
  }

  if (creating) {
    return (
      <div className="wrap">
        <header className="header-row">
          <div>
            <h1 className="title">TRANSPORT • PRANIMI</h1>
            <div className="subtitle">DUKE HAPUR...</div>
          </div>
        </header>
        <section className="card">
          <div className="muted">Duke gjeneruar kodin T...</div>
        </section>
      </div>
    );
  }

  return (
    <div className="wrap">
      <header className="header-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="title">TRANSPORT • PRANIMI</h1>
          <div className="subtitle">{me?.transport_name || 'SHOFER'}</div>
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
             <Link className="btn secondary" href="/transport/menu" style={{fontSize: 10, padding: '6px 10px'}}>MENU</Link>
        </div>

        <div className="code-badge">
          <span className="badge">{`KODI: ${normalizeTCode(codeRaw)}`}</span>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">KLIENTI & ADRESA</h2>
        
        <div className="row" style={{justifyContent: 'flex-end', marginBottom: 12}}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 12, fontWeight: 800 }}>
                <input
                type="checkbox"
                checked={saveIncomplete}
                onChange={(e) => setSaveIncomplete(e.target.checked)}
                />
                E PA PLOTSUAR
            </label>
        </div>

        <div className="field-group">
          <label className="label">EMRI & MBIEMRI</label>
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Emri Mbiemri" style={{ flex: 1 }} />
            {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini" /> : null}
            <label className="camera-btn" title="FOTO KLIENTI" style={{ marginLeft: 2 }}>
              📷
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} />
            </label>
          </div>
           {clientPhotoUrl && (
            <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 8 }} onClick={() => setClientPhotoUrl('')}>
              🗑️ FSHI FOTO
            </button>
          )}
        </div>

        <div className="field-group">
          <label className="label">TELEFONI</label>
          <div className="row">
            <input className="input small" value={phonePrefix} onChange={(e) => setPhonePrefix(e.target.value)} />
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="4x xxx xxx" />
          </div>
        </div>

        <div style={{height: 12}} />

        <div className="field-group">
            <label className="label">ADRESA / GPS</label>
            <div className="row" style={{gap: 8}}>
                <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Rruga..." style={{flex: 1}} />
                <button type="button" className="btn secondary" onClick={getGps} style={{padding: '0 12px'}}>📍 GPS</button>
            </div>
            {(gpsLat || gpsLng) && (
                <div style={{fontSize: 10, marginTop: 4, opacity: 0.7, fontFamily: 'monospace'}}>
                    {gpsLat}, {gpsLng}
                </div>
            )}
        </div>
        
        <div className="field-group" style={{marginTop: 10}}>
            <label className="label">PËRSHKRIM SHTESË</label>
            <textarea className="input" rows={2} value={clientDesc} onChange={(e) => setClientDesc(e.target.value)} placeholder="Kati, hymja, etj..." />
        </div>
      </section>

      {/* TEPIHA */}
      <section className="card">
        <h2 className="card-title">TEPIHA</h2>

        <div className="chip-row modern">
          {TEPIHA_CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip chip-modern"
              onClick={(e) => applyChip('tepiha', v, e)}
              style={chipStyleForVal(v, false)}
            >
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
                📷
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} />
              </label>
            </div>
            {row.photoUrl && (
              <div style={{ marginTop: 8 }}>
                <img src={row.photoUrl} className="photo-thumb" alt="" />
                <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('tepiha', row.id, 'photoUrl', '')}>
                  🗑️ FSHI FOTO
                </button>
              </div>
            )}
          </div>
        ))}

        <div className="row btn-row">
          <button className="btn secondary" onClick={() => addRow('tepiha')}>+ RRESHT</button>
          <button className="btn secondary" onClick={() => removeRow('tepiha')}>− RRESHT</button>
        </div>
      </section>

      {/* STAZA */}
      <section className="card">
        <h2 className="card-title">STAZA</h2>

        <div className="chip-row modern">
          {STAZA_CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip chip-modern"
              onClick={(e) => applyChip('staza', v, e)}
              style={chipStyleForVal(v, false)}
            >
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
                📷
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} />
              </label>
            </div>
            {row.photoUrl && (
              <div style={{ marginTop: 8 }}>
                <img src={row.photoUrl} className="photo-thumb" alt="" />
                <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('staza', row.id, 'photoUrl', '')}>
                  🗑️ FSHI FOTO
                </button>
              </div>
            )}
          </div>
        ))}

        <div className="row btn-row">
          <button className="btn secondary" onClick={() => addRow('staza')}>+ RRESHT</button>
          <button className="btn secondary" onClick={() => removeRow('staza')}>− RRESHT</button>
        </div>
      </section>

      {/* UTIL */}
      <section className="card">
        <div className="row util-row" style={{ gap: 10 }}>
          <button className="btn secondary" style={{ flex: 1 }} onClick={() => setShowStairsSheet(true)}>
            🪜 SHKALLORE
          </button>

          <button
            className="btn secondary"
            style={{ flex: 1 }}
            onMouseDown={startPayHold}
            onMouseUp={endPayHold}
            onMouseLeave={cancelPayHold}
            onTouchStart={(e) => {
              startPayHold();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              endPayHold();
            }}
          >
            € PAGESA
          </button>
        </div>

        <div className="tot-line">M² Total: <strong>{totalM2}</strong></div>
        <div className="tot-line">Copë: <strong>{copeCount}</strong></div>
        <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>

        <div className="tot-line" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 10, paddingTop: 10 }}>
          Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong>
        </div>

        {debt > 0 && <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{debt.toFixed(2)} €</strong></div>}
        {currentChange > 0 && <div className="tot-line">Kthim: <strong style={{ color: '#2563eb' }}>{currentChange.toFixed(2)} €</strong></div>}
      </section>

      {/* NOTES */}
      <section className="card">
        <h2 className="card-title">SHËNIME</h2>
        <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </section>

      {/* FOOTER */}
      <footer className="footer-bar">
        <button className="btn secondary" onClick={() => router.push('/')}>🏠 HOME</button>
        <button className="btn primary" onClick={saveOrder} disabled={saving || photoUploading}>
          {saving ? '⏳ DUKE RUJT...' : (photoUploading ? '⏳ FOTO...' : '▶ RUAJ')}
        </button>
      </footer>

      {/* --- MODALS --- */}

      {showPaySheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">PAGESA (TRANSPORT)</div>
              <div className="payfs-sub">
                KODI: {normalizeTCode(codeRaw)} • {name || '—'}
              </div>
            </div>
            <button className="btn secondary" onClick={() => setShowPaySheet(false)}>✕</button>
          </div>

          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div className="tot-line">TOTAL: <strong>{totalEuro.toFixed(2)} €</strong></div>
              <div className="tot-line">
                PAGUAR: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong>
              </div>

              <div className="tot-line" style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>
                SOT MERREN: <strong>{Number(payAdd || 0).toFixed(2)} €</strong>
              </div>
            </div>

            <div className="card">
              <div className="field-group">
                <label className="label">KLIENTI DHA (€)</label>

                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9]*"
                  className="input"
                  value={Number(payAdd || 0) === 0 ? '' : payAdd}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPayAdd(v === '' ? 0 : Number(v));
                  }}
                />

                <div className="chip-row" style={{ marginTop: 10 }}>
                  {PAY_CHIPS.map((v) => (
                    <button key={v} className="chip" type="button" onClick={() => setPayAdd(v)}>
                      {v}€
                    </button>
                  ))}
                  <button className="chip" type="button" onClick={() => setPayAdd(0)} style={{ opacity: 0.9 }}>
                    FSHI
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="payfs-footer">
            <button className="btn secondary" onClick={() => setShowPaySheet(false)}>ANULO</button>
            <button className="btn primary" onClick={applyPayAndClose}>RUJ PAGESËN</button>
          </div>
        </div>
      )}

      {showPriceSheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">NDËRRO QMIMIN</div>
              <div className="payfs-sub">€/m²</div>
            </div>
            <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>✕</button>
          </div>

          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <label className="label">QMIMI I RI (€ / m²)</label>
              <input
                type="number"
                step="0.1"
                className="input"
                value={priceTmp}
                onChange={(e) => setPriceTmp(e.target.value === '' ? '' : Number(e.target.value))}
              />
            </div>
          </div>

          <div className="payfs-footer">
            <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>ANULO</button>
            <button className="btn primary" onClick={() => {
                setPricePerM2(priceTmp);
                setShowPriceSheet(false);
            }}>RUJ</button>
          </div>
        </div>
      )}

      {showStairsSheet && (
        <div className="modal-overlay" onClick={() => setShowStairsSheet(false)}>
          <div className="modal-content dark" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="card-title" style={{ margin: 0, color: '#fff' }}>
                SHKALLORE
              </h3>
              <button className="btn secondary" onClick={() => setShowStairsSheet(false)}>✕</button>
            </div>

            <div className="field-group" style={{ marginTop: 12 }}>
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>COPE</label>
              <div className="chip-row">
                {SHKALLORE_QTY_CHIPS.map((n) => (
                  <button
                    key={n}
                    className="chip"
                    type="button"
                    onClick={() => {
                      setStairsQty(n);
                      vibrateTap(15);
                    }}
                    style={Number(stairsQty) === n ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <input type="number" className="input" value={stairsQty === 0 ? '' : stairsQty} onChange={(e) => setStairsQty(e.target.value)} style={{marginTop: 8}} />
            </div>

            <div className="field-group">
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>m² PËR COPË</label>
              <div className="chip-row">
                {SHKALLORE_PER_CHIPS.map((v) => (
                  <button
                    key={v}
                    className="chip"
                    type="button"
                    onClick={() => {
                      setStairsPer(v);
                      vibrateTap(15);
                    }}
                    style={Number(stairsPer) === v ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <input type="number" step="0.01" className="input" value={stairsPer} onChange={(e) => setStairsPer(e.target.value)} style={{marginTop: 8}} />
            </div>

             <div className="field-group">
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>FOTO</label>
              <label className="camera-btn">
                📷
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} />
              </label>

              {stairsPhotoUrl && (
                <div style={{ marginTop: 8 }}>
                  <img src={stairsPhotoUrl} className="photo-thumb" alt="" />
                  <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => setStairsPhotoUrl('')}>
                    🗑️ FSHI FOTO
                  </button>
                </div>
              )}
            </div>

            <button className="btn primary" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowStairsSheet(false)}>
              MBYLL
            </button>
          </div>
        </div>
      )}

      <style jsx>{`
        .client-mini{
          width: 34px;
          height: 34px;
          border-radius: 999px;
          object-fit: cover;
          border: 1px solid rgba(255,255,255,0.18);
          box-shadow: 0 6px 14px rgba(0,0,0,0.35);
        }
        
        .photo-thumb {
          width: 60px;
          height: 60px;
          object-fit: cover;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.2);
        }

        .camera-btn {
            background: rgba(255,255,255,0.1);
            width: 44px;
            height: 44px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 12px;
            cursor: pointer;
            border: 1px solid rgba(255,255,255,0.15);
        }

        .chip-row.modern {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 8px;
        }

        .chip-modern {
          padding: 10px 14px;
          border-radius: 14px;
          font-weight: 900;
          letter-spacing: 0.2px;
          color: rgba(255,255,255,0.92);
          backdrop-filter: blur(8px);
        }
        .chip-modern:active {
          transform: translateY(1px);
        }

        .chip-bump {
          animation: chipBump 140ms ease-in-out;
        }
        @keyframes chipBump {
          0% { transform: translateY(0) scale(1); }
          40% { transform: translateY(1px) scale(0.98); }
          70% { transform: translateY(0) scale(1.02); }
          100% { transform: translateY(0) scale(1); }
        }

        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          padding: 20px;
        }
        .modal-content {
          width: 100%;
          max-width: 420px;
          padding: 18px;
          border-radius: 18px;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
          background: white;
        }
        .modal-content.dark {
          background: #0b0b0b;
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .payfs {
          position: fixed;
          inset: 0;
          background: #0b0b0b;
          z-index: 10000;
          display: flex;
          flex-direction: column;
        }
        .payfs-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 14px 14px;
          background: #0b0b0b;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .payfs-title {
          color: #fff;
          font-weight: 900;
          font-size: 18px;
        }
        .payfs-sub {
          color: rgba(255, 255, 255, 0.7);
          font-size: 12px;
          margin-top: 2px;
        }
        .payfs-body {
          flex: 1;
          overflow: auto;
          padding: 14px;
        }
        .payfs-footer {
          display: flex;
          gap: 10px;
          padding: 12px 14px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: #0b0b0b;
        }
        .payfs-footer .btn {
          flex: 1;
        }
      `}</style>
    </div>
  );
}
