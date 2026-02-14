// app/arka/cash/CashClient.jsx
"use client";

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
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.75)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        style={{
          width: "min(720px, 100%)",
          maxHeight: "85vh",
          overflow: "auto",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 16,
          padding: 14,
          background: "rgba(10,14,24,0.96)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontWeight: 950, letterSpacing: 2 }}>{title}</div>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 10px",
              borderRadius: 12,
              fontWeight: 950,
              letterSpacing: 2,
            }}
          >
            MBYLL
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

export default function CashClient() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [debugInfo, setDebugInfo] = useState(null);

  const [user, setUser] = useState(null);
  const isDispatch = useMemo(
    () => String(user?.role || "").toUpperCase() === "DISPATCH",
    [user?.role]
  );
  const hasPin = useMemo(() => !!String(user?.pin || "").trim(), [user?.pin]);

  const [tab, setTab] = useState("OPEN"); // OPEN | DISPATCH | HISTORI

  const [cycle, setCycle] = useState(null);
  const [moves, setMoves] = useState([]);
  const [carry, setCarry] = useState({
    carry_cash: 0,
    carry_source: null,
    carry_person_pin: null,
  });

  const [pendingHanded, setPendingHanded] = useState(false);
  const [handedList, setHandedList] = useState([]);

  // OPEN (wizard)
  const [openModal, setOpenModal] = useState(false);
  const [openingCash, setOpeningCash] = useState("0");
  const [openingSource, setOpeningSource] = useState("COMPANY");
  const [openingPin, setOpeningPin] = useState("");

  // MOVE
  const [moveType, setMoveType] = useState("OUT");
  const [moveAmount, setMoveAmount] = useState("");
  const [moveNote, setMoveNote] = useState("");

  // CLOSE (wizard)
  const [closeModal, setCloseModal] = useState(false);
  const [cashCounted, setCashCounted] = useState("");
  const [closeReason, setCloseReason] = useState("");

  // Pending cash payments (non-blocking)
  const [pendingPays, setPendingPays] = useState([]);
  const [pendingModal, setPendingModal] = useState(false);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingRejectNote, setPendingRejectNote] = useState("");

  // Worker OWED (when ARKA closed and DISPATCH marked BORXH)
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
    const ins = (moves || [])
      .filter((m) => String(m.type || "").toUpperCase() === "IN")
      .reduce((a, m) => a + Number(m.amount || 0), 0);
    const outs = (moves || [])
      .filter((m) => String(m.type || "").toUpperCase() === "OUT")
      .reduce((a, m) => a + Number(m.amount || 0), 0);
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
        } catch {
          setCarry({ carry_cash: 0, carry_source: null, carry_person_pin: null });
        }
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
          const res = await listPendingCashPayments(200);
          setPendingPays(Array.isArray(res?.items) ? res.items : []);
        } catch {
          setPendingPays([]);
        }
      } else {
        setPendingPays([]);
      }


      // ✅ If a worker has OWED items (DISPATCH marked BORXH), show worker confirmation popup
      if (user?.name) {
        try {
          const ow = await listWorkerOwedPayments(user.name, 200);
          const rows = Array.isArray(ow?.rows) ? ow.rows : [];
          setOwedPays(rows);
          if (rows.length) setOwedModal(true);
        } catch {
          setOwedPays([]);
        }
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
          } else {
            setHistCycles([]);
          }
        } finally {
          setHistLoading(false);
        }
      }
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "null");
      setUser(u || null);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

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

      // LIDHJA ME BUXHETIN E KOMPANISË (DISPATCH LEDGER)
      // Kur ARKA hapet me burim COMPANY, kjo do të thotë që cash-i është marrë nga buxheti i kompanisë
      // dhe është futur në ARKË (daily cash). Prandaj e regjistrojmë si OUT në company_budget_moves.
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
      } catch {
        // non-blocking: mos e ndal hapjen e ARKËS nese buxheti s'ruhet (RLS ose tabela mungon)
      }

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

      // STRICT: çdo lëvizje manuale duhet me pas "KU SHKON / PREJ KUJ".
      // - KOMPANI: pasqyrohet në company_budget_moves (me drejtim të kundërt)
      // - PERSONAL: kërkon PIN + ruhet kush e autorizoi
      const type = String(moveType || "OUT").toUpperCase();
      const label = type === 'IN' ? 'PREJ KUJ (IN) [KOMPANI/PERSONAL]' : 'KU SHKON (OUT) [KOMPANI/PERSONAL]';
      const raw = String(window.prompt(label, 'KOMPANI') || '').trim().toUpperCase();
      const counterparty = raw === 'PERSONAL' ? 'PERSONAL' : 'KOMPANI';

      let pin = String(user?.pin || '').trim();
      if (counterparty === 'PERSONAL') {
        pin = String(window.prompt('SHKRUAJ PIN (PERSONAL)', pin || '') || '').trim();
        if (!pin) throw new Error('PIN MUNGON (PERSONAL).');
      }

      // PIN stays hidden: do not embed it in any human-visible note.
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

      // Mirror në BUXHET vetëm kur counterparty është KOMPANI
      if (counterparty === 'KOMPANI') {
        // ARKA OUT -> BUXHET IN (cash u transferua te kompania/banka)
        // ARKA IN  -> BUXHET OUT (kompania dha cash në arkë)
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
        } catch {
          // non-blocking
        }
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

      // If discrepancy, require a reason (stops silent anomalies)
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

      // Mirror RECEIVED cash into the company budget ledger.
      // Mos u mbështet vetëm te histCycles (mund të jetë stale). Lexoje direkt nga DB.
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
          // Mos e ndal RECEIVE nese buxheti s'ruhet (p.sh. RLS / policy). Jep vetëm një warning.
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

  const arkaLocked = pendingHanded && !isDispatch;

  // pending cash groups by PIN
  const pendingGroups = useMemo(() => {
    const groups = new Map();
    for (const p of pendingPays || []) {
      // Prefer PIN; fall back to name; always return a safe string.
      const pin = String(p?.created_by_pin || p?.created_by_name || 'PA_PIN').trim() || 'PA_PIN';
      if (!groups.has(pin)) groups.set(pin, []);
      groups.get(pin).push(p);
    }
    return Array.from(groups.entries())
      .map(([pin, items]) => ({ pin, items, total: items.reduce((s, x) => s + Number(x.amount || 0), 0) }))
      .sort((a, b) => a.pin.localeCompare(b.pin));
  }, [pendingPays]);

  async function applyPending(p) {
    if (!cycle?.id) {
      setErr('HAPE ARKËN (duhet me pas CYCLE OPEN) pastaj PRANO PENDING.');
      return;
    }
    setPendingBusy(true);
    try {
      setDebugInfo(null);
      const applied = await applyPendingPaymentToCycle({
        pending: p,
        cycle_id: cycle.id,
        approved_by_pin: user?.pin || null,
        approved_by_name: user?.name || null,
        approved_by_role: user?.role || null,
      });
      if (!applied?.ok) {
        throw new Error(applied?.error || 'PRANO_FAILED');
      }
      const res = await listPendingCashPayments(200);
      setPendingPays(Array.isArray(res?.items) ? res.items : []);
      await refresh();
    } catch (e) {
      const msg = e?.message || String(e);
      setErr(msg.includes('RLS_BLOCKED_UPDATE') ? 'NUK U PRANUA (RLS/POLICY). DUHET SQL POLICY PER arka_pending_payments UPDATE.' : msg);
      setDebugInfo({
        action: 'PRANO',
        pending_id: p?.id || null,
        external_id: p?.external_id || null,
        order_id: p?.order_id || null,
        cycle_id: cycle?.id || null,
        user: { pin: user?.pin || null, name: user?.name || null, role: user?.role || null },
        error: msg,
        raw: e && typeof e === 'object' ? e : null,
      });
    } finally {
      setPendingBusy(false);
    }
  }

  async function rejectPending(p) {
    setPendingBusy(true);
    try {
      setDebugInfo(null);
      await rejectPendingPayment({
        pending: p,
        rejected_by_pin: user?.pin || null,
        rejected_by_name: user?.name || null,
        rejected_by_role: user?.role || null,
        reject_note: pendingRejectNote || null,
      });
      const res = await listPendingCashPayments(200);
      setPendingPays(Array.isArray(res?.items) ? res.items : []);
      await refresh();
    } catch (e) {
      const msg = e?.message || String(e);
      setErr(msg);
      setDebugInfo({
        action: 'BORXH',
        pending_id: p?.id || null,
        external_id: p?.external_id || null,
        order_id: p?.order_id || null,
        cycle_id: cycle?.id || null,
        user: { pin: user?.pin || null, name: user?.name || null, role: user?.role || null },
        error: msg,
        raw: e && typeof e === 'object' ? e : null,
      });
    } finally {
      setPendingBusy(false);
    }
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <button
          onClick={() => setTab("OPEN")}
          style={{ flex: 1, padding: 12, borderRadius: 14, fontWeight: 950, letterSpacing: 2, opacity: tab === "OPEN" ? 1 : 0.6 }}
        >
          OPEN
        </button>
        <button
          onClick={() => setTab("DISPATCH")}
          style={{ flex: 1, padding: 12, borderRadius: 14, fontWeight: 950, letterSpacing: 2, opacity: tab === "DISPATCH" ? 1 : 0.6 }}
        >
          DISPATCH
        </button>
        <button
          onClick={() => setTab("HISTORI")}
          style={{ flex: 1, padding: 12, borderRadius: 14, fontWeight: 950, letterSpacing: 2, opacity: tab === "HISTORI" ? 1 : 0.6 }}
        >
          HISTORI
        </button>
      </div>

      {err ? (
        <div style={{ border: "2px solid #7a1a1a", color: "#fff", padding: 12, borderRadius: 12, marginBottom: 12 }}>
          {err}
          {debugInfo ? (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 900, letterSpacing: 2 }}>DETAILS</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 8, fontSize: 12, opacity: 0.95 }}>
                {JSON.stringify(debugInfo, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {arkaLocked ? (
        <div style={{ border: "2px solid #7a1a1a", color: "#fff", padding: 14, borderRadius: 14 }}>
          <div style={{ fontWeight: 950, letterSpacing: 2, marginBottom: 6 }}>ARKA E BLLOKUAR</div>
          DISPATCH DUHET ME PRANU DORËZIMIN (HANDED) PARA SE ME VAZHDU.
          <div style={{ marginTop: 10 }}>
            <button
              onClick={() => setTab("DISPATCH")}
              style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 950, letterSpacing: 2 }}
            >
              SHKO TE DISPATCH
            </button>
          </div>
        </div>
      ) : null}

      {/* OPEN */}
      {tab === "OPEN" ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ opacity: 0.85, letterSpacing: 2, fontWeight: 950 }}>SOT: {dayKeyLocal(new Date())}</div>

          {!cycle ? (
            <>
              {Number(carry?.carry_cash || 0) > 0 ? (
                <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                  <div style={{ fontWeight: 950, letterSpacing: 2, opacity: 0.9 }}>CARRYOVER</div>
                  <div style={{ marginTop: 6, fontWeight: 950 }}>
                    {euro(carry.carry_cash)} · {String(carry.carry_source || "COMPANY").toUpperCase()}
                    {String(carry.carry_source || "").toUpperCase() === "PERSONAL" && carry.carry_person_pin ? (
                      <></>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <button
                disabled={busy || pendingHanded}
                onClick={() => {
                  // prefill with carryover if available
                  if (Number(carry?.carry_cash || 0) > 0) {
                    setOpeningCash(String(Number(carry.carry_cash || 0)));
                    setOpeningSource(String(carry.carry_source || "COMPANY").toUpperCase());
                    setOpeningPin(String(carry.carry_person_pin || ""));
                  }
                  setOpenModal(true);
                }}
                style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 950, letterSpacing: 2, opacity: busy || pendingHanded ? 0.6 : 1 }}
              >
                HAP ARKËN (CYCLE)
              </button>

              <Modal open={openModal} title="HAP ARKËN" onClose={() => setOpenModal(false)}>
                <div style={{ display: "grid", gap: 10 }}>
                  <input
                    value={openingCash}
                    onChange={(e) => setOpeningCash(e.target.value)}
                    inputMode="decimal"
                    placeholder="CASH FILLESTAR (p.sh. 20)"
                    style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 950, letterSpacing: 1 }}
                  />
                  <select
                    value={openingSource}
                    onChange={(e) => setOpeningSource(e.target.value)}
                    style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 950, letterSpacing: 1 }}
                  >
                    <option value="COMPANY">BURIMI: COMPANY</option>
                    <option value="PERSONAL">BURIMI: PERSONAL</option>
                    <option value="OTHER">BURIMI: OTHER</option>
                  </select>
                  {String(openingSource).toUpperCase() === "PERSONAL" ? (
                    <input
                      value={openingPin}
                      onChange={(e) => setOpeningPin(e.target.value)}
                      inputMode="numeric"
                      placeholder="PIN I PERSONIT (PERSONAL)"
                      style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 950, letterSpacing: 1 }}
                    />
                  ) : null}
                  <button
                    disabled={busy}
                    onClick={onOpenCycle}
                    style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 950, letterSpacing: 2, opacity: busy ? 0.6 : 1 }}
                  >
                    KONFIRMO → HAP
                  </button>
                </div>
              </Modal>
            </>
          ) : (
            <>
              <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 950, letterSpacing: 2, opacity: 0.9 }}>STATUS: {cycle.handoff_status}</div>
                <div style={{ marginTop: 6, fontWeight: 950, letterSpacing: 1.5 }}>
                  FILLIMI: {euro(cycle.opening_cash)} · {String(cycle.opening_source || "").toUpperCase()}
                  {String(cycle.opening_source || "").toUpperCase() === "PERSONAL" && cycle.opening_person_pin ? (
                    <></>
                  ) : null}
                </div>
              </div>

              {pendingPays?.length ? (
                <button
                  type="button"
                  onClick={() => setPendingModal(true)}
                  style={{ width: "100%", padding: 12, borderRadius: 14, fontWeight: 950, letterSpacing: 2 }}
                >
                  CASH KUR ARKA KA QENË E MBYLLUR ({pendingPays.length})
                </button>
              ) : null}

              <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 950, letterSpacing: 2 }}>
                  <div>IN</div>
                  <div>{euro(sums.ins)}</div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 950, letterSpacing: 2, marginTop: 6 }}>
                  <div>OUT</div>
                  <div>{euro(sums.outs)}</div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 950, letterSpacing: 2, marginTop: 10 }}>
                  <div>EXPECTED CASH</div>
                  <div>{euro(expectedCash)}</div>
                </div>
              </div>

              <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 950, letterSpacing: 2, opacity: 0.9 }}>SHTO LËVIZJE</div>
                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <select
                    value={moveType}
                    onChange={(e) => setMoveType(e.target.value)}
                    style={{ flex: 1, padding: 12, borderRadius: 12, fontWeight: 950, letterSpacing: 1 }}
                  >
                    <option value="IN">IN</option>
                    <option value="OUT">OUT</option>
                  </select>
                  <input
                    value={moveAmount}
                    onChange={(e) => setMoveAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="€"
                    style={{ flex: 1, padding: 12, borderRadius: 12, fontWeight: 950, letterSpacing: 1 }}
                  />
                </div>
                <input
                  value={moveNote}
                  onChange={(e) => setMoveNote(e.target.value)}
                  placeholder="SHËNIM (opsional)"
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 1, marginTop: 10 }}
                />
                <button
                  disabled={busy}
                  onClick={onAddMove}
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 950, letterSpacing: 2, marginTop: 10, opacity: busy ? 0.6 : 1 }}
                >
                  SHTO
                </button>
              </div>

              <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 950, letterSpacing: 2, opacity: 0.9 }}>LËVIZJET</div>
                {moves?.length ? (
                  <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                    {moves.map((m) => (
                      <div
                        key={m.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          border: "1px solid rgba(255,255,255,0.10)",
                          borderRadius: 12,
                          padding: 10,
                        }}
                      >
                        <div style={{ fontWeight: 950, letterSpacing: 2 }}>
                          {String(m.type || "").toUpperCase()}
                          {m.note ? <span style={{ opacity: 0.8, letterSpacing: 1 }}> · {m.note}</span> : null}
                        </div>
                        <div style={{ fontWeight: 950 }}>{euro(m.amount)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ opacity: 0.75, marginTop: 8 }}>S’KA LËVIZJE.</div>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setCashCounted(String(Number(expectedCash || 0).toFixed(2)));
                  setCloseReason("");
                  setCloseModal(true);
                }}
                style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 950, letterSpacing: 2 }}
              >
                MBYLLE ARKËN → HANDED
              </button>

              <Modal open={closeModal} title="MBYLLE ARKËN" onClose={() => setCloseModal(false)}>
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ fontWeight: 950, letterSpacing: 2, opacity: 0.9 }}>
                    EXPECTED: {euro(expectedCash)}
                  </div>
                  <input
                    value={cashCounted}
                    onChange={(e) => setCashCounted(e.target.value)}
                    inputMode="decimal"
                    placeholder="CASH COUNTED (sa i numrove)"
                    style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 950, letterSpacing: 1 }}
                  />
                  <textarea
                    value={closeReason}
                    onChange={(e) => setCloseReason(e.target.value)}
                    placeholder="NËSE KA DISKREPANCË — SHKRUJ ARSYEN"
                    rows={3}
                    style={{ width: "100%", padding: 12, borderRadius: 14, fontWeight: 900, letterSpacing: 1 }}
                  />
                  <button
                    disabled={busy}
                    onClick={onCloseCycle}
                    style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 950, letterSpacing: 2, opacity: busy ? 0.6 : 1 }}
                  >
                    KONFIRMO → HANDED
                  </button>
                </div>
              </Modal>
            </>
          )}
        </div>
      ) : null}

      {/* DISPATCH */}
      {tab === "DISPATCH" ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ opacity: 0.85, fontWeight: 950, letterSpacing: 2 }}>DORËZIMET (HANDED)</div>
          {handedList?.length ? (
            handedList.map((h) => (
              <div key={h.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 950, letterSpacing: 2, opacity: 0.9 }}>
                    {h.day_key} · CIKLI {h.cycle_no}
                  </div>
                  <div style={{ fontWeight: 950 }}>{euro(h.cash_counted ?? h.end_cash ?? 0)}</div>
                </div>
                <div style={{ marginTop: 8, opacity: 0.8, fontWeight: 900 }}>STATUS: {h.handoff_status}</div>
                <button
                  disabled={busy || !isDispatch}
                  onClick={() => onReceiveCycle(h.id)}
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 950, letterSpacing: 2, marginTop: 10, opacity: busy || !isDispatch ? 0.6 : 1 }}
                >
                  PRANO → RECEIVED
                </button>
              </div>
            ))
          ) : (
            <div style={{ opacity: 0.75 }}>S’KA DORËZIME PËR PRANIM.</div>
          )}
        </div>
      ) : null}

      {/* HISTORI */}
      {tab === "HISTORI" ? (
        <div style={{ opacity: 0.95 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontWeight: 950, letterSpacing: 2 }}>HISTORI</div>
            <button
              onClick={() => refresh("HISTORI")}
              style={{ padding: "8px 12px", borderRadius: 12, fontWeight: 950, letterSpacing: 2, opacity: histLoading ? 0.6 : 1 }}
            >
              REFRESH
            </button>
          </div>

          <div style={{ marginTop: 12, opacity: 0.8, fontWeight: 950, letterSpacing: 2 }}>DITËT (30)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginTop: 10 }}>
            {histDays?.length ? (
              histDays.map((d) => {
                const active = histSelected?.id === d.id;
                const isClosed = !!d.closed_at;
                return (
                  <button
                    key={d.id}
                    onClick={async () => {
                      setHistSelected(d);
                      setHistLoading(true);
                      try {
                        const cycles = await dbListCyclesByDay(d.id);
                        setHistCycles(Array.isArray(cycles) ? cycles : []);
                      } finally {
                        setHistLoading(false);
                      }
                    }}
                    style={{
                      padding: 12,
                      borderRadius: 14,
                      border: active ? "1px solid rgba(120,180,255,0.9)" : "1px solid rgba(255,255,255,0.16)",
                      background: active ? "rgba(20,40,70,0.65)" : "rgba(0,0,0,0.15)",
                      textAlign: "left",
                      opacity: histLoading ? 0.7 : 1,
                    }}
                  >
                    <div style={{ fontWeight: 950, letterSpacing: 1 }}>{d.day_key}</div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>{isClosed ? "MBYLLUR ✅" : "HAPUR 🟡"}</div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>PRITET: {euro(d.expected_cash)}</div>
                  </button>
                );
              })
            ) : (
              <div style={{ opacity: 0.75 }}>S’KA TË DHËNA.</div>
            )}
          </div>

          {histSelected ? (
            <div style={{ marginTop: 16 }}>
              <div style={{ opacity: 0.8, fontWeight: 950, letterSpacing: 2 }}>CIKLET — {histSelected.day_key}</div>
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {histCycles?.length ? (
                  histCycles.map((c) => (
                    <div key={c.id} style={{ border: "1px solid rgba(255,255,255,0.16)", borderRadius: 14, padding: 12, background: "rgba(0,0,0,0.15)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontWeight: 950, letterSpacing: 1 }}>CIKLI #{c.cycle_no}</div>
                        <div style={{ fontWeight: 950, opacity: 0.9 }}>{c.handoff_status || c.status}</div>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                        PRITET: {euro(c.expected_cash)} • NUMRUAR: {euro(c.cash_counted)} • DISK: {euro(c.discrepancy)}
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ opacity: 0.75 }}>S’KA CIKLE PËR KËTË DITË.</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Pending cash payments modal (NON-BLOCKING) */}
      <Modal
        open={pendingModal}
        title={`CASH KUR ARKA KA QENË E MBYLLUR (${pendingPays?.length || 0})`}
        onClose={() => setPendingModal(false)}
      >
        {!pendingPays?.length ? (
          <div style={{ opacity: 0.8, fontWeight: 900 }}>S’KA PAGESA NË PRITJE.</div>
        ) : (
          <>
            <div style={{ opacity: 0.85, fontWeight: 950, letterSpacing: 1.5 }}>
              DUHET ME I KONFIRMU: PRANO N&apos;ARKË OSE SHËNO BORXH.
            </div>
            <input
              value={pendingRejectNote}
              onChange={(e) => setPendingRejectNote(e.target.value)}
              placeholder="SHËNIM (opsional) për BORXH"
              style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, marginTop: 10 }}
            />
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              {pendingGroups.map((g) => (
                <div key={g.pin} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                    <div style={{ fontWeight: 950, letterSpacing: 2 }}>{g.items.length} PAGESA</div>
                    <div style={{ fontWeight: 950, whiteSpace: "nowrap" }}>{euro(g.total)}</div>
                  </div>
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ cursor: "pointer", fontWeight: 950, letterSpacing: 2, opacity: 0.9 }}>▶ DETAJE</summary>
                    <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                      {g.items.map((p) => (
                        <div key={p.id} style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                            <div style={{ fontWeight: 900, letterSpacing: 1.5 }}>
                              #{p.order_code || ""} · {String(p.client_name || "").toUpperCase()}
                              <div style={{ opacity: 0.65, marginTop: 4 }}>{p.created_at ? new Date(p.created_at).toLocaleString() : ""}</div>
                            </div>
                            <div style={{ fontWeight: 950, whiteSpace: "nowrap" }}>{euro(p.amount)}</div>
                          </div>
                          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                            <button
                              disabled={pendingBusy}
                              onClick={() => applyPending(p)}
                              style={{ flex: 1, padding: 10, borderRadius: 12, fontWeight: 950, letterSpacing: 2, opacity: pendingBusy ? 0.6 : 1 }}
                            >
                              PRANO
                            </button>
                            <button
                              disabled={pendingBusy}
                              onClick={() => rejectPending(p)}
                              style={{ flex: 1, padding: 10, borderRadius: 12, fontWeight: 950, letterSpacing: 2, opacity: pendingBusy ? 0.6 : 1 }}
                            >
                              BORXH
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      {/* Worker OWED confirmation modal (PIN hidden) */}
      <Modal
        open={owedModal}
        title={`BORXH I PUNTORIT (${owedPays?.length || 0})`}
        onClose={() => setOwedModal(false)}
      >
        {!owedPays?.length ? (
          <div style={{ opacity: 0.8, fontWeight: 900 }}>S’KA BORXH.</div>
        ) : (
          <>
            <div style={{ opacity: 0.85, fontWeight: 950, letterSpacing: 1.5 }}>
              KËTO PAGESA JANË SHËNU BORXH PËR TY. ZGJIDH: DORËZOVA PARET OSE PRANO AVANS.
            </div>

            <input
              value={owedNote}
              onChange={(e) => setOwedNote(e.target.value)}
              placeholder="SHËNIM (opsional)"
              style={{
                width: "100%",
                marginTop: 10,
                padding: 12,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "#fff",
                fontWeight: 900,
                textTransform: "uppercase",
              }}
            />

            <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
              {owedPays.map((p) => (
                <div
                  key={p.id || p.external_id || p.externalId}
                  style={{
                    padding: 12,
                    borderRadius: 16,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(0,0,0,0.35)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 950 }}>
                    <div>
                      #{String(p.order_code || p.code || p.orderCode || "").replace("#", "")} •{" "}
                      {String(p.client_name || p.name || p.clientName || "KLIENT").toUpperCase()}
                    </div>
                    <div>{euro(p.amount || 0)}</div>
                  </div>
                  <div style={{ opacity: 0.75, marginTop: 6, fontWeight: 900 }}>
                    {p.created_at ? new Date(p.created_at).toLocaleString() : ""}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
                    <button
                      disabled={owedBusy}
                      onClick={async () => {
                        setOwedBusy(true);
                        try {
                          await markOwedAsPending({ pending: p, actor: user });
                          // refresh lists
                          const res = await listPendingCashPayments(200);
                          setPendingPays(Array.isArray(res?.items) ? res.items : []);
                          const ow = await listWorkerOwedPayments(user?.name, 200);
                          const rows = Array.isArray(ow?.rows) ? ow.rows : [];
                          setOwedPays(rows);
                          if (!rows.length) setOwedModal(false);
                        } finally {
                          setOwedBusy(false);
                        }
                      }}
                      style={{
                        padding: 14,
                        borderRadius: 14,
                        border: "0",
                        fontWeight: 950,
                        letterSpacing: 2,
                        textTransform: "uppercase",
                        background: "rgba(255,255,255,0.92)",
                        color: "#0a0a0a",
                      }}
                    >
                      DORËZOVA PARET
                    </button>

                    <button
                      disabled={owedBusy}
                      onClick={async () => {
                        setOwedBusy(true);
                        try {
                          await markOwedAsAdvance({ pending: p, actor: user, note: owedNote });
                          const ow = await listWorkerOwedPayments(user?.name, 200);
                          const rows = Array.isArray(ow?.rows) ? ow.rows : [];
                          setOwedPays(rows);
                          if (!rows.length) setOwedModal(false);
                        } finally {
                          setOwedBusy(false);
                        }
                      }}
                      style={{
                        padding: 14,
                        borderRadius: 14,
                        border: "0",
                        fontWeight: 950,
                        letterSpacing: 2,
                        textTransform: "uppercase",
                        background: "rgba(255,255,255,0.16)",
                        color: "#fff",
                      }}
                    >
                      PRANO AVANS
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

    </div>
  );
}