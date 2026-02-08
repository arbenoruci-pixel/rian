'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

// Shared edit modal for TRANSPORT orders (same idea as /pastrimi long-press edit)

const PRICE_DEFAULT = 3.0;
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;

function safeJson(v) {
  try {
    if (!v) return {};
    if (typeof v === 'string') return JSON.parse(v) || {};
    // some rows store payload under .data
    if (v && typeof v === 'object' && v.data) {
      const d = typeof v.data === 'string' ? (JSON.parse(v.data) || {}) : v.data;
      if (d && typeof d === 'object') return d;
    }
    return v || {};
  } catch {
    return {};
  }
}

function computeM2(o) {
  const tepiha = Array.isArray(o?.tepiha) ? o.tepiha : [];
  const staza = Array.isArray(o?.staza) ? o.staza : [];
  let total = 0;
  for (const r of tepiha) total += (Number(r?.m2) || 0) * (Number(r?.qty) || 0);
  for (const r of staza) total += (Number(r?.m2) || 0) * (Number(r?.qty) || 0);
  if (o?.shkallore) total += (Number(o?.shkallore?.qty) || 0) * (Number(o?.shkallore?.per) || 0);
  return Number(total.toFixed(2));
}

function computeEuro(m2, rate) {
  const r = Number(rate);
  const rr = Number.isFinite(r) && r > 0 ? r : PRICE_DEFAULT;
  return Number((Number(m2 || 0) * rr).toFixed(2));
}

function rowToUiRows(arr, prefix) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return [{ id: `${prefix}1`, m2: '', qty: '' }];
  return a.map((x, i) => ({
    id: `${prefix}${i + 1}`,
    m2: String(x?.m2 ?? ''),
    qty: String(x?.qty ?? ''),
  }));
}

function uiToRows(ui) {
  return (ui || []).map((r) => ({
    m2: Number(r?.m2) || 0,
    qty: Number(r?.qty) || 0,
  })).filter((r) => (r.m2 > 0 && r.qty > 0) || (r.m2 === 0 && r.qty > 0) || (r.m2 > 0 && r.qty === 0));
}

export default function TransportEditModal({ open, row, onClose, onSaved }) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const [oid, setOid] = useState('');
  const [status, setStatus] = useState('');
  const [codeStr, setCodeStr] = useState('');
  const [codeN, setCodeN] = useState(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const [tepihaRows, setTepihaRows] = useState([{ id: 't1', m2: '', qty: '' }]);
  const [stazaRows, setStazaRows] = useState([{ id: 's1', m2: '', qty: '' }]);
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);

  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [notes, setNotes] = useState('');

  const didInit = useRef(false);

  useEffect(() => {
    if (!open) {
      didInit.current = false;
      setErr('');
      return;
    }
    if (!row?.id) return;
    if (didInit.current && String(row.id) === oid) return;
    didInit.current = true;
    (async () => {
      setLoading(true);
      setErr('');
      try {
        const { data, error } = await supabase
          .from('transport_orders')
          .select('id,status,code_str,code_n,client_name,client_phone,data')
          .eq('id', row.id)
          .single();
        if (error) throw error;
        const o = safeJson(data?.data);

        setOid(String(data.id));
        setStatus(String(data.status || ''));
        setCodeStr(String(data.code_str || o?.code_str || ''));
        setCodeN(data.code_n ?? o?.code_n ?? null);

        setName(String(o?.client?.name ?? data.client_name ?? ''));
        setPhone(String(o?.client?.phone ?? data.client_phone ?? ''));

        setTepihaRows(rowToUiRows(o?.tepiha, 't'));
        setStazaRows(rowToUiRows(o?.staza, 's'));
        setStairsQty(Number(o?.shkallore?.qty) || 0);
        setStairsPer(Number(o?.shkallore?.per) || SHKALLORE_M2_PER_STEP_DEFAULT);

        const rate = Number(o?.pay?.rate ?? o?.pay?.price ?? PRICE_DEFAULT);
        setPricePerM2(Number.isFinite(rate) ? rate : PRICE_DEFAULT);
        setClientPaid(Number(o?.pay?.paid ?? 0) || 0);
        setNotes(String(o?.notes || ''));
      } catch (e) {
        setErr(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, row?.id]);

  const totalM2 = useMemo(() => {
    const o = {
      tepiha: uiToRows(tepihaRows),
      staza: uiToRows(stazaRows),
      shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0 },
    };
    return computeM2(o);
  }, [tepihaRows, stazaRows, stairsQty, stairsPer]);

  const totalEuro = useMemo(() => computeEuro(totalM2, pricePerM2), [totalM2, pricePerM2]);
  const debtEuro = useMemo(() => Number((totalEuro - (Number(clientPaid) || 0)).toFixed(2)), [totalEuro, clientPaid]);

  function addRow(kind) {
    if (kind === 't') {
      setTepihaRows((p) => [...p, { id: `t${p.length + 1}`, m2: '', qty: '' }]);
    } else {
      setStazaRows((p) => [...p, { id: `s${p.length + 1}`, m2: '', qty: '' }]);
    }
  }

  function updateRow(kind, id, field, value) {
    const set = kind === 't' ? setTepihaRows : setStazaRows;
    set((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  function removeRow(kind, id) {
    const set = kind === 't' ? setTepihaRows : setStazaRows;
    set((prev) => {
      const next = prev.filter((r) => r.id !== id);
      return next.length ? next : [{ id: `${kind}1`, m2: '', qty: '' }];
    });
  }

  async function save() {
    setSaving(true);
    setErr('');
    try {
      const { data: currentRow, error: fetchErr } = await supabase
        .from('transport_orders')
        .select('data,transport_id,created_at')
        .eq('id', oid)
        .single();
      if (fetchErr) throw fetchErr;

      const base = safeJson(currentRow?.data);

      const order = {
        ...base,
        id: oid,
        status: status || base.status,
        code_str: codeStr || base.code_str,
        code_n: codeN ?? base.code_n,
        client: {
          ...(base.client || {}),
          name: String(name || '').trim(),
          phone: String(phone || '').trim(),
        },
        tepiha: uiToRows(tepihaRows),
        staza: uiToRows(stazaRows),
        shkallore: {
          qty: Number(stairsQty) || 0,
          per: Number(stairsPer) || 0,
        },
        pay: {
          ...(base.pay || {}),
          m2: totalM2,
          rate: Number(pricePerM2) || PRICE_DEFAULT,
          euro: totalEuro,
          paid: Number(clientPaid) || 0,
          debt: debtEuro,
        },
        notes: notes || '',
      };

      const { error: upErr } = await supabase
        .from('transport_orders')
        .update({
          client_name: order.client?.name || null,
          client_phone: order.client?.phone || null,
          data: order,
          updated_at: new Date().toISOString(),
        })
        .eq('id', oid);

      if (upErr) throw upErr;

      onSaved?.();
      onClose?.();
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <div>
            <div style={styles.hTitle}>EDIT • {codeStr || ''}</div>
            <div style={styles.hSub}>STATUS: {String(status || '').toUpperCase()}</div>
          </div>
          <button style={styles.close} onClick={onClose} aria-label="Close">✕</button>
        </div>

        {err ? <div style={styles.err}>{err}</div> : null}
        {loading ? <div style={styles.loading}>DUKE NGARKUAR…</div> : null}

        <div style={styles.section}>
          <div style={styles.sectionTitle}>KLIENTI</div>
          <div style={styles.grid2}>
            <div>
              <div style={styles.label}>EMRI</div>
              <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Emri" />
            </div>
            <div>
              <div style={styles.label}>TEL</div>
              <input style={styles.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+383..." />
            </div>
          </div>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>TEPIHA</div>
          {(tepihaRows || []).map((r) => (
            <div key={r.id} style={styles.row3}>
              <input style={styles.input} value={r.m2} onChange={(e) => updateRow('t', r.id, 'm2', e.target.value)} placeholder="m²" />
              <input style={styles.input} value={r.qty} onChange={(e) => updateRow('t', r.id, 'qty', e.target.value)} placeholder="COPË" />
              <button style={styles.iconBtn} onClick={() => removeRow('t', r.id)}>—</button>
            </div>
          ))}
          <button style={styles.addBtn} onClick={() => addRow('t')}>+ SHTO</button>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>STAZA</div>
          {(stazaRows || []).map((r) => (
            <div key={r.id} style={styles.row3}>
              <input style={styles.input} value={r.m2} onChange={(e) => updateRow('s', r.id, 'm2', e.target.value)} placeholder="m²" />
              <input style={styles.input} value={r.qty} onChange={(e) => updateRow('s', r.id, 'qty', e.target.value)} placeholder="COPË" />
              <button style={styles.iconBtn} onClick={() => removeRow('s', r.id)}>—</button>
            </div>
          ))}
          <button style={styles.addBtn} onClick={() => addRow('s')}>+ SHTO</button>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>SHKALLORE</div>
          <div style={styles.grid2}>
            <div>
              <div style={styles.label}>SASI (COPË)</div>
              <input style={styles.input} value={stairsQty} onChange={(e) => setStairsQty(e.target.value)} placeholder="0" />
            </div>
            <div>
              <div style={styles.label}>m² / COPË</div>
              <input style={styles.input} value={stairsPer} onChange={(e) => setStairsPer(e.target.value)} placeholder="0.3" />
            </div>
          </div>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>PAGESA</div>
          <div style={styles.grid2}>
            <div>
              <div style={styles.label}>€ / m²</div>
              <input style={styles.input} value={pricePerM2} onChange={(e) => setPricePerM2(e.target.value)} />
            </div>
            <div>
              <div style={styles.label}>KLIENTI DHA (€)</div>
              <input style={styles.input} value={clientPaid} onChange={(e) => setClientPaid(e.target.value)} />
            </div>
          </div>
          <div style={styles.kpis}>
            <div style={styles.kpi}><span style={styles.kpiL}>m²</span><span style={styles.kpiV}>{totalM2}</span></div>
            <div style={styles.kpi}><span style={styles.kpiL}>TOTAL</span><span style={styles.kpiV}>€{totalEuro}</span></div>
            <div style={styles.kpi}><span style={styles.kpiL}>BORXH</span><span style={styles.kpiV}>€{debtEuro}</span></div>
          </div>
        </div>

        <div style={styles.section}>
          <div style={styles.sectionTitle}>SHENIM</div>
          <textarea style={styles.textarea} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shënim (opsionale)" />
        </div>

        <div style={styles.footer}>
          <button style={styles.cancel} onClick={onClose} disabled={saving}>MBYLL</button>
          <button style={styles.save} onClick={save} disabled={saving}>{saving ? 'DUKE RUAJTUR…' : 'RUAJ'}</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: '14px',
    overflowY: 'auto',
  },
  modal: {
    width: '100%',
    maxWidth: 520,
    background: '#0b1220',
    color: '#e5e7eb',
    borderRadius: 16,
    border: '1px solid rgba(255,255,255,0.10)',
    boxShadow: '0 20px 50px rgba(0,0,0,0.45)',
    padding: 14,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  hTitle: { fontWeight: 900, letterSpacing: 0.3 },
  hSub: { fontSize: 11, color: '#94a3b8', fontWeight: 800, marginTop: 2 },
  close: {
    border: 'none',
    background: 'rgba(255,255,255,0.10)',
    color: '#fff',
    borderRadius: 10,
    width: 36,
    height: 36,
    fontWeight: 900,
    cursor: 'pointer',
  },
  err: {
    background: 'rgba(239,68,68,0.18)',
    border: '1px solid rgba(239,68,68,0.35)',
    color: '#fecaca',
    padding: '10px 12px',
    borderRadius: 12,
    fontWeight: 800,
    fontSize: 12,
    marginBottom: 10,
  },
  loading: { color: '#93c5fd', fontWeight: 900, fontSize: 12, marginBottom: 10 },
  section: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
  },
  sectionTitle: { fontWeight: 900, fontSize: 12, color: '#cbd5e1', marginBottom: 8 },
  label: { fontSize: 11, fontWeight: 900, color: '#94a3b8', marginBottom: 6 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  input: {
    width: '100%',
    background: 'rgba(0,0,0,0.35)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: '10px 12px',
    color: '#fff',
    fontWeight: 800,
    outline: 'none',
  },
  textarea: {
    width: '100%',
    minHeight: 70,
    background: 'rgba(0,0,0,0.35)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: '10px 12px',
    color: '#fff',
    fontWeight: 700,
    outline: 'none',
  },
  row3: { display: 'grid', gridTemplateColumns: '1fr 1fr 42px', gap: 8, marginBottom: 8 },
  iconBtn: {
    border: 'none',
    background: 'rgba(255,255,255,0.10)',
    color: '#fff',
    borderRadius: 12,
    fontWeight: 900,
    cursor: 'pointer',
  },
  addBtn: {
    width: '100%',
    marginTop: 6,
    border: '1px dashed rgba(255,255,255,0.20)',
    background: 'rgba(255,255,255,0.05)',
    color: '#fff',
    borderRadius: 12,
    padding: '10px 12px',
    fontWeight: 900,
    cursor: 'pointer',
  },
  kpis: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10 },
  kpi: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: '10px 12px',
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    fontWeight: 900,
  },
  kpiL: { fontSize: 11, color: '#94a3b8' },
  kpiV: { fontSize: 13, color: '#fff' },
  footer: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 },
  cancel: {
    border: '1px solid rgba(255,255,255,0.16)',
    background: 'rgba(255,255,255,0.06)',
    color: '#fff',
    borderRadius: 12,
    padding: '10px 14px',
    fontWeight: 900,
    cursor: 'pointer',
  },
  save: {
    border: 'none',
    background: '#22c55e',
    color: '#052e16',
    borderRadius: 12,
    padding: '10px 14px',
    fontWeight: 900,
    cursor: 'pointer',
  },
};
