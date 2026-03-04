'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

function safeJson(v) {
  if (!v) return {};
  if (typeof v === 'string') {
    try { return JSON.parse(v) || {}; } catch { return {}; }
  }
  return typeof v === 'object' ? v : {};
}

function parseAmount(v, fallback = 0) {
  let s = String(v ?? '').trim();
  s = s.replace(/\s+/g, '');
  s = s.replace('€', '');
  s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizePhone(v) {
  const s = String(v || '').trim();
  if (s.startsWith('+')) return '+' + s.replace(/\D+/g, '');
  return s.replace(/\D+/g, '');
}

export default function TransportEditModal({ open, item, onClose, onSaved }) {
  const data = useMemo(() => safeJson(item?.data), [item]);
  const code = item?.code_str || item?.code || item?.code_n || data?.client?.code || '';

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [desc, setDesc] = useState('');
  const [notes, setNotes] = useState('');
  const [totalEur, setTotalEur] = useState('');

  useEffect(() => {
    if (!open) return;
    const d = safeJson(item?.data);
    setErr('');
    setName(String(d?.client?.name || item?.client_name || '').trim());
    setPhone(String(d?.client?.phone || item?.client_phone || '').trim());
    setAddress(String(d?.transport?.address || '').trim());
    setLat(String(d?.transport?.lat || '').trim());
    setLng(String(d?.transport?.lng || '').trim());
    setDesc(String(d?.transport?.desc || '').trim());
    setNotes(String(d?.notes || '').trim());
    setTotalEur(String(d?.pay?.euro ?? '').trim());
  }, [open, item]);

  if (!open) return null;

  async function save() {
    setSaving(true);
    setErr('');
    try {
      if (!item?.id) throw new Error('MUNGON ID');
      const d0 = safeJson(item?.data);
      const d = { ...d0 };

      const nm = String(name || '').trim();
      const ph = sanitizePhone(phone);

      d.client = { ...(d.client || {}), name: nm, phone: ph };
      d.transport = {
        ...(d.transport || {}),
        address: String(address || '').trim(),
        lat: String(lat || '').trim(),
        lng: String(lng || '').trim(),
        desc: String(desc || '').trim(),
      };
      d.notes = String(notes || '').trim();

      const eur = parseAmount(totalEur, d?.pay?.euro ?? 0);
      d.pay = { ...(d.pay || {}), euro: eur };

      const { error } = await supabase
        .from('transport_orders')
        .update({
          data: d,
          client_name: nm || null,
          client_phone: ph || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      if (error) throw error;
      onSaved?.();
      onClose?.();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.backdrop} onClick={() => { if (!saving) onClose?.(); }}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.title}>EDIT • {String(code || 'T?')}</div>
          <button style={styles.x} onClick={() => { if (!saving) onClose?.(); }}>✕</button>
        </div>

        {err ? <div style={styles.err}>{err}</div> : null}

        <div style={styles.grid}>
          <label style={styles.lbl}>
            EMRI
            <input style={styles.inp} value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <label style={styles.lbl}>
            TEL
            <input style={styles.inp} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>

          <label style={styles.lbl}>
            ADRESA
            <input style={styles.inp} value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>

          <div style={styles.row2}>
            <label style={{ ...styles.lbl, marginBottom: 0 }}>
              LAT
              <input style={styles.inp} value={lat} onChange={(e) => setLat(e.target.value)} />
            </label>
            <label style={{ ...styles.lbl, marginBottom: 0 }}>
              LNG
              <input style={styles.inp} value={lng} onChange={(e) => setLng(e.target.value)} />
            </label>
          </div>

          <label style={styles.lbl}>
            PËRSHKRIMI
            <input style={styles.inp} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>

          <label style={styles.lbl}>
            TOTAL € (VETËM EURO)
            <input style={styles.inp} inputMode="decimal" value={totalEur} onChange={(e) => setTotalEur(e.target.value)} />
          </label>

          <label style={styles.lbl}>
            SHËNIM
            <textarea style={styles.ta} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </label>
        </div>

        <div style={styles.footer}>
          <button style={styles.btnGhost} onClick={() => { if (!saving) onClose?.(); }}>ANULO</button>
          <button style={styles.btn} onClick={save} disabled={saving}>{saving ? '...' : 'RUAJ'}</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    zIndex: 9999,
  },
  modal: {
    width: '100%',
    maxWidth: 560,
    borderRadius: 16,
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(2, 6, 23, 0.98)',
    boxShadow: '0 30px 90px rgba(0,0,0,0.55)',
    overflow: 'hidden',
    color: '#e5e7eb',
    fontFamily: '-apple-system, system-ui, Segoe UI, Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.10)',
  },
  title: { fontWeight: 900, letterSpacing: 1.1 },
  x: {
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'transparent',
    color: '#e5e7eb',
    borderRadius: 10,
    padding: '6px 10px',
    fontWeight: 900,
  },
  err: {
    margin: 12,
    padding: 10,
    borderRadius: 12,
    border: '1px solid rgba(239,68,68,0.35)',
    background: 'rgba(239,68,68,0.12)',
    color: '#fecaca',
    fontWeight: 800,
    fontSize: 12,
  },
  grid: { padding: 14, display: 'grid', gap: 10 },
  lbl: { display: 'grid', gap: 6, fontWeight: 900, fontSize: 12, letterSpacing: 1.1 },
  inp: {
    height: 42,
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(15, 23, 42, 0.55)',
    color: '#e5e7eb',
    padding: '0 12px',
    fontWeight: 800,
    outline: 'none',
  },
  ta: {
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(15, 23, 42, 0.55)',
    color: '#e5e7eb',
    padding: '10px 12px',
    fontWeight: 800,
    outline: 'none',
    resize: 'vertical',
  },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  footer: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: 14, borderTop: '1px solid rgba(255,255,255,0.10)' },
  btnGhost: { padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)', background: 'transparent', color: '#e5e7eb', fontWeight: 900 },
  btn: { padding: '10px 12px', borderRadius: 12, border: '1px solid rgba(34,197,94,0.35)', background: 'rgba(34,197,94,0.18)', color: '#e5e7eb', fontWeight: 900 },
};
