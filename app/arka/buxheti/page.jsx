'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { budgetAddMove, budgetDeleteMove, budgetListMoves } from '@/lib/companyBudgetDb';
import { isAdmin } from '@/lib/roles';

const euro = (n) =>
  `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })}`;

function parseEuroInput(v) {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

export default function CompanyBudgetPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rows, setRows] = useState([]);

  const [form, setForm] = useState({ type: 'OUT', amount: '', note: '' });

  const canSee = useMemo(() => isAdmin(user?.role), [user?.role]);

  const totals = useMemo(() => {
    const ins = (rows || [])
      .filter((r) => String(r.direction || '').toUpperCase() === 'IN')
      .reduce((a, r) => a + Number(r.amount || 0), 0);
    const outs = (rows || [])
      .filter((r) => String(r.direction || '').toUpperCase() === 'OUT')
      .reduce((a, r) => a + Number(r.amount || 0), 0);
    return { ins, outs, balance: ins - outs };
  }, [rows]);

  async function reload() {
    try {
      const items = await budgetListMoves(300);
      setRows(items || []);
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    const u = (() => {
      try {
        return JSON.parse(localStorage.getItem('CURRENT_USER_DATA')) || null;
      } catch {
        return null;
      }
    })();
    if (!u) {
      router.push('/login');
      return;
    }
    setUser(u);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function addMove() {
    setErr('');
    setBusy(true);
    try {
      const amt = parseEuroInput(form.amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('SHUMA DUHET > 0');
      const type = String(form.type || 'OUT').toUpperCase();
      if (type !== 'IN' && type !== 'OUT') throw new Error('TIPI DUHET IN/OUT');

      await budgetAddMove({
        direction: type,
        amount: amt,
        reason: 'MANUAL',
        note: String(form.note || ''),
        created_by: user?.name || 'LOCAL',
        created_by_name: user?.name || 'UNKNOWN',
        created_by_pin: user?.pin || null,
      });

      setForm({ type: 'OUT', amount: '', note: '' });
      await reload();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function del(id) {
    if (!id) return;
    setBusy(true);
    setErr('');
    try {
      await budgetDeleteMove(id);
      // keep backwards compatibility: old function name removed
      await reload();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;

  return (
    <div className="pageWrap">
      <div className="topRow">
        <div>
          <div className="title">BUXHETI I KOMPANIS</div>
          <div className="sub">{String(user.name || '').toUpperCase()} • {String(user.role || '').toUpperCase()}</div>
        </div>
        <Link className="ghostBtn" href="/arka">KTHEHU</Link>
      </div>

      {err ? <div className="err">{err}</div> : null}

      {!canSee ? (
        <div className="card">
          <div className="cardTitle">VETËM ADMIN/DISPATCH</div>
          <div className="muted">KJO FAQE ËSHTË VETËM PËR KONTROLLIN E BUXHETIT TË KOMPANIS.</div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="cardTitle">PËRMBLEDHJE</div>
            <div className="summary">
              <div><span className="k">IN</span> {euro(totals.ins)}</div>
              <div><span className="k">OUT</span> {euro(totals.outs)}</div>
              <div><span className="k">BALANC</span> {euro(totals.balance)}</div>
            </div>
            <div className="muted">IN vjen automatikisht kur DISPATCH pranon (RECEIVE) ARKËN. OUT vjen nga shpenzimet/avanset + manual.</div>
          </div>

          <div className="card">
            <div className="cardTitle">SHTO LËVIZJE</div>
            <div className="row">
              <select className="input" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                <option value="OUT">OUT (DALJE)</option>
                <option value="IN">IN (HYRJE)</option>
              </select>
              <input className="input" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="SHUMA (€)" inputMode="decimal" />
            </div>
            <input className="input" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="SHËNIM" />
            <button className="primary" disabled={busy} onClick={addMove}>{busy ? 'DUKE RUJTUR…' : 'SHTO'}</button>
          </div>

          <div className="card">
            <div className="cardTitle">LISTA</div>
            {rows.length === 0 ? (
              <div className="muted">S’KA LËVIZJE.</div>
            ) : (
              <div className="list">
                {rows.map((r) => (
                  <div key={r.id} className="item">
                    <div className="itemTop">
                      <div className="strong">{euro(r.amount)} • {String(r.direction || '').toUpperCase()}</div>
                      <button className="del" disabled={busy} onClick={() => del(r.id)}>FSHI</button>
                    </div>
                    {r.note ? <div className="muted">{String(r.note).toUpperCase()}</div> : null}
                    {r.created_by ? <div className="muted">{String(r.created_by).toUpperCase()}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <style jsx>{`
        .pageWrap{max-width:980px;margin:0 auto;padding:18px 14px 40px;text-transform:uppercase;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:14px;}
        .title{font-size:34px;letter-spacing:1px;font-weight:900;}
        .sub{opacity:.75;margin-top:4px;font-size:13px;letter-spacing:.8px;}
        .ghostBtn{height:40px;padding:0 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);display:inline-flex;align-items:center;justify-content:center;font-weight:800;letter-spacing:.6px;text-decoration:none;}
        .err{border:2px solid rgba(255,80,80,.35);background:rgba(255,0,0,.08);color:#ffd1d1;padding:12px;border-radius:14px;margin-bottom:12px;font-weight:900;letter-spacing:.08em;}
        .card{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);border-radius:16px;padding:14px 14px 12px;margin:12px 0;}
        .cardTitle{font-weight:950;letter-spacing:.18em;opacity:.85;font-size:10px;margin-bottom:10px;}
        .summary{display:flex;gap:12px;flex-wrap:wrap;font-weight:950;letter-spacing:.14em;font-size:12px;}
        .k{opacity:.75;margin-right:6px;}
        .row{display:flex;gap:10px;}
        .input{width:100%;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.16);padding:12px;border-radius:12px;font-size:12px;color:#fff;margin-top:10px;outline:none;letter-spacing:.08em;font-weight:900;}
        .primary{width:100%;margin-top:10px;padding:12px;border-radius:12px;border:1px solid rgba(0,150,255,.35);background:rgba(0,150,255,.12);color:rgba(190,230,255,.95);font-size:10px;font-weight:950;letter-spacing:.16em;opacity:1;}
        .primary:disabled{opacity:.55;}
        .muted{opacity:.7;padding:6px 0;font-size:10px;letter-spacing:.16em;}
        .list{display:grid;gap:10px;}
        .item{border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.35);border-radius:14px;padding:12px;}
        .itemTop{display:flex;justify-content:space-between;gap:10px;align-items:center;}
        .strong{font-weight:950;letter-spacing:.12em;font-size:11px;}
        .del{border-radius:12px;padding:10px 12px;border:1px solid rgba(255,80,80,.35);background:rgba(255,80,80,.10);font-weight:950;letter-spacing:.14em;font-size:10px;}
      `}</style>
    </div>
  );
}
