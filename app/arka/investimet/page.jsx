'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

const LS_OWNERS = 'arka_owners_v1';

function safeParse(v, fallback) {
  try { const x = JSON.parse(v); return x ?? fallback; } catch { return fallback; }
}

export default function ArkaInvestimetPage() {
  const [owners, setOwners] = useState([]);
  const [name, setName] = useState('');
  const [invest, setInvest] = useState('');
  const [pct, setPct] = useState('');

  useEffect(() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(LS_OWNERS) : null;
    const initial = safeParse(raw, []);
    setOwners(initial);
  }, []);

  function save(next) {
    setOwners(next);
    localStorage.setItem(LS_OWNERS, JSON.stringify(next));
  }

  const totalPct = useMemo(() => owners.reduce((s, o) => s + (Number(o.pct) || 0), 0), [owners]);

  function add() {
    const n = name.trim().toUpperCase();
    if (!n) return;
    const inv = Number(invest) || 0;
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    save([{ id: crypto.randomUUID(), name: n, invest: inv, pct: p }, ...owners]);
    setName('');
    setInvest('');
    setPct('');
  }

  function update(id, patch) {
    save(owners.map(o => (o.id === id ? { ...o, ...patch } : o)));
  }

  function remove(id) {
    if (!confirm('ME FSHI PRONARIN?')) return;
    save(owners.filter(o => o.id !== id));
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <div className="title">ARKA — INVESTIME & Ndarja</div>
          <div className="subtitle">PËRQINDJET E PROFITIT • INVESTIMET E PRONARËVE</div>
        </div>
        <Link href="/arka" className="chip">KTHEHU</Link>
      </header>

      <div className="card">
        <div className="row2">
          <div className="lbl">EMRI</div>
          <input className="input" aria-label="EMRI" value={name} onChange={e=>setName(e.target.value)} />

          <div className="lbl">INVESTIM €</div>
          <input className="input" aria-label="INVESTIM €" inputMode="decimal" value={invest} onChange={e=>setInvest(e.target.value)} />

          <div className="lbl">% PROFIT</div>
          <input className="input" aria-label="% PROFIT" inputMode="numeric" value={pct} onChange={e=>setPct(e.target.value)} />
        </div>
        <button className="btn" onClick={add}>SHTO</button>

        <div className="note">
          TOTAL %: <b>{totalPct}%</b> (SYNIMI: 100%)
        </div>
      </div>

      <div className="card">
        <div className="h2">PRONARËT</div>
        {owners.length === 0 ? (
          <div className="muted">S’KA PRONARË.</div>
        ) : (
          <div className="list">
            {owners.map(o => (
              <div className="item" key={o.id}>
                <div className="itemMain">
                  <div className="itemTitle">{o.name}</div>
                  <div className="itemMeta">INVESTIM: €{Number(o.invest||0).toFixed(2)} • %: {Number(o.pct||0)}%</div>
                </div>
                <div className="itemActions">
                  <button className="btnSm" onClick={() => {
                    const v = prompt('INVESTIM €', String(o.invest ?? 0));
                    if (v === null) return;
                    update(o.id, { invest: Number(v) || 0 });
                  }}>INVESTIM</button>
                  <button className="btnSm" onClick={() => {
                    const v = prompt('% PROFIT', String(o.pct ?? 0));
                    if (v === null) return;
                    const p = Math.max(0, Math.min(100, Number(v) || 0));
                    update(o.id, { pct: p });
                  }}>%</button>
                  <button className="btnSmDanger" onClick={() => remove(o.id)}>FSHI</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="h2">FUND MUAJI</div>
        <div className="muted">
          KËTU do ta lidhim me të dhënat reale nga SUPABASE (TOTAL, SHPENZIME, PAGESA, PROFIT) dhe pastaj i aplikojmë % sipas PRONARËVE.
        </div>
      </div>

      <style jsx>{`
        .page{padding:18px;max-width:980px;margin:0 auto;color:#fff}
        .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
        .title{font-size:28px;font-weight:800;letter-spacing:0.08em}
        .subtitle{opacity:.75;margin-top:6px;letter-spacing:0.1em}
        .chip{padding:10px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.18);text-decoration:none;color:#fff}
        .card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);border-radius:18px;padding:16px;margin-bottom:14px}
        .row2{display:grid;grid-template-columns:1fr 160px 120px;gap:10px;margin-bottom:10px}
        .input{width:100%;padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.30);color:#fff;outline:none}
        .btn{width:100%;padding:12px 14px;border-radius:14px;border:0;background:rgba(100,170,255,.95);color:#07111f;font-weight:800;letter-spacing:0.08em}
        .note{margin-top:10px;opacity:.9}
        .h2{font-weight:900;letter-spacing:0.12em;margin-bottom:10px}
        .muted{opacity:.75}
        .list{display:flex;flex-direction:column;gap:10px}
        .item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.18)}
        .itemTitle{font-weight:900;letter-spacing:0.1em}
        .itemMeta{opacity:.75;margin-top:4px}
        .itemActions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
        .btnSm{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.08);color:#fff;font-weight:800;letter-spacing:0.08em}
        .btnSmDanger{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,90,90,.35);background:rgba(255,90,90,.12);color:#ffd3d3;font-weight:900;letter-spacing:0.08em}
        @media(max-width:720px){.row2{grid-template-columns:1fr;}}
      `}</style>
    </div>
  );
}
