'use client';

import React, { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 5.8, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];
const PAY_CHIPS = [5, 10, 20, 30, 50];
const STAIRS_PER_DEFAULT = 0.3;

function safeJson(v) {
  if (!v) return {};
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return v;
}

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

function parseNum(v, fallback = 0) {
  const s = String(v ?? '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function computeM2(order) {
  const t = Array.isArray(order?.tepiha) ? order.tepiha.reduce((a, r) => a + (Number(r?.m2) || 0) * (Number(r?.qty) || 0), 0) : 0;
  const s = Array.isArray(order?.staza) ? order.staza.reduce((a, r) => a + (Number(r?.m2) || 0) * (Number(r?.qty) || 0), 0) : 0;
  const sh = (Number(order?.shkallore?.qty) || 0) * (Number(order?.shkallore?.per) || 0);
  return Number((t + s + sh).toFixed(2));
}

function computePieces(order) {
  const t = Array.isArray(order?.tepiha) ? order.tepiha.reduce((a, r) => a + (Number(r?.qty) || 0), 0) : 0;
  const s = Array.isArray(order?.staza) ? order.staza.reduce((a, r) => a + (Number(r?.qty) || 0), 0) : 0;
  const shk = Number(order?.shkallore?.qty) > 0 ? 1 : 0;
  return t + s + shk;
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

export default function TransportInlineEdit({
  item,
  transportId,
  title = 'TRANSPORT',
  subtitle = 'EDITIMI',
  onClose,
  onSaved,
}) {
  const base = useMemo(() => {
    const d = safeJson(item?.order || item?.data || {});
    return d || {};
  }, [item]);

  const oid = String(item?.id || '');
  const codeRaw = normalizeTCode(item?.code || item?.code_str || base?.client?.code || item?.codeRaw || '');

  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);

  // Client
  const [name, setName] = useState(String(base?.client?.name || '').trim());
  const fullPhone = String(base?.client?.phone || '').trim();
  const [phonePrefix, setPhonePrefix] = useState(fullPhone.startsWith('+') ? fullPhone.match(/^\+\d+/)?.[0] || '+383' : '+383');
  const [phone, setPhone] = useState(() => {
    if (!fullPhone) return '';
    if (fullPhone.startsWith('+')) return fullPhone.replace(/^\+\d+/, '');
    return fullPhone;
  });
  const [clientPhotoUrl, setClientPhotoUrl] = useState(String(base?.client?.photoUrl || ''));

  // Address/GPS/desc
  const [address, setAddress] = useState(String(base?.transport?.address || ''));
  const [gpsLat, setGpsLat] = useState(String(base?.transport?.lat || ''));
  const [gpsLng, setGpsLng] = useState(String(base?.transport?.lng || ''));
  const [clientDesc, setClientDesc] = useState(String(base?.transport?.desc || ''));

  // Pieces rows
  const [tepihaRows, setTepihaRows] = useState(
    Array.isArray(base?.tepiha) && base.tepiha.length
      ? base.tepiha.map((r, i) => ({ id: `t${i + 1}`, m2: String(r?.m2 ?? ''), qty: String(r?.qty ?? '1'), photoUrl: String(r?.photoUrl || '') }))
      : [{ id: 't1', m2: '', qty: '1', photoUrl: '' }]
  );
  const [stazaRows, setStazaRows] = useState(
    Array.isArray(base?.staza) && base.staza.length
      ? base.staza.map((r, i) => ({ id: `s${i + 1}`, m2: String(r?.m2 ?? ''), qty: String(r?.qty ?? '1'), photoUrl: String(r?.photoUrl || '') }))
      : [{ id: 's1', m2: '', qty: '1', photoUrl: '' }]
  );
  const [stairsQty, setStairsQty] = useState(String(base?.shkallore?.qty ?? 0));
  const [stairsPer, setStairsPer] = useState(String(base?.shkallore?.per ?? STAIRS_PER_DEFAULT));
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState(String(base?.shkallore?.photoUrl || ''));

  // Pay
  const initialRate = base?.pay?.rate ?? base?.pay?.price ?? 3;
  const [pricePerM2, setPricePerM2] = useState(String(initialRate));
  const [clientPaid, setClientPaid] = useState(String(base?.pay?.paid ?? 0));

  const [notes, setNotes] = useState(String(base?.notes || ''));

  // Pay sheet (same UX as BASE/PASRTIMI)
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [payAdd, setPayAdd] = useState(0);

  const totalM2 = useMemo(() => {
    const t = tepihaRows.reduce((a, r) => a + (parseNum(r.m2, 0) * parseNum(r.qty, 0)), 0);
    const s = stazaRows.reduce((a, r) => a + (parseNum(r.m2, 0) * parseNum(r.qty, 0)), 0);
    const sh = parseNum(stairsQty, 0) * parseNum(stairsPer, STAIRS_PER_DEFAULT);
    return Number((t + s + sh).toFixed(2));
  }, [tepihaRows, stazaRows, stairsQty, stairsPer]);

  const totalEuro = useMemo(() => Number((totalM2 * parseNum(pricePerM2, 0)).toFixed(2)), [totalM2, pricePerM2]);
  const paidEuro = useMemo(() => Number(parseNum(clientPaid, 0).toFixed(2)), [clientPaid]);
  const debtEuro = useMemo(() => Number(Math.max(0, totalEuro - paidEuro).toFixed(2)), [totalEuro, paidEuro]);

  function openPay() {
    setPayAdd(0);
    setShowPaySheet(true);
  }

  function applyPayAndClose() {
    const add = parseNum(payAdd, 0);
    const nextPaid = Number((paidEuro + add).toFixed(2));
    setClientPaid(String(nextPaid));
    setShowPaySheet(false);
  }

  function addRow(kind) {
    if (kind === 'tepiha') {
      setTepihaRows(prev => [...prev, { id: `t${prev.length + 1}`, m2: '', qty: '1', photoUrl: '' }]);
    } else {
      setStazaRows(prev => [...prev, { id: `s${prev.length + 1}`, m2: '', qty: '1', photoUrl: '' }]);
    }
  }
  function removeRow(kind) {
    if (kind === 'tepiha') setTepihaRows(prev => prev.length > 0 ? prev.slice(0, -1) : prev);
    else setStazaRows(prev => prev.length > 0 ? prev.slice(0, -1) : prev);
  }
  function handleRowChange(kind, id, key, value) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter(prev => prev.map(r => (r.id === id ? { ...r, [key]: value } : r)));
  }

  async function handleClientPhotoChange(file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'client');
      if (url) setClientPhotoUrl(url);
    } catch {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  async function handleRowPhotoChange(kind, id, file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, `${kind}_${id}`);
      if (url) handleRowChange(kind, id, 'photoUrl', url);
    } catch {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  async function handleStairsPhotoChange(file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'stairs');
      if (url) setStairsPhotoUrl(url);
    } catch {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  async function save() {
    if (!oid) return;
    const nm = String(name || '').trim();
    const ph = (String(phonePrefix || '').trim() + String(phone || '').trim()).replace(/\s+/g, '');
    if (!nm) { alert('EMRI ËSHTË I DETYRUESHËM.'); return; }

    setSaving(true);
    try {
      const nextData = { ...(base || {}) };
      nextData.scope = 'transport';
      nextData.status = nextData.status || String(item?.status || 'pickup');

      nextData.client = {
        ...(nextData.client || {}),
        name: nm,
        phone: ph,
        code: String(codeRaw || nextData?.client?.code || ''),
        photoUrl: clientPhotoUrl || '',
      };

      nextData.transport = {
        ...(nextData.transport || {}),
        address: address || '',
        lat: gpsLat || '',
        lng: gpsLng || '',
        desc: clientDesc || '',
      };

      nextData.tepiha = tepihaRows.map(r => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0), photoUrl: r.photoUrl || '' }));
      nextData.staza = stazaRows.map(r => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0), photoUrl: r.photoUrl || '' }));
      nextData.shkallore = { qty: parseNum(stairsQty, 0), per: parseNum(stairsPer, STAIRS_PER_DEFAULT), photoUrl: stairsPhotoUrl || '' };

      nextData.pay = {
        ...(nextData.pay || {}),
        rate: parseNum(pricePerM2, 0),
        price: parseNum(pricePerM2, 0),
        m2: Number(totalM2) || 0,
        euro: Number(totalEuro) || 0,
        paid: Number(paidEuro) || 0,
        debt: Number(debtEuro) || 0,
        method: 'CASH',
      };

      nextData.notes = notes || '';
      nextData.updated_at = new Date().toISOString();

      const { error } = await supabase
        .from('transport_orders')
        .update({
          data: nextData,
          client_name: nm,
          client_phone: ph,
          updated_at: nextData.updated_at,
        })
        .eq('id', oid);

      if (error) throw error;

      onSaved?.();
      onClose?.();
    } catch (e) {
      alert('❌ GABIM NË RUAJTJE: ' + (e?.message || String(e)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wrap">
      <header className="header-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="title">{title}</h1>
          <div className="subtitle">{subtitle} ({codeRaw})</div>
        </div>
        <div className="code-badge"><span className="badge">{codeRaw}</span></div>
      </header>

      <section className="card">
        <h2 className="card-title">KLIENTI</h2>
        <div className="field-group">
          <label className="label">EMRI</label>
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <input className="input" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
            {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini" /> : null}
            <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleClientPhotoChange(e.target.files?.[0])} /></label>
          </div>
          {clientPhotoUrl ? <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 8 }} onClick={() => setClientPhotoUrl('')}>🗑️ FSHI FOTO</button> : null}
        </div>
        <div className="field-group">
          <label className="label">TELEFONI</label>
          <div className="row">
            <input className="input small" value={phonePrefix} readOnly />
            <input className="input" value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">ADRESA & GPS</h2>
        <div className="field-group"><label className="label">ADRESA</label><input className="input" value={address} onChange={e => setAddress(e.target.value)} /></div>
        <div className="row">
          <div style={{ flex: 1 }} className="field-group"><label className="label">LAT</label><input className="input" value={gpsLat} onChange={e => setGpsLat(e.target.value)} /></div>
          <div style={{ flex: 1 }} className="field-group"><label className="label">LNG</label><input className="input" value={gpsLng} onChange={e => setGpsLng(e.target.value)} /></div>
        </div>
        <div className="field-group"><label className="label">PËRSHKRIMI</label><textarea className="input" style={{ minHeight: 80 }} value={clientDesc} onChange={e => setClientDesc(e.target.value)} /></div>
        {(gpsLat && gpsLng) ? (
          <a className="btn secondary" style={{ display: 'inline-block', marginTop: 6 }} href={`https://www.google.com/maps?q=${encodeURIComponent(gpsLat)},${encodeURIComponent(gpsLng)}`} target="_blank" rel="noreferrer">GO ➜</a>
        ) : null}
      </section>

      {['tepiha', 'staza'].map(kind => (
        <section className="card" key={kind}>
          <h2 className="card-title">{kind.toUpperCase()}</h2>
          <div className="chip-row">
            {(kind === 'tepiha' ? TEPIHA_CHIPS : STAZA_CHIPS).map(val => (
              <button key={val} className="chip" onClick={() => {
                const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
                const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
                const emptyIdx = rows.findIndex(r => !r.m2);
                if (emptyIdx !== -1) {
                  const nr = [...rows];
                  nr[emptyIdx].m2 = String(val);
                  setter(nr);
                } else {
                  setter([...rows, { id: `${kind[0]}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]);
                }
              }}>{val}</button>
            ))}
          </div>

          {(kind === 'tepiha' ? tepihaRows : stazaRows).map(row => (
            <div className="piece-row" key={row.id}>
              <div className="row">
                <input className="input small" type="number" value={row.m2} onChange={e => handleRowChange(kind, row.id, 'm2', e.target.value)} placeholder="m²" />
                <input className="input small" type="number" value={row.qty} onChange={e => handleRowChange(kind, row.id, 'qty', e.target.value)} placeholder="copë" />
                <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleRowPhotoChange(kind, row.id, e.target.files?.[0])} /></label>
              </div>
              {row.photoUrl ? (
                <div style={{ marginTop: 8 }}>
                  <img src={row.photoUrl} className="photo-thumb" alt="" />
                  <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange(kind, row.id, 'photoUrl', '')}>🗑️ FSHI FOTO</button>
                </div>
              ) : null}
            </div>
          ))}

          <div className="row btn-row">
            <button className="btn secondary" onClick={() => addRow(kind)}>+ RRESHT</button>
            <button className="btn secondary" onClick={() => removeRow(kind)}>− RRESHT</button>
          </div>
        </section>
      ))}

      <section className="card">
        <h2 className="card-title">SHKALLORE</h2>
        <div className="row">
          <input className="input small" type="number" value={stairsQty} onChange={e => setStairsQty(e.target.value)} placeholder="copë" />
          <input className="input small" type="number" step="0.01" value={stairsPer} onChange={e => setStairsPer(e.target.value)} placeholder="m²/copë" />
          <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleStairsPhotoChange(e.target.files?.[0])} /></label>
        </div>
        {stairsPhotoUrl ? (
          <div style={{ marginTop: 8 }}>
            <img src={stairsPhotoUrl} className="photo-thumb" alt="" />
            <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => setStairsPhotoUrl('')}>🗑️ FSHI FOTO</button>
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="row util-row" style={{ gap: '10px' }}>
          <button className="btn secondary" style={{ flex: 1 }} onClick={openPay}>€ PAGESA</button>
          <div style={{ flex: 1 }} className="field-group">
            <label className="label">€/m²</label>
            <input className="input" type="number" step="0.01" value={pricePerM2} onChange={e => setPricePerM2(e.target.value)} />
          </div>
        </div>
        <div className="tot-line">M² Total: <strong>{totalM2}</strong></div>
        <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
        <div className="tot-line" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 10, paddingTop: 10 }}>Paguar: <strong style={{ color: '#16a34a' }}>{paidEuro.toFixed(2)} €</strong></div>
        {debtEuro > 0 ? <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{debtEuro.toFixed(2)} €</strong></div> : null}
      </section>

      <section className="card">
        <h2 className="card-title">SHËNIM</h2>
        <textarea className="input" style={{ minHeight: 90 }} value={notes} onChange={e => setNotes(e.target.value)} />
      </section>

      <footer className="footer-bar">
        <button className="btn secondary" onClick={onClose}>← ANULO</button>
        <button className="btn primary" onClick={save} disabled={saving || photoUploading}>{saving ? 'RUHET...' : (photoUploading ? 'FOTO...' : 'RUAJ')}</button>
      </footer>

      {showPaySheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">PAGESA</div>
            </div>
            <button className="btn secondary" onClick={() => setShowPaySheet(false)}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card">
              <div className="tot-line">TOTAL: <strong>{totalEuro.toFixed(2)} €</strong></div>
              <div className="tot-line">PAGUAR: <strong style={{ color: '#16a34a' }}>{paidEuro.toFixed(2)} €</strong></div>
              <div className="field-group" style={{ marginTop: 20 }}>
                <label className="label">SHTO PAGESË</label>
                <input className="input" type="number" value={payAdd} onChange={e => setPayAdd(e.target.value)} />
                <div className="chip-row">{PAY_CHIPS.map(c => <button key={c} className="chip" onClick={() => setPayAdd(c)}>{c}€</button>)}</div>
              </div>
            </div>
          </div>
          <div className="payfs-footer">
            <button className="btn primary" onClick={applyPayAndClose}>RUAJ</button>
          </div>
        </div>
      )}

      {/*
        NOTE: We intentionally keep styling minimal here and rely on global styles (app/globals.css)
        so TRANSPORT EDIT looks identical to BASE/PRANIMI/PASRTIMI edit screens.
      */}
      <style jsx>{`
        .client-mini{ width: 34px; height: 34px; border-radius: 999px; object-fit: cover; border: 1px solid rgba(255,255,255,0.18); }
        .payfs { position: fixed; inset: 0; background: #0b0b0b; z-index: 10000; display: flex; flex-direction: column; }
        .payfs-top { display: flex; justify-content: space-between; align-items: center; padding: 14px; background: #0b0b0b; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .payfs-title { font-weight: 900; letter-spacing: .14em; }
        .payfs-body { flex: 1; padding: 14px; }
        .payfs-footer { padding: 14px; border-top: 1px solid rgba(255,255,255,0.08); }
      `}</style>
    </div>
  );
}
