'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { budgetAddMove, budgetDeleteMove, budgetListMoves } from '@/lib/companyBudgetDb';
import { isAdmin } from '@/lib/roles';

const euro = (n) => `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const onlyNum = (v) => String(v ?? '').replace(',', '.').replace(/[^\d.]/g, '');

function readLS(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

export default function CompanyBudgetPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [budgetRows, setBudgetRows] = useState([]);
  const [investments, setInvestments] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [form, setForm] = useState({ title: '', amount: '', monthly_amount: '' });
  const [split, setSplit] = useState({ owner1: 'PRONARI 1', owner2: 'PRONARI 2', p1: '50', p2: '50' });

  const canSee = useMemo(() => isAdmin(user?.role), [user?.role]);

  async function reload() {
    setErr('');
    try {
      let rows = [];
      try {
        rows = await budgetListMoves(500);
      } catch {}
      try {
        const { data } = await supabase.from('company_budget').select('*').order('created_at', { ascending: false }).limit(500);
        if (Array.isArray(data) && data.length) {
          const mapped = data.map((r) => ({ ...r, direction: r.direction || 'IN' }));
          const seen = new Set((rows || []).map((x) => `${x.id}`));
          mapped.forEach((r) => { if (!seen.has(`${r.id}`)) rows.push(r); });
        }
      } catch {}
      setBudgetRows(Array.isArray(rows) ? rows.sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0)) : []);

      let inv = [];
      try {
        const { data } = await supabase.from('investments').select('*').order('created_at', { ascending: false }).limit(200);
        if (Array.isArray(data)) inv = data;
      } catch {}
      if (!inv.length) inv = readLS('company_investments_v1', []);
      setInvestments(Array.isArray(inv) ? inv : []);

      let pay = [];
      try {
        const { data } = await supabase.from('company_budget').select('*').eq('reason', 'PROFIT_SPLIT').order('created_at', { ascending: false }).limit(100);
        if (Array.isArray(data)) pay = data;
      } catch {}
      setPayouts(pay);
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    const u = (() => {
      try { return JSON.parse(localStorage.getItem('CURRENT_USER_DATA')) || null; } catch { return null; }
    })();
    if (!u) { router.push('/login'); return; }
    setUser(u);
    void reload();
  }, [router]);

  const totals = useMemo(() => {
    const ins = (budgetRows || []).filter((r) => String(r.direction || '').toUpperCase() === 'IN').reduce((a, r) => a + Number(r.amount || 0), 0);
    const outs = (budgetRows || []).filter((r) => String(r.direction || '').toUpperCase() === 'OUT').reduce((a, r) => a + Number(r.amount || 0), 0);
    return { ins, outs, balance: ins - outs };
  }, [budgetRows]);

  const activeInvestments = useMemo(() => (investments || []).filter((x) => String(x.status || 'ACTIVE').toUpperCase() !== 'PAID'), [investments]);
  const monthlyInvestmentReserve = useMemo(() => activeInvestments.reduce((s, x) => s + Number(x.monthly_amount || 0), 0), [activeInvestments]);
  const freeProfit = Math.max(0, totals.balance - monthlyInvestmentReserve);

  async function addInvestment() {
    setBusy(true);
    setErr('');
    try {
      const amount = Number(onlyNum(form.amount) || 0);
      const monthly_amount = Number(onlyNum(form.monthly_amount) || 0);
      if (!form.title.trim()) throw new Error('SHKRUANI EMRIN E INVESTIMIT.');
      if (!(amount > 0)) throw new Error('SHUMA DUHET > 0.');
      const row = {
        title: form.title.trim(),
        total_amount: amount,
        remaining_amount: amount,
        monthly_amount,
        status: 'ACTIVE',
        created_by_name: user?.name || null,
        created_by_pin: user?.pin || null,
      };
      try {
        const { error } = await supabase.from('investments').insert(row);
        if (error) throw error;
      } catch {
        const ls = readLS('company_investments_v1', []);
        ls.unshift({ id: `inv_${Date.now()}`, created_at: new Date().toISOString(), ...row });
        localStorage.setItem('company_investments_v1', JSON.stringify(ls.slice(0, 200)));
      }
      setForm({ title: '', amount: '', monthly_amount: '' });
      await reload();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function splitProfit() {
    setBusy(true);
    setErr('');
    try {
      const p1 = Number(onlyNum(split.p1) || 0);
      const p2 = Number(onlyNum(split.p2) || 0);
      if (Math.round((p1 + p2) * 100) !== 10000) throw new Error('PËRQINDJET DUHET TË JENË 100%.');
      if (freeProfit <= 0) throw new Error('NUK KA PROFIT TË LIRË PËR NDARJE.');

      let reserveTotal = 0;
      for (const inv of activeInvestments) {
        const reserve = Math.min(Number(inv.monthly_amount || 0), Number(inv.remaining_amount || 0));
        if (reserve <= 0) continue;
        reserveTotal += reserve;
        try {
          await budgetAddMove({
            direction: 'OUT',
            amount: reserve,
            reason: 'INVESTMENT_RESERVE',
            note: `REZERVË INVESTIMI • ${inv.title}`,
            source: 'COMPANY_BUDGET',
            created_by: user?.name || 'ADMIN',
            created_by_name: user?.name || null,
            created_by_pin: user?.pin || null,
          });
        } catch {}
        try {
          const nextRemaining = Math.max(0, Number(inv.remaining_amount || 0) - reserve);
          const patch = { remaining_amount: nextRemaining, status: nextRemaining <= 0 ? 'PAID' : 'ACTIVE' };
          const { error } = await supabase.from('investments').update(patch).eq('id', inv.id);
          if (error) throw error;
        } catch {
          const ls = readLS('company_investments_v1', []);
          const next = ls.map((x) => x.id === inv.id ? { ...x, remaining_amount: Math.max(0, Number(x.remaining_amount || 0) - reserve), status: Math.max(0, Number(x.remaining_amount || 0) - reserve) <= 0 ? 'PAID' : 'ACTIVE' } : x);
          localStorage.setItem('company_investments_v1', JSON.stringify(next));
        }
      }

      const distributable = Math.max(0, totals.balance - reserveTotal);
      const owner1Amount = Number((distributable * (p1 / 100)).toFixed(2));
      const owner2Amount = Number((distributable * (p2 / 100)).toFixed(2));

      await budgetAddMove({ direction: 'OUT', amount: owner1Amount, reason: 'PROFIT_SPLIT', note: `FITIM • ${split.owner1}`, source: 'COMPANY_BUDGET', created_by: user?.name || 'ADMIN', created_by_name: user?.name || null, created_by_pin: user?.pin || null });
      await budgetAddMove({ direction: 'OUT', amount: owner2Amount, reason: 'PROFIT_SPLIT', note: `FITIM • ${split.owner2}`, source: 'COMPANY_BUDGET', created_by: user?.name || 'ADMIN', created_by_name: user?.name || null, created_by_pin: user?.pin || null });
      await reload();
      alert(`Fitimi u nda me sukses. ${split.owner1}: ${euro(owner1Amount)} | ${split.owner2}: ${euro(owner2Amount)}`);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteBudgetMove(id) {
    if (!id) return;
    if (!window.confirm('A jeni i sigurt që dëshironi ta fshini këtë lëvizje?')) return;
    setBusy(true);
    try {
      await budgetDeleteMove(id);
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
          <div className="title">BUXHETI & INVESTIMET</div>
          <div className="sub">{String(user.name || '').toUpperCase()} • {String(user.role || '').toUpperCase()}</div>
        </div>
        <Link className="ghostBtn" href="/arka">KTHEHU</Link>
      </div>

      {err ? <div className="err">{err}</div> : null}

      {!canSee ? (
        <div className="card"><div className="cardTitle">VETËM ADMIN</div><div className="muted">KJO FAQE ËSHTË VETËM PËR BUXHETIN E KOMPANISË.</div></div>
      ) : (
        <>
          <div className="heroGrid">
            <div className="heroCard dark">
              <div className="cardTitle">BUXHETI LIVE</div>
              <div className="big">{euro(totals.balance)}</div>
              <div className="muted light">Cash-in-hand / balanca aktuale pas hyrjeve dhe daljeve.</div>
            </div>
            <div className="heroCard">
              <div className="cardTitle">INVESTIME AKTIVE</div>
              <div className="big small">{activeInvestments.length}</div>
              <div className="muted">Rezervë mujore: {euro(monthlyInvestmentReserve)}</div>
            </div>
            <div className="heroCard">
              <div className="cardTitle">PROFIT I LIRË</div>
              <div className="big small">{euro(freeProfit)}</div>
              <div className="muted">Balanca e lirë pas mbajtjes së pjesës mujore për investime.</div>
            </div>
          </div>

          <div className="sectionGrid">
            <div className="card">
              <div className="cardTitle">INVESTIMET</div>
              <div className="row">
                <input className="input" placeholder="P.SH. BLERJA E FURGONIT" value={form.title} onChange={(e)=>setForm((f)=>({...f,title:e.target.value}))} />
                <input className="input" placeholder="TOTALI €" value={form.amount} onChange={(e)=>setForm((f)=>({...f,amount:onlyNum(e.target.value)}))} />
              </div>
              <input className="input" placeholder="SHLYERJA MUJORE €" value={form.monthly_amount} onChange={(e)=>setForm((f)=>({...f,monthly_amount:onlyNum(e.target.value)}))} />
              <button className="primary" disabled={busy} onClick={addInvestment}>SHTO INVESTIM</button>

              <div className="list">
                {investments.length ? investments.map((inv) => (
                  <div key={inv.id} className="item">
                    <div className="itemTop"><div className="strong">{String(inv.title || '').toUpperCase()}</div><div className="pill">{String(inv.status || 'ACTIVE').toUpperCase()}</div></div>
                    <div className="muted">TOTALI {euro(inv.total_amount)} • MBETJA {euro(inv.remaining_amount)} • MUJORJA {euro(inv.monthly_amount)}</div>
                  </div>
                )) : <div className="muted">S’KA INVESTIME.</div>}
              </div>
            </div>

            <div className="card">
              <div className="cardTitle">NDARJA E FITIMIT</div>
              <div className="ownersGrid">
                <div className="ownerCard"><div className="miniTitle">PRONARI 1</div><input className="input" value={split.owner1} onChange={(e)=>setSplit((s)=>({...s,owner1:e.target.value}))} /><input className="input" value={split.p1} onChange={(e)=>setSplit((s)=>({...s,p1:onlyNum(e.target.value)}))} placeholder="50" /></div>
                <div className="ownerCard"><div className="miniTitle">PRONARI 2</div><input className="input" value={split.owner2} onChange={(e)=>setSplit((s)=>({...s,owner2:e.target.value}))} /><input className="input" value={split.p2} onChange={(e)=>setSplit((s)=>({...s,p2:onlyNum(e.target.value)}))} placeholder="50" /></div>
              </div>
              <div className="muted">Kur shtypet “NDAJ FITIMIN”, sistemi mban pjesën mujore për investimet aktive dhe pjesën tjetër e ndan sipas përqindjes.</div>
              <button className="primary green" disabled={busy} onClick={splitProfit}>NDAJ FITIMIN</button>
              <div className="list compact">
                {payouts.length ? payouts.slice(0,8).map((r)=> (
                  <div key={r.id} className="item"><div className="itemTop"><div className="strong">{String(r.note || 'FITIM').toUpperCase()}</div><div className="strong">{euro(r.amount)}</div></div></div>
                )) : <div className="muted">Ende s’ka ndarje fitimi.</div>}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cardTitle">HISTORIKU I BUXHETIT</div>
            <div className="list">
              {budgetRows.length ? budgetRows.map((r) => (
                <div key={r.id} className="item">
                  <div className="itemTop">
                    <div className="strong">{euro(r.amount)} • {String(r.direction || '').toUpperCase()}</div>
                    <button className="del" disabled={busy} onClick={() => deleteBudgetMove(r.id)}>FSHI</button>
                  </div>
                  <div className="muted">{String(r.note || r.reason || 'PA SHËNIM').toUpperCase()}</div>
                </div>
              )) : <div className="muted">S’KA LËVIZJE.</div>}
            </div>
          </div>
        </>
      )}

      <style jsx>{`
        .pageWrap{max-width:1120px;margin:0 auto;padding:22px 14px 42px;color:#0f172a;background:transparent;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:14px;flex-wrap:wrap;}
        .title{font-size:38px;letter-spacing:-.04em;font-weight:900;}
        .sub{opacity:.75;margin-top:4px;font-size:13px;letter-spacing:.8px;text-transform:uppercase;}
        .ghostBtn{height:42px;padding:0 14px;border-radius:14px;border:1px solid #dbe3ef;background:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:800;letter-spacing:.6px;text-decoration:none;box-shadow:0 10px 26px rgba(15,23,42,.05);}
        .err{border:2px solid rgba(255,80,80,.18);background:#fff1f2;color:#991b1b;padding:12px;border-radius:16px;margin-bottom:12px;font-weight:900;letter-spacing:.04em;}
        .heroGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:14px;}
        .heroCard,.card{border:1px solid #e2e8f0;background:rgba(255,255,255,.96);border-radius:24px;padding:16px 16px 14px;box-shadow:0 12px 28px rgba(15,23,42,.05);}
        .heroCard.dark{background:#0f172a;color:#fff;border-color:rgba(255,255,255,.08);}
        .cardTitle{font-weight:950;letter-spacing:.18em;opacity:.85;font-size:10px;margin-bottom:10px;text-transform:uppercase;}
        .big{font-size:42px;line-height:1;font-weight:900;letter-spacing:-.05em;}
        .big.small{font-size:34px;}
        .sectionGrid{display:grid;grid-template-columns:1.2fr 1fr;gap:14px;}
        .row,.ownersGrid{display:flex;gap:10px;}
        .ownersGrid{align-items:stretch;}
        .ownerCard{flex:1;border:1px solid #e2e8f0;background:#f8fafc;border-radius:18px;padding:12px;}
        .miniTitle{font-size:11px;font-weight:900;letter-spacing:.14em;margin-bottom:6px;}
        .input{width:100%;background:#fff;border:1px solid #dbe3ef;padding:12px;border-radius:14px;font-size:12px;color:#0f172a;margin-top:10px;outline:none;letter-spacing:.04em;font-weight:800;}
        .primary{width:100%;margin-top:10px;padding:13px;border-radius:14px;border:1px solid #bfdbfe;background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:950;letter-spacing:.16em;text-transform:uppercase;}
        .primary.green{background:linear-gradient(180deg,#22c55e,#16a34a);border-color:#16a34a;color:#fff;}
        .muted{opacity:.75;padding:6px 0;font-size:11px;letter-spacing:.08em;line-height:1.45;}
        .muted.light{color:rgba(255,255,255,.78);}
        .list{display:grid;gap:10px;margin-top:12px;}
        .item{border:1px solid #e2e8f0;background:#fff;border-radius:16px;padding:12px;}
        .itemTop{display:flex;justify-content:space-between;gap:10px;align-items:center;}
        .strong{font-weight:950;letter-spacing:.08em;font-size:11px;text-transform:uppercase;}
        .pill{border-radius:999px;padding:7px 10px;background:#eef2ff;color:#4338ca;font-weight:900;font-size:10px;letter-spacing:.12em;}
        .del{border-radius:12px;padding:10px 12px;border:1px solid rgba(255,80,80,.25);background:#fff1f2;font-weight:950;letter-spacing:.14em;font-size:10px;color:#991b1b;}
        @media (max-width:980px){.heroGrid,.sectionGrid{grid-template-columns:1fr;}.row,.ownersGrid{flex-direction:column;}}
      `}</style>
    </div>
  );
}
