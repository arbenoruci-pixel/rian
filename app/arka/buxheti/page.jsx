'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { findUserByPin } from '@/lib/usersDb';

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function euro(n) {
  const x = Number(n || 0);
  return `€${x.toFixed(2)}`;
}

export default function CompanyBudgetPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');

  const [showPin, setShowPin] = useState(false);
  const [pin, setPin] = useState('');
  const [pendingDay, setPendingDay] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const u = jparse(localStorage.getItem('CURRENT_USER_DATA'), null);
    if (!u) {
      router.push('/login');
      return;
    }
    setUser(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function load() {
    setErr('');
    const { data, error } = await supabase
      .from('arka_days')
      .select(
        'id,day_key,opened_by,opened_at,closed_by,closed_at,expected_cash,cash_counted,discrepancy,handoff_status,handed_by,handed_at,received_by,received_at,received_amount'
      )
      .order('day_key', { ascending: false })
      .limit(90);

    if (error) {
      setErr(error.message);
      setRows([]);
      return;
    }
    setRows(data || []);
  }

  useEffect(() => {
    if (!user) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const totalBudget = useMemo(() => {
    return (rows || []).reduce((sum, r) => sum + Number(r?.received_amount || 0), 0);
  }, [rows]);

  const canReceive = useMemo(() => {
    const role = String(user?.role || '').toUpperCase();
    return role === 'DISPATCH' || role === 'ADMIN' || role === 'OWNER';
  }, [user]);

  function openReceive(day) {
    if (!canReceive) return alert('VETËM DISPATCH/ADMIN');
    setPendingDay(day);
    setPin('');
    setShowPin(true);
  }

  function closePin() {
    setShowPin(false);
    setPin('');
    setPendingDay(null);
  }

  async function confirmReceive() {
    if (!pendingDay) return;
    const clean = String(pin).replace(/\D+/g, '').slice(0, 4);
    if (clean.length !== 4) return alert('SHKRUAJ PIN (4 SHIFRA)');

    setBusy(true);
    try {
      // validate PIN belongs to current user
      const res = await findUserByPin(clean);
      const item = res?.item || res?.user || null;
      if (!item) throw new Error('PIN I GABUAR');

      const currentId = String(user?.id || '');
      const matchId = String(item.id || item.user_id || '');
      if (currentId && matchId && currentId !== matchId) throw new Error('PIN NUK PËRPUTHET ME USER-IN');

      const amount = Number(pendingDay.cash_counted ?? pendingDay.expected_cash ?? 0);

      const { error } = await supabase
        .from('arka_days')
        .update({
          handoff_status: 'RECEIVED',
          received_by: user?.name || 'DISPATCH',
          received_at: new Date().toISOString(),
          received_amount: amount,
        })
        .eq('id', pendingDay.id);

      if (error) throw error;
      await load();
      closePin();
    } catch (e) {
      alert(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-black text-gray-200 p-4 font-sans uppercase">
      <div className="max-w-4xl mx-auto">
        <div className="arkaTop">
          <div>
            <h1 className="arkaH1">COMPANY BUDGET</h1>
            <p className="arkaMeta">
              {user.name} • {user.role} • TOTALI: {euro(totalBudget)}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={load} className="arkaGhost">RIFRESKO</button>
            <Link href="/arka/cash" className="arkaBack">KTHEHU</Link>
          </div>
        </div>

        {err ? <div className="arkaError">{err}</div> : null}

        <div className="arkaPanel">
          <div className="arkaPanelHead">
            <p className="arkaPanelTitle">DITËT / DORËZIMET</p>
            <p className="arkaCount">{rows.length} RRESHTA</p>
          </div>

          <div className="arkaList">
            {rows.length === 0 ? (
              <p className="arkaEmpty">NUK KA TË DHËNA</p>
            ) : (
              rows.map((d) => {
                const status = String(d.handoff_status || (d.received_at ? 'RECEIVED' : d.closed_at ? 'PENDING' : 'OPEN')).toUpperCase();
                const received = !!d.received_at;
                const showReceive = canReceive && !received && (status === 'HANDED' || status === 'PENDING');

                return (
                  <div key={d.id} className="arkaRow">
                    <div className="arkaRowMain">
                      <div className="arkaRowName">{d.day_key}</div>
                      <div className="arkaRowMeta">
                        <span className="arkaBadge">{status}</span>
                        {d.discrepancy != null ? <span className="arkaBadge arkaBadgeBlue">DISK: {euro(d.discrepancy)}</span> : null}
                        {received ? <span className="arkaBadge arkaBadgeGreen">PRANUAR</span> : null}
                      </div>
                      <div className="arkaSmall">
                        CASH PRITET: {euro(d.expected_cash)} • CASH REAL: {euro(d.cash_counted)} • PRANUAR: {euro(d.received_amount)}
                      </div>
                    </div>

                    <div className="arkaRowActions">
                      {showReceive ? (
                        <button onClick={() => openReceive(d)} className="arkaMini arkaMiniPrimary">PRANO</button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {showPin && (
          <div className="modalBack" onClick={closePin}>
            <div className="modalCard" onClick={(e) => e.stopPropagation()}>
              <div className="modalTitle">PRANO DORËZIMIN (PIN)</div>
              <div className="modalSub">DITA: {pendingDay?.day_key}</div>

              <input
                value={pin}
                onChange={(e) => setPin(String(e.target.value).replace(/\D+/g, '').slice(0, 4))}
                inputMode="numeric"
                placeholder="PIN (4 SHIFRA)"
                className="modalInput"
              />

              <div className="modalBtns">
                <button disabled={busy} onClick={confirmReceive} className="modalPrimary">
                  {busy ? 'DUKE RUJT...' : 'KONFIRMO'}
                </button>
                <button disabled={busy} onClick={closePin} className="modalGhost">ANULO</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .arkaTop{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:12px;margin-bottom:14px;gap:12px;}
        .arkaH1{font-size:18px;font-weight:950;letter-spacing:.06em;line-height:1.1;color:#fff;}
        .arkaMeta{font-size:10px;letter-spacing:.18em;opacity:.62;margin-top:6px;}
        .arkaBack{font-size:10px;font-weight:950;letter-spacing:.16em;padding:9px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);text-decoration:none;}
        .arkaGhost{font-size:10px;font-weight:950;letter-spacing:.16em;padding:9px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);}

        .arkaError{margin:10px 0;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,80,80,.28);background:rgba(255,80,80,.08);color:#ffd1d1;font-size:10px;letter-spacing:.14em;}

        .arkaPanel{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.09);border-radius:14px;overflow:hidden;}
        .arkaPanelHead{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08);}
        .arkaPanelTitle{font-size:10px;font-weight:950;letter-spacing:.18em;opacity:.75;}
        .arkaCount{font-size:10px;letter-spacing:.12em;opacity:.5;}
        .arkaList{padding:8px;display:flex;flex-direction:column;gap:8px;}
        .arkaEmpty{padding:28px 12px;text-align:center;font-size:10px;letter-spacing:.18em;opacity:.55;font-style:italic;}

        .arkaRow{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:10px 10px;border-radius:12px;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08);}
        .arkaRowMain{min-width:0;flex:1;}
        .arkaRowName{font-size:12px;font-weight:950;letter-spacing:.08em;}
        .arkaRowMeta{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;}
        .arkaBadge{font-size:9px;font-weight:950;letter-spacing:.14em;padding:4px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);opacity:.92;}
        .arkaBadgeGreen{border-color:rgba(0,255,170,.25);background:rgba(0,255,170,.08);}
        .arkaBadgeBlue{border-color:rgba(0,150,255,.30);background:rgba(0,150,255,.10);}
        .arkaSmall{margin-top:8px;font-size:10px;letter-spacing:.14em;opacity:.65;}

        .arkaRowActions{display:flex;gap:8px;flex-shrink:0;align-items:center;}
        .arkaMini{padding:8px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.03);font-size:10px;font-weight:950;letter-spacing:.14em;}
        .arkaMiniPrimary{border-color:rgba(0,150,255,.35);background:rgba(0,150,255,.12);color:rgba(190,230,255,.95);}

        .modalBack{position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:16px;z-index:50;}
        .modalCard{width:100%;max-width:420px;border-radius:16px;border:1px solid rgba(255,255,255,.12);background:rgba(20,20,20,.98);padding:14px;}
        .modalTitle{font-size:12px;font-weight:950;letter-spacing:.16em;color:#fff;}
        .modalSub{margin-top:6px;font-size:10px;letter-spacing:.14em;opacity:.65;}
        .modalInput{width:100%;margin-top:12px;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.16);padding:12px;border-radius:12px;font-size:18px;color:#fff;letter-spacing:.25em;text-align:center;outline:none;}
        .modalBtns{display:flex;gap:10px;margin-top:12px;}
        .modalPrimary{flex:1;background:rgba(0,150,255,.12);border:1px solid rgba(0,150,255,.35);color:rgba(190,230,255,.95);padding:10px;border-radius:12px;font-size:10px;font-weight:950;letter-spacing:.16em;}
        .modalGhost{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);font-size:10px;font-weight:950;letter-spacing:.16em;opacity:.85;}
      `}</style>
    </div>
  );
}
