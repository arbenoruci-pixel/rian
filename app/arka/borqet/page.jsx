'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

const LS_DEBTS = 'arka_debts_v1';

function safeParse(v, fallback) {
  try { const x = JSON.parse(v); return x ?? fallback; } catch { return fallback; }
}

export default function ArkaBorqetPage() {
  const [items, setItems] = useState([]);
  const [who, setWho] = useState('');
  const [kind, setKind] = useState('NA KANË BORQ');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    const raw = localStorage.getItem(LS_DEBTS);
    setItems(safeParse(raw, []));
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_DEBTS, JSON.stringify(items));
  }, [items]);

  const totals = useMemo(() => {
    let owedToUs = 0;
    let weOwe = 0;
    for (const it of items) {
      const a = Number(it.amount || 0);
      if (it.kind === 'NA KANË BORQ') owedToUs += a;
      else weOwe += a;
    }
    return { owedToUs, weOwe };
  }, [items]);

  function add() {
    const a = Number(amount);
    if (!who.trim() || !Number.isFinite(a) || a <= 0) return;
    const it = {
      id: `${Date.now()}`,
      who: who.trim(),
      kind,
      amount: a,
      note: note.trim(),
      created_at: new Date().toISOString(),
      done: false,
    };
    setItems([it, ...items]);
    setWho('');
    setAmount('');
    setNote('');
  }

  function toggleDone(id) {
    setItems(items.map(it => it.id === id ? { ...it, done: !it.done } : it));
  }

  function remove(id) {
    if (!confirm('ME E FSHI?')) return;
    setItems(items.filter(it => it.id !== id));
  }

  return (
    <div className="page">
      <div className="arkaTop">
        <div>
          <div className="title">BORQET</div>
          <div className="subtitle">KUSH NA KA BORQ • KUJT I KEMI BORQ</div>
        </div>
        <Link href="/arka" className="arkaBack">← ARKA</Link>
      </div>

      <div className="card">
        <div className="row3">
          <div className="stat">
            <div className="statLabel">NA KANË BORQ</div>
            <div className="statVal">€{totals.owedToUs.toFixed(2)}</div>
          </div>
          <div className="stat">
            <div className="statLabel">NE I KEMI BORQ</div>
            <div className="statVal">€{totals.weOwe.toFixed(2)}</div>
          </div>
          <div className="stat">
            <div className="statLabel">NETO</div>
            <div className="statVal">€{(totals.owedToUs - totals.weOwe).toFixed(2)}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardTitle">SHTO BORQ</div>
        <div className="formGrid">
          <input className="inp" aria-label="EMRI / KOMPANIA" value={who} onChange={e => setWho(e.target.value)} />
          <select className="inp" value={kind} onChange={e => setKind(e.target.value)}>
            <option>NA KANË BORQ</option>
            <option>NE I KEMI BORQ</option>
          </select>
          <input className="inp" aria-label="SHUMA €" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
          <input className="inp" aria-label="SHËNIM (OPSION)" value={note} onChange={e => setNote(e.target.value)} />
        </div>
        <button className="btnPrimary" onClick={add}>SHTO</button>
      </div>

      <div className="card">
        <div className="cardTitle">LISTA</div>
        <div className="list">
          {items.length === 0 ? (
            <div className="muted">S’KA ENDE.</div>
          ) : items.map(it => (
            <div key={it.id} className={`listRow ${it.done ? 'done' : ''}`}>
              <div className="listMain">
                <div className="listTitle">{it.who} • {it.kind}</div>
                <div className="listSub">€{Number(it.amount).toFixed(2)}{it.note ? ` • ${it.note}` : ''}</div>
              </div>
              <div className="listActions">
                <button className="btn" onClick={() => toggleDone(it.id)}>{it.done ? 'AKTIV' : 'KRYER'}</button>
                <button className="btnDanger" onClick={() => remove(it.id)}>FSHI</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <style jsx>{`
        .page{max-width:900px;margin:0 auto;padding:16px;}
        .arkaTop{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:14px;}
        .title{font-weight:900;letter-spacing:2px;font-size:38px;line-height:1;}
        .subtitle{opacity:.75;margin-top:6px;font-size:13px;letter-spacing:1px;text-transform:uppercase;}
        .arkaBack{opacity:.9;text-decoration:none;padding:10px 12px;border:1px solid rgba(255,255,255,.15);border-radius:12px;}
        .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:14px;margin-bottom:12px;}
        .cardTitle{font-weight:900;letter-spacing:1.5px;margin-bottom:10px;}
        .row3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}
        .stat{padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(0,0,0,.12)}
        .statLabel{opacity:.75;font-size:12px;letter-spacing:1px;text-transform:uppercase;}
        .statVal{font-size:22px;font-weight:900;margin-top:4px;}
        .formGrid{display:grid;grid-template-columns:1.2fr 1fr .7fr 1.5fr;gap:10px;margin-bottom:10px;}
        .inp{width:100%;padding:12px 12px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.22);color:#fff;outline:none;}
        .btnPrimary{padding:12px 14px;border-radius:14px;border:0;background:#2f6fed;color:#fff;font-weight:900;letter-spacing:1px;}
        .btn{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.22);color:#fff;font-weight:800;letter-spacing:1px;}
        .btnDanger{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,80,80,.35);background:rgba(80,0,0,.22);color:#fff;font-weight:800;letter-spacing:1px;}
        .list{display:flex;flex-direction:column;gap:10px;}
        .listRow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.12)}
        .listRow.done{opacity:.65}
        .listTitle{font-weight:900;letter-spacing:1px;}
        .listSub{opacity:.75;margin-top:2px;font-size:12px;}
        .listActions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;}
        .muted{opacity:.7}
        @media (max-width: 820px){
          .row3{grid-template-columns:1fr;}
          .formGrid{grid-template-columns:1fr;}
        }
      `}</style>
    </div>
  );
}
