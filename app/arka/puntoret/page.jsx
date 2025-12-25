'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { listUsers, upsertUser, disableUser } from '@/lib/usersDb';

const LS_WORKERS = 'arka_workers_v1'; // local fallback only

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_WORKERS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveLocal(items) {
  try {
    localStorage.setItem(LS_WORKERS, JSON.stringify(items));
  } catch {}
}

const ROLE_LABEL = {
  ADMIN: 'ADMIN',
  DISPATCH: 'DISPATCH',
  PUNTOR: 'PUNTOR',
  TRANSPORT: 'TRANSPORT',
};

export default function ArkaPuntoretPage() {
  const [items, setItems] = useState([]);
  const [useLocal, setUseLocal] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('PUNTOR');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setErr('');
    const res = await listUsers();
    if (res.ok) {
      setUseLocal(false);
      setItems(res.items || []);
      return;
    }

    // If Supabase table missing/unavailable, fallback to local
    setUseLocal(true);
    setItems(loadLocal());
  }

  useEffect(() => {
    refresh();
  }, []);

  const activeItems = useMemo(() => {
    return (items || []).filter((u) => (useLocal ? u.active !== false : u.is_active !== false));
  }, [items, useLocal]);

  async function onAdd() {
    setErr('');
    const nm = name.trim();
    const p = String(pin || '').trim();
    if (!nm) return setErr('SHKRUJ EMRIN');
    if (!p || p.length < 4) return setErr('PIN MIN 4 SHIFRA');

    setBusy(true);
    try {
      if (!useLocal) {
        const r = await upsertUser({ name: nm, role, pin: p, is_active: true });
        if (!r.ok) {
          setErr(r.error?.message || 'GABIM NË DB');
        } else {
          setName('');
          setPin('');
          await refresh();
        }
      } else {
        const now = new Date().toISOString();
        const next = [...items, { id: 'ls-' + Date.now(), name: nm, role, pin: p, active: true, createdAt: now }];
        saveLocal(next);
        setItems(next);
        setName('');
        setPin('');
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDisable(id) {
    if (!confirm('A JE I SIGURT?')) return;
    setBusy(true);
    try {
      if (!useLocal) {
        const r = await disableUser(id);
        if (!r.ok) setErr(r.error?.message || 'GABIM NË DB');
        await refresh();
      } else {
        const next = (items || []).map((u) => (u.id === id ? { ...u, active: false } : u));
        saveLocal(next);
        setItems(next);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <Link href="/arka" className="back">← ARKA</Link>
        <div className="title">PUNTORET</div>
        <div className="hint">{useLocal ? 'LOCAL MODE' : 'SUPABASE MODE'}</div>
      </header>

      <section className="card">
        <div className="cardTitle">SHTO PUNËTOR</div>
        <div className="grid2">
          <input
            className="input"
            aria-label="EMRI"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.keys(ROLE_LABEL).map((k) => (
              <option key={k} value={k}>{ROLE_LABEL[k]}</option>
            ))}
          </select>
        </div>
        <div className="grid2">
          <input
            className="input"
            aria-label="PIN (4+ SHIFRA)"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D+/g, '').slice(0, 6))}
          />
          <button className="btn primary" onClick={onAdd} disabled={busy}>SHTO</button>
        </div>
        {err ? <div className="error">{err}</div> : null}
      </section>

      <section className="card">
        <div className="cardTitle">LISTA</div>
        {activeItems.length === 0 ? (
          <div className="empty">S’KA PUNËTORË</div>
        ) : (
          <div className="list">
            {activeItems.map((u) => (
              <div key={u.id} className="row">
                <div className="rowMain">
                  <div className="rowTitle">{u.name}</div>
                  <div className="rowSub">{u.role || u.role_name || u.role_label || u.role}</div>
                </div>
                <button className="btn danger" onClick={() => onDisable(u.id)} disabled={busy}>HIQ</button>
              </div>
            ))}
          </div>
        )}
      </section>

      <style jsx>{`
        .page{padding:14px;max-width:980px;margin:0 auto}
        .topbar{display:flex;align-items:center;gap:10px;margin-bottom:12px}
        .back{color:#9ad;text-decoration:none;font-weight:700}
        .title{font-weight:900;letter-spacing:1px}
        .hint{margin-left:auto;opacity:.75;font-size:12px}
        .card{background:#0f1116;border:1px solid #222;padding:12px;border-radius:12px;margin-bottom:12px}
        .cardTitle{font-weight:900;letter-spacing:1px;margin-bottom:8px;opacity:.9}
        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .input{background:#0b0d12;border:1px solid #222;color:#fff;padding:10px;border-radius:10px;outline:none}
        .btn{padding:10px 12px;border-radius:10px;border:1px solid #222;background:#151926;color:#fff;font-weight:800;letter-spacing:.5px}
        .primary{background:#1d2b54;border-color:#294a8a}
        .danger{background:#3a1212;border-color:#6a1f1f}
        .error{margin-top:8px;color:#ff8a8a;font-weight:700}
        .empty{opacity:.7;padding:10px}
        .list{display:flex;flex-direction:column;gap:8px}
        .row{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #222;border-radius:12px;background:#0b0d12}
        .rowMain{flex:1}
        .rowTitle{font-weight:900}
        .rowSub{opacity:.75;font-size:12px;margin-top:2px}
        @media (max-width:640px){.grid2{grid-template-columns:1fr}}
      `}</style>
    </main>
  );
}
