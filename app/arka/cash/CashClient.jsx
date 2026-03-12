"use client";

// app/arka/cash/CashClient.jsx

import React, { useEffect, useMemo, useState } from "react";
import {
  dbGetActiveCycle,
  dbOpenCycle,
  dbCloseCycle,
  dbReceiveCycle,
  dbAddCycleMove,
  dbListCycleMoves,
  dbHasPendingHanded,
  dbListPendingHanded,
  dbGetCarryoverToday,
  dbListHistoryDays,
  dbListCyclesByDay,
} from "@/lib/arkaDb";

import {
  listPendingCashPayments,
  applyPendingPaymentToCycle,
  rejectPendingPayment,
  listWorkerOwedPayments,
  markOwedAsPending,
  markOwedAsAdvance,
} from "@/lib/arkaCashSync";

import { supabase } from "@/lib/supabaseClient";
import { budgetAddMove } from "@/lib/companyBudgetDb";

const euro = (n) =>
  `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

function parseEuroInput(v) {
  const s = String(v ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function Modal({ open, title, onClose, children }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal-content">
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button type="button" className="btn-close" onClick={onClose}>✕ MBYLL</button>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
}

export default function CashClient() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [debugInfo, setDebugInfo] = useState(null);

  const [user, setUser] = useState(null);
  const isDispatch = useMemo(() => String(user?.role || "").toUpperCase() === "DISPATCH", [user?.role]);
  const hasPin = useMemo(() => !!String(user?.pin || "").trim(), [user?.pin]);

  const [tab, setTab] = useState("OPEN");

  const [cycle, setCycle] = useState(null);
  const [moves, setMoves] = useState([]);
  const [carry, setCarry] = useState({ carry_cash: 0, carry_source: null, carry_person_pin: null });

  const [pendingHanded, setPendingHanded] = useState(false);
  const [handedList, setHandedList] = useState([]);

  // OPEN 
  const [openModal, setOpenModal] = useState(false);
  const [openingCash, setOpeningCash] = useState("0");
  const [openingSource, setOpeningSource] = useState("COMPANY");
  const [openingPin, setOpeningPin] = useState("");

  // MOVE
  const [moveType, setMoveType] = useState("OUT");
  const [moveAmount, setMoveAmount] = useState("");
  const [moveNote, setMoveNote] = useState("");

  // CLOSE
  const [closeModal, setCloseModal] = useState(false);
  const [cashCounted, setCashCounted] = useState("");
  const [closeReason, setCloseReason] = useState("");

  // PENDING CASH
  const [pendingPays, setPendingPays] = useState([]);
  const [pendingModal, setPendingModal] = useState(false);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingRejectNote, setPendingRejectNote] = useState("");

  // OWED (BORXH PUNETORI) - E rikthyer 100%
  const [owedPays, setOwedPays] = useState([]);
  const [owedModal, setOwedModal] = useState(false);
  const [owedBusy, setOwedBusy] = useState(false);
  const [owedNote, setOwedNote] = useState("");

  // HISTORI
  const [histDays, setHistDays] = useState([]);
  const [histSelected, setHistSelected] = useState(null);
  const [histCycles, setHistCycles] = useState([]);
  const [histLoading, setHistLoading] = useState(false);

  const sums = useMemo(() => {
    const ins = (moves || []).filter((m) => String(m.type || "").toUpperCase() === "IN").reduce((a, m) => a + Number(m.amount || 0), 0);
    const outs = (moves || []).filter((m) => String(m.type || "").toUpperCase() === "OUT").reduce((a, m) => a + Number(m.amount || 0), 0);
    return { ins, outs };
  }, [moves]);

  const expectedCash = useMemo(() => {
    const opening = Number(cycle?.opening_cash || 0);
    return opening + sums.ins - sums.outs;
  }, [cycle?.opening_cash, sums.ins, sums.outs]);

  async function refresh(mode = "ALL") {
    setErr("");
    try {
      const pending = await dbHasPendingHanded();
      setPendingHanded(!!pending);

      const c = await dbGetActiveCycle();
      setCycle(c || null);

      if (!c) {
        try {
          const co = await dbGetCarryoverToday();
          setCarry(co || { carry_cash: 0, carry_source: null, carry_person_pin: null });
        } catch { setCarry({ carry_cash: 0, carry_source: null, carry_person_pin: null }); }
        setMoves([]);
      } else {
        const list = await dbListCycleMoves(c.id);
        setMoves(Array.isArray(list) ? list : []);
        setCashCounted(String(Number(expectedCash || 0).toFixed(2)));
      }

      if (mode === "DISPATCH" || tab === "DISPATCH" || pending) {
        const list = await dbListPendingHanded();
        setHandedList(Array.isArray(list) ? list : []);
      }

      if (hasPin) {
        try {
          const res = await listPendingCashPayments(80);
          setPendingPays(Array.isArray(res?.items) ? res.items : []);
        } catch { setPendingPays([]); }
      } else {
        setPendingPays([]);
      }

      // Kthimi i Borxheve
      if (user?.name) {
        try {
          const ow = await listWorkerOwedPayments(user.name, 80);
          const rows = Array.isArray(ow?.rows) ? ow.rows : [];
          setOwedPays(rows);
          if (rows.length) setOwedModal(true);
        } catch { setOwedPays([]); }
      } else {
        setOwedPays([]);
      }

      if (mode === "HISTORI" || tab === "HISTORI") {
        setHistLoading(true);
        try {
          const days = await dbListHistoryDays(30);
          const safeDays = Array.isArray(days) ? days : [];
          setHistDays(safeDays);
          let sel = histSelected;
          if (!sel || !safeDays.find((d) => d.id === sel.id)) sel = safeDays[0] || null;
          setHistSelected(sel);
          if (sel?.id) {
            const cyc = await dbListCyclesByDay(sel.id);
            setHistCycles(Array.isArray(cyc) ? cyc : []);
          } else { setHistCycles([]); }
        } finally { setHistLoading(false); }
      }
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    try { setUser(JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "null")); } catch { setUser(null); }
  }, []);

  useEffect(() => { refresh(); }, [tab]);

  // ALERTS E REJA
  async function applyPending(p) {
    if (!cycle?.id) return alert('GABIM: HAPE ARKËN SË PARI!');
    setPendingBusy(true);
    try {
      const applied = await applyPendingPaymentToCycle({
        pending: p,
        cycle_id: cycle.id,
        approved_by_pin: user?.pin || null,
        approved_by_name: user?.name || null,
        approved_by_role: user?.role || null,
      });

      if (!applied?.ok) throw new Error(applied?.error || 'Dështoi pranim i pagesës në server!');

      setPendingPays((prev) => (prev || []).filter((x) => x.id !== p.id));
      alert('✅ Pagesa u pranua në Arkë me sukses!');
      refresh();
    } catch (e) {
      alert("❌ GABIM PRANIMI: " + (e.message || String(e)));
    } finally {
      setPendingBusy(false);
    }
  }

  async function rejectPending(p) {
    const conf = confirm("A jeni i sigurt që doni ta shënoni këtë pagesë si BORXH?");
    if (!conf) return;

    setPendingBusy(true);
    try {
      const rejected = await rejectPendingPayment({
        pending: p,
        rejected_by_pin: user?.pin || null,
        rejected_by_name: user?.name || null,
        rejected_by_role: user?.role || null,
        reject_note: pendingRejectNote || null,
      });

      if (rejected && rejected.ok === false) throw new Error(rejected.error || "Dështoi shënimi si borxh");

      setPendingPays((prev) => (prev || []).filter((x) => x.id !== p.id));
      alert('⚠️ Pagesa u kalua si BORXH me sukses!');
    } catch (e) {
      alert("❌ GABIM BORXHI: " + (e.message || String(e)));
    } finally {
      setPendingBusy(false);
    }
  }

  // FUNKSIONET ORIGJINALE
  async function onOpenCycle() {
    setErr("");
    if (pendingHanded) {
      setErr("DISPATCH DUHET ME PRANU DORËZIMIN (HANDED) PARA SE ME U HAP ARKA.");
      setTab("DISPATCH");
      return;
    }
    setBusy(true);
    try {
      const opening_cash = parseEuroInput(openingCash);
      if (Number.isNaN(opening_cash) || opening_cash < 0) throw new Error("SHUMA S’ËSHTË VALIDE.");

      const src = String(openingSource || "COMPANY").toUpperCase();
      if (!["COMPANY", "PERSONAL", "OTHER"].includes(src)) throw new Error("BURIMI DUHET: COMPANY / PERSONAL / OTHER.");

      let opening_person_pin = "";
      if (src === "PERSONAL") {
        opening_person_pin = String(openingPin || user?.pin || "").trim();
        if (!opening_person_pin) throw new Error("PIN MUNGON PËR PERSONAL.");
      }

      const opened = await dbOpenCycle({
        opening_cash,
        opening_source: src,
        opening_person_pin,
        opened_by: user?.name || "LOCAL",
        opened_by_pin: user?.pin || null,
      });

      try {
        if (src === 'COMPANY' && Number(opening_cash || 0) > 0) {
          await budgetAddMove({
            direction: 'OUT',
            amount: Number(opening_cash || 0),
            reason: 'ARKA_OPEN',
            note: `OPEN CASH → ARKË${opened?.id ? ` (CYCLE ${opened.id})` : ''}`,
            source: 'CASH',
            created_by: user?.name || 'LOCAL',
            created_by_name: user?.name || 'UNKNOWN',
            created_by_pin: user?.pin || null,
            ref_day_id: opened?.id || null,
            ref_type: 'ARKA_CYCLE',
            external_id: opened?.id ? `arka_open_${opened.id}` : null,
          });
        }
      } catch {}

      setOpenModal(false);
      await refresh();
      setTab("OPEN");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAddMove() {
    if (!cycle?.id) return;
    setErr("");
    setBusy(true);
    try {
      const amt = parseEuroInput(moveAmount);
      if (Number.isNaN(amt) || amt <= 0) throw new Error("SHUMA DUHET > 0.");

      const type = String(moveType || "OUT").toUpperCase();
      const label = type === 'IN' ? 'PREJ KUJ (IN) [KOMPANI/PERSONAL]' : 'KU SHKON (OUT) [KOMPANI/PERSONAL]';
      const raw = String(window.prompt(label, 'KOMPANI') || '').trim().toUpperCase();
      const counterparty = raw === 'PERSONAL' ? 'PERSONAL' : 'KOMPANI';

      let pin = String(user?.pin || '').trim();
      if (counterparty === 'PERSONAL') {
        pin = String(window.prompt('SHKRUAJ PIN (PERSONAL)', pin || '') || '').trim();
        if (!pin) throw new Error('PIN MUNGON (PERSONAL).');
      }

      const noteExtra = `${counterparty}`;
      const note = `${String(moveNote || '')}${String(moveNote || '').trim() ? ' • ' : ''}${noteExtra}`.trim();

      await dbAddCycleMove({
        cycle_id: cycle.id,
        type,
        amount: amt,
        note,
        source: counterparty,
        created_by_name: user?.name || "LOCAL",
        created_by_role: user?.role || null,
        created_by_pin: pin || null,
      });

      if (counterparty === 'KOMPANI') {
        const budDir = type === 'OUT' ? 'IN' : 'OUT';
        try {
          await budgetAddMove({
            direction: budDir,
            amount: amt,
            reason: 'ARKA_MANUAL',
            note: `ARKA ${type} • ${note}`,
            source: 'CASH',
            created_by: user?.id || null,
            created_by_name: user?.name || null,
            created_by_pin: pin || null,
            ref_day_id: cycle?.id || null,
            ref_type: 'ARKA_CYCLE',
            external_id: `arka_manual_${cycle?.id || 'x'}_${Date.now()}`,
          });
        } catch {}
      }
      setMoveAmount("");
      setMoveNote("");
      await refresh();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCloseCycle() {
    if (!cycle?.id) return;
    setErr("");
    setBusy(true);
    try {
      const counted = parseEuroInput(cashCounted);
      if (Number.isNaN(counted) || counted < 0) throw new Error("CASH COUNTED S’ËSHTË VALIDE.");

      const disc = Number(counted) - Number(expectedCash || 0);
      if (Math.abs(disc) >= 0.01 && !String(closeReason || "").trim()) {
        throw new Error("SHKRUJ ARSYEN PËR DISKREPANCË.");
      }

      await dbCloseCycle({
        cycle_id: cycle.id,
        expected_cash: expectedCash,
        cash_counted: counted,
        closed_by: user?.name || "LOCAL",
        closed_by_pin: user?.pin || null,
        note: String(closeReason || "").trim() || null,
      });

      setCloseModal(false);
      setCloseReason("");
      await refresh("DISPATCH");
      setTab("DISPATCH");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReceiveCycle(cycle_id) {
    if (!cycle_id) return;
    setErr("");
    if (!isDispatch) {
      setErr("VETËM DISPATCH MUND TA PRANOJË (RECEIVE) DORËZIMIN.");
      return;
    }
    setBusy(true);
    try {
      await dbReceiveCycle({ cycle_id, received_by: user?.name || "DISPATCH", received_by_pin: user?.pin || null });

      let c = (histCycles || []).find((x) => x.id === cycle_id) || null;
      try {
        const { data: fresh } = await supabase
          .from('arka_cycles')
          .select('id,cycle_no,end_cash,expected_cash,cash_counted')
          .eq('id', cycle_id)
          .maybeSingle();
        if (fresh?.id) c = { ...(c || {}), ...fresh };
      } catch {}

      const amt = Number(c?.end_cash ?? c?.cash_counted ?? c?.expected_cash ?? 0);
      if (amt > 0) {
        try {
          await budgetAddMove({
            direction: 'IN',
            amount: amt,
            reason: 'ARKA_RECEIVED',
            note: `CYCLE #${c?.cycle_no ?? ''} (RECEIVED)`,
            source: 'CASH',
            created_by: user?.name || 'DISPATCH',
            created_by_name: user?.name || 'UNKNOWN',
            created_by_pin: user?.pin || null,
            ref_day_id: cycle_id,
            ref_type: 'ARKA_CYCLE',
            external_id: `arka_receive_${cycle_id}`,
          });
        } catch (eBudget) {
          setErr((prev) => prev || (`BUXHETI S'U RUAJT: ${eBudget?.message || String(eBudget)}`));
        }
      }

      await refresh("DISPATCH");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const pendingGroups = useMemo(() => {
    const groups = new Map();
    for (const p of pendingPays || []) {
      const pin = String(p?.created_by_pin || p?.created_by_name || 'PA_PIN').trim() || 'PA_PIN';
      if (!groups.has(pin)) groups.set(pin, []);
      groups.get(pin).push(p);
    }
    return Array.from(groups.entries()).map(([pin, items]) => ({ pin, items, total: items.reduce((s, x) => s + Number(x.amount || 0), 0) })).sort((a, b) => a.pin.localeCompare(b.pin));
  }, [pendingPays]);

  return (
    <div className="cash-container">
      {/* TABS */}
      <div className="tabs">
        <button className={`tab-btn ${tab === 'OPEN' ? 'tab-active' : 'tab-inactive'}`} onClick={() => setTab("OPEN")}>OPEN (ARKË)</button>
        <button className={`tab-btn ${tab === 'DISPATCH' ? 'tab-active' : 'tab-inactive'}`} onClick={() => setTab("DISPATCH")}>DISPATCH</button>
        <button className={`tab-btn ${tab === 'HISTORI' ? 'tab-active' : 'tab-inactive'}`} onClick={() => setTab("HISTORI")}>HISTORI</button>
      </div>

      {err && <div className="error-banner">{err}</div>}

      {pendingHanded && !isDispatch && (
        <div className="alert-banner">
          <div className="alert-title">ARKA E BLLOKUAR</div>
          DISPATCH DUHET TË PRANOJË DORËZIMIN PARA SE TË VAZHDONI.
        </div>
      )}

      {/* OPEN TAB */}
      {tab === "OPEN" && (
        <div className="fade-in">
          {!cycle ? (
            <div className="card">
              <div className="card-title">HAP ARKËN E RE</div>
              {Number(carry?.carry_cash || 0) > 0 && (
                 <div className="carryover-box">
                    <strong>CARRYOVER NGA DJE:</strong> {euro(carry.carry_cash)} ({String(carry.carry_source || "COMPANY").toUpperCase()})
                 </div>
              )}
              <button className="btn-primary" disabled={busy || pendingHanded} onClick={() => setOpenModal(true)}>
                🔑 HAP ARKËN (OPEN CYCLE)
              </button>
            </div>
          ) : (
            <>
              {pendingPays?.length > 0 && (
                <button className="btn-notification" onClick={() => setPendingModal(true)}>
                  🔔 PAGESA NË PRITJE ({pendingPays.length})
                </button>
              )}

              <div className="grid-2">
                <div className="card text-center">
                  <div className="card-title text-green">HYRJE (IN)</div>
                  <div className="card-value text-green">{euro(sums.ins)}</div>
                </div>
                <div className="card text-center">
                  <div className="card-title text-red">DALJE (OUT)</div>
                  <div className="card-value text-red">{euro(sums.outs)}</div>
                </div>
              </div>

              <div className="card text-center highlight-card">
                 <div className="card-title">PRITET NË ARKË (EXPECTED)</div>
                 <div className="card-value highlight-value">{euro(expectedCash)}</div>
              </div>

              <div className="card">
                <div className="card-title">SHTO LËVIZJE MANUALISHT</div>
                <div style={{ display: "flex", gap: "10px", marginBottom: "10px" }}>
                  <select className="input-field" value={moveType} onChange={(e) => setMoveType(e.target.value)} style={{flex: 1}}>
                    <option value="IN">IN (Shto)</option>
                    <option value="OUT">OUT (Nxjerr)</option>
                  </select>
                  <input className="input-field" value={moveAmount} onChange={(e) => setMoveAmount(e.target.value)} inputMode="decimal" placeholder="€ Shuma" style={{flex: 1}} />
                </div>
                <input className="input-field" value={moveNote} onChange={(e) => setMoveNote(e.target.value)} placeholder="Shënim (Opsional)" />
                <button className="btn-primary" disabled={busy} onClick={onAddMove}>SHTO LËVIZJEN</button>
              </div>

              <div className="card">
                <div className="card-title">LËVIZJET E ARKËS</div>
                {moves?.length ? (
                  <div style={{ display: "grid", gap: "10px", marginTop: "12px" }}>
                    {moves.map((m) => {
                      const isIN = m.type === 'IN';
                      const executorName = String(m.created_by_name || m.created_by || "SISTEMI / I PANJOHUR").toUpperCase();
                      
                      return (
                        <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: "8px", border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)", borderRadius: "12px", padding: "12px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ background: isIN ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)', color: isIN ? '#34d399' : '#f87171', padding: '4px 8px', borderRadius: "6px", fontSize: "11px", fontWeight: 900 }}>
                                {String(m.type || "").toUpperCase()}
                              </span>
                              <span style={{ fontSize: "12px", fontWeight: 700, opacity: 0.8 }}>
                                {m.source === 'ORDER_PAY' ? 'PAGESË POROSIE' : 'LËVIZJE MANUALE'}
                              </span>
                            </div>
                            <div style={{ fontWeight: 900, fontSize: "16px", color: isIN ? '#34d399' : '#f87171' }}>
                              {isIN ? '+' : '-'}{euro(m.amount)}
                            </div>
                          </div>
                          <div style={{ fontSize: "13px", opacity: 0.9, fontWeight: 600 }}>📝 {m.note || 'Pa shënim'}</div>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "4px", paddingTop: "8px", borderTop: "1px dashed rgba(255,255,255,0.1)" }}>
                            <div style={{ fontSize: "11px", color: '#60a5fa', fontWeight: 900 }}>👤 NGA: {executorName}</div>
                            {m.created_at && (
                              <div style={{ fontSize: "10px", opacity: 0.5, fontWeight: 700 }}>{new Date(m.created_at).toLocaleTimeString('sq-AL', { hour: '2-digit', minute: '2-digit' })}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : <div style={{ opacity: 0.75, marginTop: "12px", fontWeight: 600, fontSize: "13px" }}>S’ka asnjë lëvizje sot.</div>}
              </div>

              <button className="btn-danger" onClick={() => { setCashCounted(String(Number(expectedCash || 0).toFixed(2))); setCloseModal(true); }}>
                🔒 MBYLLE ARKËN (DORËZO)
              </button>
            </>
          )}
        </div>
      )}

      {/* DISPATCH TAB */}
      {tab === "DISPATCH" && (
        <div className="fade-in">
          {handedList?.length ? handedList.map((h) => (
             <div key={h.id} className="card">
                <div className="flex-between">
                   <div className="card-title">CIKLI #{h.cycle_no}</div>
                   <div className="card-value">{euro(h.cash_counted ?? h.end_cash ?? 0)}</div>
                </div>
                <div style={{color: '#94A3B8', fontSize: '13px', marginTop: '5px'}}>DATA: {h.day_key}</div>
                <button className="btn-success" style={{marginTop: '15px', width: '100%'}} disabled={busy || !isDispatch} onClick={() => onReceiveCycle(h.id)}>
                   ✅ PRANO DORËZIMIN
                </button>
             </div>
          )) : <div className="card text-center" style={{color: '#94A3B8'}}>S'ka asnjë arkë për të pranuar.</div>}
        </div>
      )}

      {/* HISTORI TAB */}
      {tab === "HISTORI" && (
        <div className="fade-in card">
           <div className="card-title">ZGJIDH DITËN</div>
           <div className="grid-2">
              {histDays.map(d => (
                 <button key={d.id} className={`btn-outline ${histSelected?.id === d.id ? 'active' : ''}`} onClick={() => setHistSelected(d)}>
                    {d.day_key}
                 </button>
              ))}
           </div>
        </div>
      )}

      {/* MODAL 1: OPEN ARKËN */}
      <Modal open={openModal} title="HAP ARKËN" onClose={() => setOpenModal(false)}>
        <div style={{ display: "grid", gap: "10px" }}>
          <input className="input-field" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} inputMode="decimal" placeholder="CASH FILLESTAR (p.sh. 20)" />
          <select className="input-field" value={openingSource} onChange={(e) => setOpeningSource(e.target.value)}>
            <option value="COMPANY">BURIMI: COMPANY</option>
            <option value="PERSONAL">BURIMI: PERSONAL</option>
            <option value="OTHER">BURIMI: OTHER</option>
          </select>
          {String(openingSource).toUpperCase() === "PERSONAL" && (
            <input className="input-field" value={openingPin} onChange={(e) => setOpeningPin(e.target.value)} inputMode="numeric" placeholder="PIN I PERSONIT (PERSONAL)" />
          )}
          <button className="btn-primary" disabled={busy} onClick={onOpenCycle}>KONFIRMO → HAP</button>
        </div>
      </Modal>

      {/* MODAL 2: MBYLL ARKËN */}
      <Modal open={closeModal} title="MBYLLE ARKËN" onClose={() => setCloseModal(false)}>
         <div style={{ display: "grid", gap: "10px" }}>
            <div style={{ fontWeight: 950, letterSpacing: "2px", opacity: 0.9, color: "white", marginBottom: "10px" }}>
              EXPECTED: {euro(expectedCash)}
            </div>
            <input className="input-field" value={cashCounted} onChange={(e) => setCashCounted(e.target.value)} inputMode="decimal" placeholder="CASH COUNTED (sa i numrove)" />
            <textarea className="input-field" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="NËSE KA DISKREPANCË — SHKRUJ ARSYEN" rows={3} />
            <button className="btn-danger" disabled={busy} onClick={onCloseCycle}>KONFIRMO → HANDED</button>
         </div>
      </Modal>

      {/* MODAL 3: PAGESAT E PRITJES */}
      <Modal open={pendingModal} title={`PAGESAT NË PRITJE (${pendingPays?.length || 0})`} onClose={() => setPendingModal(false)}>
        {!pendingPays?.length ? (
          <div style={{ textAlign: 'center', color: '#94A3B8', padding: '20px', fontWeight: 600 }}>S’ka asnjë pagesë të mbetur jashtë arkës! 🎉</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ fontSize: '13px', color: '#CBD5E1', fontWeight: 500, lineHeight: 1.4 }}>Këto pagesa janë bërë gjatë kohës që arka ishte e mbyllur. A i keni paratë fizikisht?</div>
            <input className="input-field" value={pendingRejectNote} onChange={(e) => setPendingRejectNote(e.target.value)} placeholder="Shënim për Borxh (Opsional)" />
            <div style={{ display: "grid", gap: '16px' }}>
              {pendingGroups.map((g) => (
                <div key={g.pin} className="pending-group">
                  <div className="flex-between" style={{ marginBottom: '12px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
                    <div style={{ fontWeight: 800, color: '#F8FAFC', fontSize: '15px' }}>👤 {g.pin === 'PA_PIN' ? 'TË PANJOHUR' : g.pin}</div>
                    <div className="text-euro">{euro(g.total)}</div>
                  </div>
                  <div style={{ display: "grid", gap: '10px' }}>
                    {g.items.map((p) => (
                      <div key={p.id} className="pending-item">
                        <div className="flex-between" style={{ marginBottom: '12px' }}>
                          <div>
                            <strong style={{ fontSize: '15px', color: '#F8FAFC', display: 'block', marginBottom: '2px' }}>Porosia #{String(p.order_code || "").replace("#","")}</strong>
                            <span style={{ fontSize: '12px', color: '#94A3B8', fontWeight: 600 }}>{String(p.client_name || "Klient i panjohur").toUpperCase()}</span>
                          </div>
                          <div style={{ fontSize: '16px', fontWeight: 900, color: '#F8FAFC' }}>{euro(p.amount)}</div>
                        </div>
                        <div className="btn-grid">
                          <button className="btn-prano" disabled={pendingBusy} onClick={() => applyPending(p)}>✅ PRANO</button>
                          <button className="btn-borxh" disabled={pendingBusy} onClick={() => rejectPending(p)}>❌ BORXH</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* MODAL 4: BORXHI I PUNËTORIT (I RIKTHYER I GJITHI ME DIZAJNIN E RI) */}
      <Modal open={owedModal} title={`BORXH I PUNTORIT (${owedPays?.length || 0})`} onClose={() => setOwedModal(false)}>
        {!owedPays?.length ? (
          <div style={{ textAlign: 'center', color: '#94A3B8', padding: '20px', fontWeight: 600 }}>S’ka asnjë borxh aktiv.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ fontSize: '13px', color: '#CBD5E1', fontWeight: 500, lineHeight: 1.4 }}>
              Këto pagesa janë shënuar si BORXH për ty. Zgjidh nëse i ke dorëzuar paratë apo po i mban si avans:
            </div>
            
            <input className="input-field" value={owedNote} onChange={(e) => setOwedNote(e.target.value)} placeholder="Shënim (Opsional)" />

            <div style={{ display: "grid", gap: '12px' }}>
              {owedPays.map((p) => (
                <div key={p.id || p.external_id || p.externalId} className="pending-item">
                  <div className="flex-between" style={{ marginBottom: '12px' }}>
                    <div>
                      <strong style={{ fontSize: '15px', color: '#F8FAFC', display: 'block', marginBottom: '2px' }}>
                        #{String(p.order_code || p.code || p.orderCode || "").replace("#", "")}
                      </strong>
                      <span style={{ fontSize: '12px', color: '#94A3B8', fontWeight: 600 }}>
                        {String(p.client_name || p.name || p.clientName || "KLIENT").toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: '16px', fontWeight: 900, color: '#F8FAFC' }}>
                      {euro(p.amount || 0)}
                    </div>
                  </div>

                  <div className="btn-grid">
                    <button className="btn-primary" style={{backgroundColor: '#F8FAFC', color: '#0F172A'}} disabled={owedBusy} onClick={async () => {
                        setOwedBusy(true);
                        try {
                          await markOwedAsPending({ pending: p, actor: user });
                          await refresh();
                          if (owedPays.length <= 1) setOwedModal(false);
                        } finally { setOwedBusy(false); }
                      }}>
                      💵 DORËZOVA PARET
                    </button>

                    <button className="btn-outline" style={{backgroundColor: 'rgba(255,255,255,0.05)', color: '#F8FAFC'}} disabled={owedBusy} onClick={async () => {
                        setOwedBusy(true);
                        try {
                          await markOwedAsAdvance({ pending: p, actor: user, note: owedNote });
                          await refresh();
                          if (owedPays.length <= 1) setOwedModal(false);
                        } finally { setOwedBusy(false); }
                      }}>
                      💳 PRANO AVANS
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* STILI CSS I PASTËR DHE PREMIUM */}
      <style jsx>{`
        .cash-container { padding: 16px; max-width: 600px; margin: 0 auto; font-family: system-ui, sans-serif; }
        .tabs { display: flex; gap: 8px; margin-bottom: 20px; background: #0F172A; padding: 6px; border-radius: 16px; border: 1px solid #1E293B; }
        .tab-btn { flex: 1; padding: 12px 0; border-radius: 12px; font-weight: 800; font-size: 13px; border: none; cursor: pointer; transition: 0.3s; }
        .tab-active { background: #3B82F6; color: white; box-shadow: 0 4px 10px rgba(59,130,246,0.3); }
        .tab-inactive { background: transparent; color: #64748B; }
        .card { background: #1E293B; border-radius: 20px; padding: 20px; margin-bottom: 16px; border: 1px solid #334155; }
        .highlight-card { background: linear-gradient(135deg, #1E3A8A, #1D4ED8); border: none; }
        .card-title { font-size: 12px; font-weight: 800; color: #94A3B8; letter-spacing: 1.5px; margin-bottom: 8px; text-transform: uppercase; }
        .highlight-card .card-title { color: #BFDBFE; }
        .card-value { font-size: 24px; font-weight: 900; color: #F8FAFC; }
        .highlight-value { font-size: 28px; color: #FFF; }
        .carryover-box { background: rgba(255,255,255,0.05); padding: 12px; border-radius: 12px; margin-bottom: 16px; color: #E2E8F0; font-size: 14px; }
        
        .btn-primary { width: 100%; background: #3B82F6; color: white; padding: 14px; border-radius: 14px; font-weight: 800; font-size: 14px; letter-spacing: 1px; border: none; cursor: pointer; transition: 0.2s; }
        .btn-success { background: #10B981; color: white; padding: 14px; border-radius: 14px; font-weight: 800; border: none; cursor: pointer; }
        .btn-danger { width: 100%; background: #EF4444; color: white; padding: 14px; border-radius: 14px; font-weight: 800; letter-spacing: 1px; border: none; cursor: pointer; }
        .btn-notification { width: 100%; background: #F59E0B; color: #451A03; padding: 14px; border-radius: 14px; font-weight: 900; letter-spacing: 1px; border: none; cursor: pointer; margin-bottom: 16px; box-shadow: 0 4px 10px rgba(245,158,11,0.2); }
        .btn-outline { background: transparent; color: #94A3B8; border: 1px solid #334155; padding: 10px; border-radius: 10px; font-weight: 800; cursor: pointer; border: none; }
        .btn-outline.active { background: #3B82F6; color: white; border-color: #3B82F6; }
        
        .input-field { width: 100%; padding: 14px; border-radius: 14px; border: 1px solid #334155; background: #0F172A; color: white; font-weight: 700; font-size: 15px; margin-bottom: 12px; outline: none; box-sizing: border-box; }
        .input-field:focus { border-color: #3B82F6; }
        
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .flex-between { display: flex; justify-content: space-between; align-items: center; }
        .text-green { color: #10B981 !important; }
        .text-red { color: #EF4444 !important; }
        .text-center { text-align: center; }
        
        .error-banner { background: #7F1D1D; color: #FECACA; padding: 14px; border-radius: 14px; font-weight: 700; margin-bottom: 16px; border: 1px solid #991B1B; }
        .alert-banner { background: #78350F; color: #FDE68A; padding: 14px; border-radius: 14px; font-weight: 700; margin-bottom: 16px; border: 1px solid #92400E; }
        
        /* Modal & Pending Items */
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); backdrop-filter: blur(4px); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .modal-content { width: 100%; max-width: 480px; max-height: 85vh; overflow-y: auto; background: #0F172A; border: 1px solid #334155; border-radius: 24px; padding: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.8); }
        .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .modal-title { font-size: 17px; font-weight: 800; color: #F8FAFC; text-transform: uppercase; }
        .btn-close { background: #1E293B; color: #94A3B8; border: none; padding: 8px 12px; border-radius: 10px; font-weight: 800; cursor: pointer; }
        
        .pending-group { background: #1E293B; border-radius: 16px; padding: 16px; border: 1px solid #334155; }
        .pending-item { background: #0F172A; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-top: 10px; }
        .text-euro { font-size: 18px; font-weight: 900; color: #10B981; }
        .btn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
        .btn-prano { background: #059669; color: white; font-weight: 800; padding: 12px; border-radius: 10px; border: none; cursor: pointer; transition: 0.2s; }
        .btn-borxh { background: #DC2626; color: white; font-weight: 800; padding: 12px; border-radius: 10px; border: none; cursor: pointer; transition: 0.2s; }
        .btn-prano:disabled, .btn-borxh:disabled, .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </div>
  );
}
