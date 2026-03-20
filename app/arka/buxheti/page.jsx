'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { budgetAddMove, budgetDeleteMove, budgetListMoves } from '@/lib/companyBudgetDb';
import { isAdmin } from '@/lib/roles';

const euro = (n) =>
  `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function parseEuroInput(v) {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

function pct(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  if (!t || t <= 0) return 0;
  const out = Math.round((p / t) * 100);
  return Math.max(0, Math.min(100, out));
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function readUserFromLs() {
  try {
    return JSON.parse(localStorage.getItem('CURRENT_USER_DATA')) || null;
  } catch {
    return null;
  }
}

function readDashboardFallback() {
  try {
    return JSON.parse(localStorage.getItem('company_dashboard_cache_v1') || 'null') || null;
  } catch {
    return null;
  }
}

function saveDashboardFallback(payload) {
  try {
    localStorage.setItem('company_dashboard_cache_v1', JSON.stringify(payload));
  } catch {}
}

function normalizeMove(row = {}) {
  return {
    id: row.id,
    created_at: row.created_at,
    direction: String(row.direction || row.type || '').toUpperCase(),
    amount: Number(row.amount || 0),
    category: row.category || row.source || 'OTHER',
    reason: row.reason || row.note || '',
    note: row.note || '',
    month_key: row.month_key || null,
    created_by: row.created_by || row.created_by_name || null,
    worker_pin: row.worker_pin || null,
    worker_name: row.worker_name || null,
  };
}

export default function CompanyBudgetPage() {
  const router = useRouter();

  const [user, setUser] = useState(null);
  const [busy, setBusy] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  const [rows, setRows] = useState([]);
  const [investments, setInvestments] = useState([]);
  const [ownerBalances, setOwnerBalances] = useState([]);
  const [partners, setPartners] = useState([]);

  const [form, setForm] = useState({ type: 'OUT', amount: '', note: '' });
  const [withdrawForm, setWithdrawForm] = useState({ partner: 'OWNER 1', amount: '' });

  const canSee = useMemo(() => isAdmin(user?.role), [user?.role]);
  const monthKey = useMemo(() => currentMonthKey(), []);

  const totals = useMemo(() => {
    const ins = (rows || [])
      .filter((r) => String(r.direction || '').toUpperCase() === 'IN')
      .reduce((a, r) => a + Number(r.amount || 0), 0);
    const outs = (rows || [])
      .filter((r) => String(r.direction || '').toUpperCase() === 'OUT')
      .reduce((a, r) => a + Number(r.amount || 0), 0);
    return { ins, outs, balance: ins - outs };
  }, [rows]);

  const monthProfit = useMemo(() => {
    const monthRows = (rows || []).filter((r) => String(r.month_key || '') === monthKey || String(r.created_at || '').slice(0, 7) === monthKey);
    const ins = monthRows
      .filter((r) => String(r.direction || '').toUpperCase() === 'IN')
      .reduce((a, r) => a + Number(r.amount || 0), 0);
    const outs = monthRows
      .filter((r) => String(r.direction || '').toUpperCase() === 'OUT')
      .filter((r) => !['PARTNER', 'PARTNER_WITHDRAW'].includes(String(r.category || '').toUpperCase()))
      .reduce((a, r) => a + Number(r.amount || 0), 0);
    return ins - outs;
  }, [rows, monthKey]);

  const alreadySplitThisMonth = useMemo(() => {
    return (rows || []).some((r) => String(r.category || '').toUpperCase() === 'PARTNER' && String(r.month_key || '') === monthKey);
  }, [rows, monthKey]);

  const owners = useMemo(() => {
    const balances = Array.isArray(ownerBalances) ? ownerBalances : [];
    const partnerRows = Array.isArray(partners) && partners.length ? partners : [{ name: 'OWNER 1', percentage: 50 }, { name: 'OWNER 2', percentage: 50 }];
    return partnerRows.map((p, idx) => {
      const found = balances.find((x) => String(x.partner_name || '').toUpperCase() === String(p.name || '').toUpperCase());
      return {
        id: found?.id || p.id || idx,
        name: p.name,
        percentage: Number(p.percentage || 0),
        current_balance: Number(found?.current_balance || 0),
        total_earned: Number(found?.total_earned || 0),
        total_withdrawn: Number(found?.total_withdrawn || 0),
      };
    });
  }, [ownerBalances, partners]);

  async function reload() {
    setErr('');
    try {
      const [movesRes, investmentsRes, ownersRes, partnersRes] = await Promise.allSettled([
        budgetListMoves(500),
        supabase.from('investments').select('*').order('created_at', { ascending: false }),
        supabase.from('owner_balances').select('*').order('partner_name', { ascending: true }),
        supabase.from('company_partners').select('*').order('created_at', { ascending: true }),
      ]);

      const nextRows = movesRes.status === 'fulfilled' ? (movesRes.value || []).map(normalizeMove) : [];
      const nextInvestments = investmentsRes.status === 'fulfilled' && !investmentsRes.value?.error ? (investmentsRes.value.data || []) : [];
      const nextOwners = ownersRes.status === 'fulfilled' && !ownersRes.value?.error ? (ownersRes.value.data || []) : [];
      const nextPartners = partnersRes.status === 'fulfilled' && !partnersRes.value?.error ? (partnersRes.value.data || []) : [];

      if (!nextPartners.length) {
        const fallback = [{ name: 'OWNER 1', percentage: 50 }, { name: 'OWNER 2', percentage: 50 }];
        setPartners(fallback);
        if (!withdrawForm.partner) setWithdrawForm((f) => ({ ...f, partner: fallback[0].name }));
      } else {
        setPartners(nextPartners);
        const first = nextPartners[0]?.name || 'OWNER 1';
        setWithdrawForm((f) => ({ ...f, partner: f.partner || first }));
      }

      setRows(nextRows);
      setInvestments(nextInvestments);
      setOwnerBalances(nextOwners);

      saveDashboardFallback({ rows: nextRows, investments: nextInvestments, ownerBalances: nextOwners, partners: nextPartners });
    } catch (e) {
      const fb = readDashboardFallback();
      if (fb) {
        setRows(fb.rows || []);
        setInvestments(fb.investments || []);
        setOwnerBalances(fb.ownerBalances || []);
        setPartners(fb.partners || []);
      }
      setErr(e?.message || 'NUK U MUND TË NGARKOHET BUXHETI');
    }
  }

  useEffect(() => {
    const u = readUserFromLs();
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
    setInfo('');
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
      setInfo('LËVIZJA U RUAJT ME SUKSES.');
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
    setInfo('');
    try {
      await budgetDeleteMove(id);
      setInfo('LËVIZJA U FSHI.');
      await reload();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doSplit() {
    setErr('');
    setInfo('');
    setSplitBusy(true);
    try {
      const { data, error } = await supabase.rpc('split_company_profit');
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
      setInfo('NDARJA MUJORE U KRYE ME SUKSES.');
      await reload();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setSplitBusy(false);
    }
  }

  async function doWithdraw() {
    setErr('');
    setInfo('');
    setWithdrawBusy(true);
    try {
      const amt = parseEuroInput(withdrawForm.amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('SHUMA DUHET > 0');
      const partner = String(withdrawForm.partner || '').trim();
      if (!partner) throw new Error('ZGJIDH PRONARIN');
      const { data, error } = await supabase.rpc('owner_withdraw', {
        p_partner: partner,
        p_amount: amt,
      });
      if (error) throw error;
      if (data?.error) throw new Error(String(data.error));
      setWithdrawForm((f) => ({ ...f, amount: '' }));
      setInfo('TËRHEQJA U REGJISTRUA.');
      await reload();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setWithdrawBusy(false);
    }
  }

  if (!user) return null;

  return (
    <div className="pageWrap">
      <div className="topRow">
        <div>
          <div className="title">PROFIT DASHBOARD</div>
          <div className="sub">{String(user.name || '').toUpperCase()} • {String(user.role || '').toUpperCase()} • {monthKey}</div>
        </div>
        <div className="topActions">
          <button className="ghostBtn" type="button" onClick={() => reload()}>RIFRESKO</button>
          <Link className="ghostBtn" href="/arka">KTHEHU</Link>
        </div>
      </div>

      {err ? <div className="err">{err}</div> : null}
      {info ? <div className="ok">{info}</div> : null}

      {!canSee ? (
        <div className="card">
          <div className="cardTitle">VETËM ADMIN / DISPATCH</div>
          <div className="muted">KJO FAQE ËSHTË E MBYLLUR PËR PËRDORUESIT E TJERË.</div>
        </div>
      ) : (
        <>
          <div className="metricsGrid">
            <div className="heroCard live">
              <div className="metricLabel">💼 BUXHETI LIVE</div>
              <div className="metricValue">{euro(totals.balance)}</div>
              <div className="metricHint">PARATË AKTUALE NË BIZNES</div>
            </div>

            <div className="heroCard profit">
              <div className="metricLabel">📈 FITIMI I MUAJIT</div>
              <div className="metricValue">{euro(monthProfit)}</div>
              <div className="metricHint">HYRJE TË MUAJIT − SHPENZIME / RROGA</div>
            </div>

            <div className="heroCard splitStatus">
              <div className="metricLabel">🧮 SPLIT I MUAJIT</div>
              <div className="metricValue small">{alreadySplitThisMonth ? 'I KRYER' : 'NË PRITJE'}</div>
              <div className="metricHint">{alreadySplitThisMonth ? 'KY MUAJ ËSHTË NDA' : 'MUND TË BËSH NDARJEN MUJORE'}</div>
            </div>
          </div>

          <div className="sectionHeader">BALANCA E PRONARËVE</div>
          <div className="ownersGrid">
            {owners.map((owner, idx) => (
              <div key={owner.id || owner.name || idx} className="ownerCard">
                <div className="ownerTop">
                  <div>
                    <div className="ownerName">{String(owner.name || `OWNER ${idx + 1}`).toUpperCase()}</div>
                    <div className="ownerPct">{Number(owner.percentage || 0)}%</div>
                  </div>
                  <div className="ownerIcon">👤</div>
                </div>
                <div className="ownerBalance">{euro(owner.current_balance)}</div>
                <div className="ownerMetaRow">
                  <span>FITUAR</span>
                  <strong>{euro(owner.total_earned)}</strong>
                </div>
                <div className="ownerMetaRow">
                  <span>TËRHEQUR</span>
                  <strong>{euro(owner.total_withdrawn)}</strong>
                </div>
              </div>
            ))}
          </div>

          <div className="twoCols">
            <div className="card premiumCard">
              <div className="cardHeaderLine">
                <div>
                  <div className="cardTitle">NDARJA MUJORE E FITIMIT</div>
                  <div className="muted">SHLYEN KËSTET E INVESTIMEVE DHE NDAN PJESËN E MBETUR SIPAS % TË PRONARËVE.</div>
                </div>
                <button className="primary bigAction" disabled={splitBusy || alreadySplitThisMonth} onClick={doSplit}>
                  {splitBusy ? 'DUKE KRYER…' : alreadySplitThisMonth ? 'U NDA KËTË MUAJ' : 'KRYEJ NDARJEN MUJORE'}
                </button>
              </div>

              <div className="splitSummary">
                <div className="summaryPill"><span>IN TOTAL</span><strong>{euro(totals.ins)}</strong></div>
                <div className="summaryPill"><span>OUT TOTAL</span><strong>{euro(totals.outs)}</strong></div>
                <div className="summaryPill accent"><span>BALANCË PËR SPLIT</span><strong>{euro(totals.balance)}</strong></div>
              </div>
            </div>

            <div className="card premiumCard">
              <div className="cardTitle">TËRHEQJA E PRONARËVE</div>
              <div className="muted">KJO UL VETËM BALANCËN PERSONALE TE OWNER_BALANCES. NUK PREK MË BUXHETIN E KOMPANISË.</div>
              <div className="row compactTop">
                <select className="input" value={withdrawForm.partner} onChange={(e) => setWithdrawForm((f) => ({ ...f, partner: e.target.value }))}>
                  {owners.map((owner) => (
                    <option key={owner.name} value={owner.name}>{String(owner.name || '').toUpperCase()}</option>
                  ))}
                </select>
                <input className="input" value={withdrawForm.amount} onChange={(e) => setWithdrawForm((f) => ({ ...f, amount: e.target.value }))} placeholder="SHUMA (€)" inputMode="decimal" />
              </div>
              <button className="primary" disabled={withdrawBusy} onClick={doWithdraw}>{withdrawBusy ? 'DUKE RUAJTUR…' : 'REGJISTRO TËRHEQJEN'}</button>
            </div>
          </div>

          <div className="card premiumCard">
            <div className="cardHeaderLine">
              <div>
                <div className="cardTitle">INVESTIMET AKTIVE</div>
                <div className="muted">PËR ÇDO INVESTIM SHFAQET SA ËSHTË SHLYER, SA KA MBETUR DHE PROGRESI VIZUAL.</div>
              </div>
            </div>
            {investments.length === 0 ? (
              <div className="muted">S’KA INVESTIME AKTIVE.</div>
            ) : (
              <div className="investList">
                {investments.filter((x) => x.is_active !== false).map((inv) => {
                  const total = Number(inv.total_amount || 0);
                  const remaining = Number(inv.remaining_amount || 0);
                  const paid = Number(inv.paid_amount || Math.max(0, total - remaining));
                  const pr = pct(paid, total);
                  return (
                    <div key={inv.id} className="investItem">
                      <div className="investTop">
                        <div>
                          <div className="investName">{String(inv.name || inv.title || 'INVESTIM').toUpperCase()}</div>
                          <div className="investMeta">TOTALI {euro(total)} • KËSTI MUJOR {euro(inv.monthly_allocation)}</div>
                        </div>
                        <div className="investRight">{pr}%</div>
                      </div>
                      <div className="progressTrack"><div className="progressFill" style={{ width: `${pr}%` }} /></div>
                      <div className="investBottom">
                        <div><span>SHLYER</span><strong>{euro(paid)}</strong></div>
                        <div><span>MBETUR</span><strong>{euro(remaining)}</strong></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="twoCols historyCols">
            <div className="card">
              <div className="cardTitle">SHTO LËVIZJE MANUALE</div>
              <div className="row compactTop">
                <select className="input" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                  <option value="OUT">OUT (DALJE)</option>
                  <option value="IN">IN (HYRJE)</option>
                </select>
                <input className="input" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="SHUMA (€)" inputMode="decimal" />
              </div>
              <input className="input" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="SHËNIM" />
              <button className="primary" disabled={busy} onClick={addMove}>{busy ? 'DUKE RUJTUR…' : 'SHTO LËVIZJE'}</button>
            </div>

            <div className="card">
              <div className="cardTitle">HISTORIKU I FUNDIT</div>
              {rows.length === 0 ? (
                <div className="muted">S’KA LËVIZJE.</div>
              ) : (
                <div className="list">
                  {rows.slice(0, 18).map((r) => (
                    <div key={r.id} className="item">
                      <div className="itemTop">
                        <div>
                          <div className="strong">{euro(r.amount)} • {String(r.direction || '').toUpperCase()}</div>
                          <div className="badgeRow">
                            <span className="miniBadge">{String(r.category || 'OTHER').toUpperCase()}</span>
                            {r.month_key ? <span className="miniBadge">{String(r.month_key).toUpperCase()}</span> : null}
                          </div>
                        </div>
                        <button className="del" disabled={busy} onClick={() => del(r.id)}>FSHI</button>
                      </div>
                      {r.reason ? <div className="muted">{String(r.reason).toUpperCase()}</div> : null}
                      {r.created_at ? <div className="tiny">{new Date(r.created_at).toLocaleString('de-DE')}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <style jsx>{`
        .pageWrap{max-width:1180px;margin:0 auto;padding:18px 14px 40px;text-transform:uppercase;color:#f2f5f9;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:14px;}
        .topActions{display:flex;gap:10px;flex-wrap:wrap;}
        .title{font-size:34px;letter-spacing:1px;font-weight:950;line-height:1;}
        .sub{opacity:.75;margin-top:6px;font-size:12px;letter-spacing:.12em;font-weight:800;}
        .ghostBtn{height:40px;padding:0 14px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);display:inline-flex;align-items:center;justify-content:center;font-weight:900;letter-spacing:.12em;text-decoration:none;color:#fff;}
        .err,.ok{padding:12px 14px;border-radius:14px;margin-bottom:12px;font-weight:950;letter-spacing:.08em;font-size:11px;}
        .err{border:2px solid rgba(255,80,80,.35);background:rgba(255,0,0,.08);color:#ffd1d1;}
        .ok{border:2px solid rgba(70,220,150,.35);background:rgba(20,140,90,.12);color:#cbffe4;}
        .metricsGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px;}
        .heroCard{position:relative;overflow:hidden;border-radius:22px;padding:18px 18px 16px;border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.03));box-shadow:0 20px 50px rgba(0,0,0,.26);}
        .heroCard:before{content:'';position:absolute;inset:auto -10% -45% auto;width:180px;height:180px;border-radius:50%;filter:blur(20px);opacity:.22;}
        .live:before{background:rgba(0,180,255,.9);}
        .profit:before{background:rgba(130,90,255,.9);}
        .splitStatus:before{background:rgba(255,185,0,.95);}
        .metricLabel{font-size:11px;letter-spacing:.18em;font-weight:950;opacity:.85;}
        .metricValue{font-size:40px;line-height:1;margin-top:12px;font-weight:1000;letter-spacing:.03em;}
        .metricValue.small{font-size:28px;}
        .metricHint{margin-top:10px;font-size:10px;opacity:.74;letter-spacing:.14em;font-weight:800;}
        .sectionHeader{margin:18px 2px 10px;font-size:11px;font-weight:950;letter-spacing:.2em;opacity:.72;}
        .ownersGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:14px;}
        .ownerCard{border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(18,24,33,.94),rgba(10,12,18,.92));border-radius:20px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,.22);}
        .ownerTop{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;}
        .ownerName{font-weight:1000;letter-spacing:.16em;font-size:11px;}
        .ownerPct{opacity:.7;font-weight:900;letter-spacing:.16em;font-size:10px;margin-top:4px;}
        .ownerIcon{font-size:22px;opacity:.95;}
        .ownerBalance{font-size:34px;font-weight:1000;line-height:1.05;margin:16px 0 14px;}
        .ownerMetaRow{display:flex;justify-content:space-between;gap:12px;font-size:10px;letter-spacing:.14em;padding:6px 0;opacity:.88;}
        .ownerMetaRow strong{font-size:11px;}
        .twoCols{display:grid;grid-template-columns:1.1fr .9fr;gap:12px;margin-bottom:14px;}
        .historyCols{grid-template-columns:.95fr 1.05fr;}
        .card{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);border-radius:18px;padding:15px 15px 14px;}
        .premiumCard{background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.028));box-shadow:0 16px 36px rgba(0,0,0,.22);}
        .cardHeaderLine{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;}
        .cardTitle{font-weight:950;letter-spacing:.18em;opacity:.85;font-size:10px;margin-bottom:10px;}
        .bigAction{min-width:250px;width:auto;padding:14px 18px;}
        .splitSummary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px;}
        .summaryPill{border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.28);border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:6px;}
        .summaryPill span{font-size:10px;letter-spacing:.14em;opacity:.7;font-weight:900;}
        .summaryPill strong{font-size:18px;letter-spacing:.04em;}
        .summaryPill.accent{background:rgba(0,140,255,.12);border-color:rgba(0,170,255,.28);}
        .row{display:flex;gap:10px;}
        .compactTop{margin-top:10px;}
        .input{width:100%;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.16);padding:12px;border-radius:12px;font-size:12px;color:#fff;outline:none;letter-spacing:.08em;font-weight:900;}
        .primary{width:100%;margin-top:10px;padding:12px;border-radius:12px;border:1px solid rgba(0,150,255,.35);background:rgba(0,150,255,.12);color:rgba(190,230,255,.95);font-size:10px;font-weight:950;letter-spacing:.16em;opacity:1;}
        .primary:disabled{opacity:.55;}
        .muted{opacity:.72;padding:6px 0;font-size:10px;letter-spacing:.14em;}
        .investList{display:grid;gap:12px;}
        .investItem{border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.28);border-radius:16px;padding:14px;}
        .investTop{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;}
        .investName{font-weight:950;letter-spacing:.12em;font-size:11px;}
        .investMeta{margin-top:6px;opacity:.7;font-size:10px;letter-spacing:.13em;}
        .investRight{font-size:18px;font-weight:1000;letter-spacing:.04em;}
        .progressTrack{height:12px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;margin:12px 0 10px;border:1px solid rgba(255,255,255,.06);}
        .progressFill{height:100%;border-radius:999px;background:linear-gradient(90deg,rgba(0,180,255,.95),rgba(80,220,255,.95));box-shadow:0 0 18px rgba(0,180,255,.35);}
        .investBottom{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
        .investBottom div{display:flex;justify-content:space-between;gap:12px;font-size:10px;letter-spacing:.14em;}
        .investBottom strong{font-size:11px;}
        .list{display:grid;gap:10px;max-height:720px;overflow:auto;padding-right:2px;}
        .item{border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.35);border-radius:14px;padding:12px;}
        .itemTop{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;}
        .strong{font-weight:950;letter-spacing:.12em;font-size:11px;}
        .badgeRow{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;}
        .miniBadge{padding:5px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);font-size:9px;letter-spacing:.12em;font-weight:900;}
        .tiny{opacity:.62;font-size:10px;letter-spacing:.10em;margin-top:8px;}
        .del{border-radius:12px;padding:10px 12px;border:1px solid rgba(255,80,80,.35);background:rgba(255,80,80,.10);font-weight:950;letter-spacing:.14em;font-size:10px;color:#fff;}
        @media (max-width: 980px){
          .metricsGrid,.ownersGrid,.twoCols,.historyCols,.splitSummary,.investBottom{grid-template-columns:1fr;}
          .metricValue{font-size:32px;}
          .ownerBalance{font-size:28px;}
          .topRow{align-items:flex-start;flex-direction:column;}
          .topActions{width:100%;}
          .ghostBtn{flex:1;}
        }
      `}</style>
    </div>
  );
}
