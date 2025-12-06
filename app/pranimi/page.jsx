'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;
const BUCKET = 'tepiha-photos';
const CODE_LEASE_MINUTES = 30;

function nowTs() {
  return Date.now();
}

function sanitizePhone(full) {
  return String(full).replace(/\D+/g, '');
}

function displayCode(raw) {
  if (!raw) return 'KODI: ——';
  const n = String(raw).replace(/^X/i, '');
  return `KODI: -${n}`;
}

// Reserve shared numeric code with Supabase Storage locks (codes/xN.lock + codes/xN.used)
async function reserveSharedCode() {
  if (!supabase) {
    const key = 'client_code_counter';
    const n = (parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1;
    localStorage.setItem(key, String(n));
    return 'X' + n;
  }

  const { data, error } = await supabase.storage.from(BUCKET).list('codes', {
    limit: 1000,
  });

  const used = new Set();
  const active = new Set();
  const now = Date.now();

  if (!error && data) {
    for (const item of data) {
      const name = item.name; // e.g. x12.used or x12.1690000.lock
      if (!name.startsWith('x')) continue;
      if (name.endsWith('.used')) {
        const n = parseInt(name.slice(1, -5), 10);
        if (!Number.isNaN(n)) used.add(n);
      } else if (name.includes('.')) {
        const [xPart, tsPartExt] = name.split('.', 2);
        const n = parseInt(xPart.slice(1), 10);
        const ts = parseInt(tsPartExt.replace(/\D+/g, ''), 10);
        if (!Number.isNaN(n)) {
          const ageMin = ts ? (now - ts) / 60000 : 0;
          if (ageMin > CODE_LEASE_MINUTES) {
            supabase.storage.from(BUCKET).remove([`codes/${name}`]).catch(() => {});
          } else {
            active.add(n);
          }
        }
      }
    }
  }

  let candidate = 1;
  while (used.has(candidate) || active.has(candidate)) candidate++;

  const lockName = `codes/x${candidate}.${Date.now()}.lock`;
  const file = new File([String(Date.now())], 'lock.txt', { type: 'text/plain' });
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(lockName, file);
  if (upErr) {
    const key = 'client_code_counter';
    const n = (parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1;
    localStorage.setItem(key, String(n));
    return 'X' + n;
  }
  return 'X' + candidate;
}

async function saveDraftOnline(order) {
  if (!supabase) return;
  const { id, client } = order;
  if (!id) return;

  const path = `orders/${id}.json`;
  const blob = new Blob([JSON.stringify(order)], { type: 'application/json' });

  await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });

  const code = client?.code;
  if (code && /^X\d+$/i.test(code)) {
    const n = String(code).replace(/^X/i, '');
    const usedPath = `codes/x${n}.used`;
    const usedBlob = new Blob([JSON.stringify({ at: new Date().toISOString() })], {
      type: 'application/json',
    });
    await supabase.storage.from(BUCKET).upload(usedPath, usedBlob, { upsert: true });
  }
}

function saveDraftLocal(order, status) {
  const id = order.id;
  const now = order.ts || nowTs();

  const full = {
    ...order,
    id,
    ts: now,
    status,
  };

  localStorage.setItem(`order_${id}`, JSON.stringify(full));

  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
  } catch {
    list = [];
  }

  const row = {
    id,
    status,
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    ts: now,
  };

  const existingIndex = list.findIndex((x) => x.id === id);
  if (existingIndex >= 0) {
    list[existingIndex] = row;
  } else {
    list.unshift(row);
  }
  list = list.slice(0, 200);
  localStorage.setItem('order_list_v1', JSON.stringify(list));
}

async function uploadPhoto(file, oid, key) {
  if (!supabase || !file) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true,
  });
  if (error) return null;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

export default function PranimiPage() {
  // NOTE: search params lexohen nga window.location.search (jo useSearchParams, për Next export)
  const router = useRouter();

  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const phonePrefix = '+383';

  const [tepihaRows, setTepihaRows] = useState([{ id: 't1', m2: '', qty: '1', photoUrl: '' }]);
  const [stazaRows, setStazaRows] = useState([{ id: 's1', m2: '', qty: '1', photoUrl: '' }]);

  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');

  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [paidUpfront, setPaidUpfront] = useState(false);

  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showShareSheet, setShowShareSheet] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let id = null;
    try {
      const url = new URL(window.location.href);
      id = url.searchParams.get('id');
    } catch (e) {
      id = null;
    }
    if (!id) {
      id = `ord_${Date.now()}`;
    }
    setOid(id);

    try {
      const raw = localStorage.getItem(`order_${id}`);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.client) {
          setName(saved.client.name || '');
          const phoneVal = (saved.client.phone || '').replace(/^\+383/, '');
          setPhone(phoneVal);
          if (saved.client.code) setCodeRaw(saved.client.code);
        }
        if (saved.notes) {
          setNotes(saved.notes || '');
        } else if (saved.client && saved.client.note) {
          setNotes(saved.client.note || '');
        }
        if (Array.isArray(saved.tepiha) && saved.tepiha.length) {
          setTepihaRows(
            saved.tepiha.map((p, idx) => ({
              id: `t${idx + 1}`,
              m2: String(p.m2 ?? ''),
              qty: String(p.qty ?? '1'),
              photoUrl: p.photoUrl || '',
            })),
          );
        }
        if (Array.isArray(saved.staza) && saved.staza.length) {
          setStazaRows(
            saved.staza.map((p, idx) => ({
              id: `s${idx + 1}`,
              m2: String(p.m2 ?? ''),
              qty: String(p.qty ?? '1'),
              photoUrl: p.photoUrl || '',
            })),
          );
        }
        if (saved.shkallore) {
          setStairsQty(Number(saved.shkallore.qty || 0));
          setStairsPer(Number(saved.shkallore.per || SHKALLORE_M2_PER_STEP_DEFAULT));
          setStairsPhotoUrl(saved.shkallore.photoUrl || '');
        }
        if (saved.pay) {
          setPricePerM2(Number(saved.pay.rate || PRICE_DEFAULT));
          setClientPaid(Number(saved.pay.paid || 0));
          setPaidUpfront(Boolean(saved.pay.paidUpfront));
        }
      }
    } catch (err) {
      console.error('Error loading existing order', err);
    }

    (async () => {
      try {
        if (!codeRaw) {
          const reserved = await reserveSharedCode();
          setCodeRaw(reserved);
        }
      } catch (e) {
        console.error('Error reserving code', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalTepihaM2 = useMemo(() => {
    return tepihaRows.reduce((sum, r) => {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      return sum + m2 * qty;
    }, 0);
  }, [tepihaRows]);

  const totalStazaM2 = useMemo(() => {
    return stazaRows.reduce((sum, r) => {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      return sum + m2 * qty;
    }, 0);
  }, [stazaRows]);

  const totalStairsM2 = useMemo(() => {
    const qty = Number(stairsQty) || 0;
    const per = Number(stairsPer) || 0;
    return qty * per;
  }, [stairsQty, stairsPer]);

  const totalM2 = useMemo(() => {
    return Number((totalTepihaM2 + totalStazaM2 + totalStairsM2).toFixed(2));
  }, [totalTepihaM2, totalStazaM2, totalStairsM2]);

  const totalEuro = useMemo(() => {
    return Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2));
  }, [totalM2, pricePerM2]);

  const debt = useMemo(() => {
    const diff = totalEuro - (Number(clientPaid) || 0);
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [totalEuro, clientPaid]);

  const change = useMemo(() => {
    const diff = (Number(clientPaid) || 0) - totalEuro;
    return diff > 0 ? Number(diff.toFixed(2)) : 0;
  }, [totalEuro, clientPaid]);

  function handleChipClick(kind, value) {
    if (kind === 'tepiha') {
      setTepihaRows((rows) => {
        if (!rows.length) return [{ id: 't1', m2: value.toFixed(1), qty: '1', photoUrl: '' }];
        const last = rows[rows.length - 1];
        if (!last.m2) {
          return [
            ...rows.slice(0, -1),
            { ...last, m2: value.toFixed(1) },
          ];
        }
        return [...rows, { id: `t${rows.length + 1}`, m2: value.toFixed(1), qty: '1', photoUrl: '' }];
      });
    } else if (kind === 'staza') {
      setStazaRows((rows) => {
        if (!rows.length) return [{ id: 's1', m2: value.toFixed(1), qty: '1', photoUrl: '' }];
        const last = rows[rows.length - 1];
        if (!last.m2) {
          return [
            ...rows.slice(0, -1),
            { ...last, m2: value.toFixed(1) },
          ];
        }
        return [...rows, { id: `s${rows.length + 1}`, m2: value.toFixed(1), qty: '1', photoUrl: '' }];
      });
    }
  }

  function addRow(kind) {
    if (kind === 'tepiha') {
      setTepihaRows((rows) => [...rows, { id: `t${rows.length + 1}`, m2: '', qty: '1', photoUrl: '' }]);
    } else {
      setStazaRows((rows) => [...rows, { id: `s${rows.length + 1}`, m2: '', qty: '1', photoUrl: '' }]);
    }
  }

  function removeRow(kind) {
    if (kind === 'tepiha') {
      setTepihaRows((rows) => (rows.length > 1 ? rows.slice(0, -1) : rows));
    } else {
      setStazaRows((rows) => (rows.length > 1 ? rows.slice(0, -1) : rows));
    }
  }

  function handleRowChange(kind, id, field, value) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter((rows) =>
      rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
    );
  }

  async function handleRowPhotoChange(kind, id, file) {
    if (!file || !oid) return;
    const key = `${kind}_${id}`;
    const url = await uploadPhoto(file, oid, key);
    if (!url) return;
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter((rows) =>
      rows.map((r) => (r.id === id ? { ...r, photoUrl: url } : r)),
    );
  }

  async function handleStairsPhotoChange(file) {
    if (!file || !oid) return;
    const key = 'shkallore';
    const url = await uploadPhoto(file, oid, key);
    if (!url) return;
    setStairsPhotoUrl(url);
  }

  function handleQuickPaid(amount) {
    setClientPaid(amount);
  }

  function buildOrder(status) {
    const fullPhone = phonePrefix + (phone || '');
    const client = {
      name: name.trim(),
      phone: fullPhone,
      code: codeRaw,
    };
    const tepiha = tepihaRows.map((r) => ({
      m2: Number(r.m2) || 0,
      qty: Number(r.qty) || 0,
      photoUrl: r.photoUrl || '',
    }));
    const staza = stazaRows.map((r) => ({
      m2: Number(r.m2) || 0,
      qty: Number(r.qty) || 0,
      photoUrl: r.photoUrl || '',
    }));
    const shkallore = {
      qty: Number(stairsQty) || 0,
      per: Number(stairsPer) || 0,
      m2: totalStairsM2,
      photoUrl: stairsPhotoUrl || '',
    };
    const pay = {
      m2: totalM2,
      rate: Number(pricePerM2) || 0,
      euro: totalEuro,
      paidUpfront,
      paid: Number(clientPaid) || 0,
      debt,
      change,
    };
    return {
      id: oid,
      ts: nowTs(),
      status,
      client,
      tepiha,
      staza,
      shkallore,
      pay,
      notes: notes.trim(),
    };
  }

  function validateClient() {
    if (!name.trim()) {
      alert('Shkruaj emrin dhe mbiemrin e klientit.');
      return false;
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) {
      alert('Shkruaj edhe mbiemrin e klientit.');
      return false;
    }
    const phoneDigits = sanitizePhone(phonePrefix + phone);
    if (!phoneDigits || phoneDigits.length < 6) {
      alert('Shkruaj një numër telefoni të vlefshëm.');
      return false;
    }
    return true;
  }

  function validateTotals() {
    if (totalM2 <= 0) {
      alert('Shto të paktën 1 m² para se të vazhdosh.');
      return false;
    }
    return true;
  }

  async function handleSaveDraft() {
    if (!validateClient()) return;
    const order = buildOrder('pranim');
    saveDraftLocal(order, 'pranim');
    await saveDraftOnline(order);
    alert('U ruajt.');
  }

  async function handleContinue() {
    if (!validateClient()) return;
    if (!validateTotals()) return;
    const order = buildOrder('pastrim');
    saveDraftLocal(order, 'pastrim');
    await saveDraftOnline(order);
    router.push(`/pastrimi?id=${encodeURIComponent(oid)}`);
  }

  function openSmsSheet() {
    setShowShareSheet(true);
  }

  function sendSms() {
    const fullPhone = phonePrefix + (phone || '');
    const phoneDigits = sanitizePhone(fullPhone);
    if (!phoneDigits) {
      alert('Nuk ka numër telefoni për SMS.');
      return;
    }
    const pieces = tepihaRows.length + stazaRows.length + (stairsQty > 0 ? 1 : 0);
    const body = encodeURIComponent(
      `Përshëndetje ${name || 'klient'}, procesi i pastrimit ka filluar. Keni ${pieces} copë = ${totalM2.toFixed(
        2,
      )} m². Totali: ${totalEuro.toFixed(2)} €. Faleminderit!`,
    );
    const smsUrl = `sms:${phoneDigits}?body=${body}`;
    window.location.href = smsUrl;
  }

  function sendViber() {
    const pieces = tepihaRows.length + stazaRows.length + (stairsQty > 0 ? 1 : 0);
    const txt = encodeURIComponent(
      `Përshëndetje ${name || 'klient'}, procesi i pastrimit ka filluar. Keni ${pieces} copë = ${totalM2.toFixed(
        2,
      )} m². Totali: ${totalEuro.toFixed(2)} €. Faleminderit!`,
    );
    const url = `viber://forward?text=${txt}`;
    window.location.href = url;
  }

  function sendWhatsApp() {
    const fullPhone = phonePrefix + (phone || '');
    const phoneDigits = sanitizePhone(fullPhone);
    if (!phoneDigits) {
      alert('Nuk ka numër telefoni për WhatsApp.');
      return;
    }
    const pieces = tepihaRows.length + stazaRows.length + (stairsQty > 0 ? 1 : 0);
    const txt = encodeURIComponent(
      `Përshëndetje ${name || 'klient'}, procesi i pastrimit ka filluar. Keni ${pieces} copë = ${totalM2.toFixed(
        2,
      )} m². Totali: ${totalEuro.toFixed(2)} €. Faleminderit!`,
    );
    const url = `https://wa.me/${phoneDigits}?text=${txt}`;
    window.location.href = url;
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">PRANIMI</h1>
          <div className="subtitle">Hapi 1 — Klienti</div>
        </div>
        <div className="code-badge">
          <span className="badge">{displayCode(codeRaw)}</span>
        </div>
      </header>

      <section className="card">
        <div className="card-title-row">
          <h2 className="card-title">Klienti</h2>
        </div>
        <div className="field-group">
          <label className="label">EMRI &amp; MBIEMRI*</label>
          <input
            className="input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shkruaj emrin dhe mbiemrin"
          />
        </div>
        <div className="field-group">
          <label className="label">TELEFONI*</label>
          <div className="row">
            <input className="input small" type="text" value={phonePrefix} readOnly />
            <input
              className="input"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Numri i telefonit"
            />
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Tepiha</h2>
        <div className="chip-row">
          {TEPIHA_CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip"
              onClick={() => handleChipClick('tepiha', v)}
            >
              {v.toFixed(1)} m²
            </button>
          ))}
          <button
            type="button"
            className="chip chip-outline"
            onClick={() => handleChipClick('tepiha', 0)}
          >
            Manual
          </button>
        </div>
        <div className="piece-list">
          {tepihaRows.map((row) => (
            <div className="piece-row" key={row.id}>
              <div className="row">
                <input
                  className="input small"
                  type="number"
                  min="0"
                  step="0.1"
                  value={row.m2}
                  onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)}
                  placeholder="m²"
                />
                <input
                  className="input small"
                  type="number"
                  min="1"
                  step="1"
                  value={row.qty}
                  onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)}
                  placeholder="copë"
                />
                <input
                  className="input"
                  type="file"
                  accept="image/*"
                  onChange={(e) =>
                    handleRowPhotoChange('tepiha', row.id, e.target.files?.[0] || null)
                  }
                />
              </div>
              {row.photoUrl && (
                <div className="thumb-row">
                  <a href={row.photoUrl} target="_blank" rel="noreferrer">
                    Shiko foton
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="row btn-row">
          <button type="button" className="btn secondary" onClick={() => addRow('tepiha')}>
            + RRESHT
          </button>
          <button type="button" className="btn secondary" onClick={() => removeRow('tepiha')}>
            − RRESHT
          </button>
        </div>
        <div className="tot-line">
          Totali tepiha: <strong>{totalTepihaM2.toFixed(2)} m²</strong>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Staza</h2>
        <div className="chip-row">
          {STAZA_CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip"
              onClick={() => handleChipClick('staza', v)}
            >
              {v.toFixed(1)} m²
            </button>
          ))}
          <button
            type="button"
            className="chip chip-outline"
            onClick={() => handleChipClick('staza', 0)}
          >
            Manual
          </button>
        </div>
        <div className="piece-list">
          {stazaRows.map((row) => (
            <div className="piece-row" key={row.id}>
              <div className="row">
                <input
                  className="input small"
                  type="number"
                  min="0"
                  step="0.1"
                  value={row.m2}
                  onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)}
                  placeholder="m²"
                />
                <input
                  className="input small"
                  type="number"
                  min="1"
                  step="1"
                  value={row.qty}
                  onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)}
                  placeholder="copë"
                />
                <input
                  className="input"
                  type="file"
                  accept="image/*"
                  onChange={(e) =>
                    handleRowPhotoChange('staza', row.id, e.target.files?.[0] || null)
                  }
                />
              </div>
              {row.photoUrl && (
                <div className="thumb-row">
                  <a href={row.photoUrl} target="_blank" rel="noreferrer">
                    Shiko foton
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="row btn-row">
          <button type="button" className="btn secondary" onClick={() => addRow('staza')}>
            + RRESHT
          </button>
          <button type="button" className="btn secondary" onClick={() => removeRow('staza')}>
            − RRESHT
          </button>
        </div>
        <div className="tot-line">
          Totali staza: <strong>{totalStazaM2.toFixed(2)} m²</strong>
        </div>
      </section>

      <section className="card">
        <div className="row util-row">
          <button type="button" className="btn secondary" onClick={() => setShowStairsSheet(true)}>
            🪜 +SHKALLORE
          </button>
          <button type="button" className="btn secondary" onClick={openSmsSheet}>
            SMS
          </button>
          <button type="button" className="btn secondary" onClick={() => setShowPaySheet(true)}>
            €
          </button>
        </div>
        <div className="tot-line">
          M² shkallore: <strong>{totalStairsM2.toFixed(2)} m²</strong>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">KËRKESË SPECIALE / SHËNIME</h2>
        <div className="field-group">
          <label className="label">Shënime të veçanta</label>
          <textarea
            className="input"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="P.sh. njolla shumë të vjetra, dëmtime, kërkesa speciale..."
          />
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Pagesa</h2>
        <div className="tot-line">
          M² total: <strong>{totalM2.toFixed(2)} m²</strong>
        </div>
        <div className="tot-line">
          Total (€): <strong>{totalEuro.toFixed(2)} €</strong>
        </div>
        <div className="tot-line small">
          Klienti dha: <strong>{Number(clientPaid || 0).toFixed(2)} €</strong> · Borxh:{' '}
          <strong>{debt.toFixed(2)} €</strong> · Kthim:{' '}
          <strong>{change.toFixed(2)} €</strong>
        </div>
      </section>

      <footer className="footer-bar">
        <button type="button" className="btn secondary" onClick={() => router.push('/')}>
          🏠 KTHEU NË FILLIM
        </button>
        <button type="button" className="btn" onClick={handleSaveDraft}>
          💾 RUAJ DRAFT
        </button>
        <button type="button" className="btn primary" onClick={handleContinue}>
          ▶ VAZHDO
        </button>
      </footer>

      {showPaySheet && (
        <div className="sheet-backdrop" onClick={() => setShowPaySheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Pagesa</h3>
            <div className="field-group">
              <label className="label">€ / m²</label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.1"
                value={pricePerM2}
                onChange={(e) => setPricePerM2(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="label">KLIENTI DHA (€)</label>
              <div className="chip-row">
                {[10, 20, 50, 100].map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="chip"
                    onClick={() => handleQuickPaid(v)}
                  >
                    {v} €
                  </button>
                ))}
              </div>
              <input
                className="input"
                type="number"
                min="0"
                step="0.1"
                value={clientPaid}
                onChange={(e) => setClientPaid(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="label">
                <input
                  type="checkbox"
                  checked={paidUpfront}
                  onChange={(e) => setPaidUpfront(e.target.checked)}
                />{' '}
                E paguar në fillim (cash)
              </label>
            </div>
            <div className="tot-line small">
              Total: <strong>{totalEuro.toFixed(2)} €</strong> · Borxh:{' '}
              <strong>{debt.toFixed(2)} €</strong> · Kthim:{' '}
              <strong>{change.toFixed(2)} €</strong>
            </div>
            <div className="row btn-row">
              <button type="button" className="btn secondary" onClick={() => setShowPaySheet(false)}>
                MBYLL
              </button>
            </div>
          </div>
        </div>
      )}

      {showStairsSheet && (
        <div className="sheet-backdrop" onClick={() => setShowStairsSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Shkallore</h3>
            <div className="field-group">
              <label className="label">Sasia (hapave)</label>
              <input
                className="input"
                type="number"
                min="0"
                step="1"
                value={stairsQty}
                onChange={(e) => setStairsQty(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="label">M² për hap</label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.01"
                value={stairsPer}
                onChange={(e) => setStairsPer(e.target.value)}
              />
            </div>
            <div className="field-group">
              <label className="label">Foto</label>
              <input
                className="input"
                type="file"
                accept="image/*"
                onChange={(e) => handleStairsPhotoChange(e.target.files?.[0] || null)}
              />
              {stairsPhotoUrl && (
                <div className="thumb-row">
                  <a href={stairsPhotoUrl} target="_blank" rel="noreferrer">
                    Shiko foton e shkallëve
                  </a>
                </div>
              )}
            </div>
            <div className="tot-line">
              Totali shkallore: <strong>{totalStairsM2.toFixed(2)} m²</strong>
            </div>
            <div className="row btn-row">
              <button type="button" className="btn secondary" onClick={() => setShowStairsSheet(false)}>
                MBYLL
              </button>
            </div>
          </div>
        </div>
      )}

      {showShareSheet && (
        <div className="sheet-backdrop" onClick={() => setShowShareSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Dërgo mesazh</h3>
            <div className="row btn-row">
              <button type="button" className="btn" onClick={sendSms}>
                SMS
              </button>
              <button type="button" className="btn secondary" onClick={sendViber}>
                Viber
              </button>
              <button type="button" className="btn secondary" onClick={sendWhatsApp}>
                WhatsApp
              </button>
            </div>
            <div className="row btn-row">
              <button type="button" className="btn secondary" onClick={() => setShowShareSheet(false)}>
                MBYLL
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}