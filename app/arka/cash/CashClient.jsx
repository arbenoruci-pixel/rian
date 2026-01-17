// app/arka/cash/CashClient.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  dbGetActiveCycle,
  dbOpenCycle,
  dbCloseCycle,
  dbReceiveCycle,
  dbAddCycleMove,
  dbListCycleMoves,
  dbHasPendingHanded,
  dbListPendingHanded,
  dbGetCarryoverToday, // ✅ use carryover context
  dbListHistoryDays,
  dbListCyclesByDay,
} from "@/lib/arkaDb";
import {
  listPendingCashPayments,
  applyPendingPaymentToCycle,
  rejectPendingPayment,
} from '@/lib/arkaCashSync';
import {
  listPendingRequestsForApprover,
  approveRequest,
  rejectRequest,
  isAdminRole,
} from "@/lib/arkaRequestsDb";

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

export default function CashClient() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // session
  const [user, setUser] = useState(null);
  const canApprove = useMemo(() => isAdminRole(user?.role), [user]);
  const isDispatch = useMemo(() => String(user?.role || '').toUpperCase() === 'DISPATCH', [user]);

  // core
  const [cycle, setCycle] = useState(null);
  const [tab, setTab] = useState("OPEN"); // OPEN | HISTORI | DISPATCH | KERKESA

  // =========================
  // HISTORI state
  // =========================
  const [histDays, setHistDays] = useState([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histErr, setHistErr] = useState("");
  const [histSelected, setHistSelected] = useState(null); // arka_days row
  const [histCycles, setHistCycles] = useState([]);

  // approvals
  const [reqs, setReqs] = useState([]);
  const [rejectNote, setRejectNote] = useState("");

  // OPEN form
  const [openingCash, setOpeningCash] = useState("0");
  const [openingSource, setOpeningSource] = useState("COMPANY"); // COMPANY | PERSONAL | OTHER
  const [openingPin, setOpeningPin] = useState("");
  const [takeFromBudget, setTakeFromBudget] = useState(true);

  // Carryover context (when no active cycle)
  const [carry, setCarry] = useState({ carry_cash: 0, carry_source: null, carry_person_pin: null });

  // Pending handed
  const [pendingHanded, setPendingHanded] = useState(false);
  const [handedList, setHandedList] = useState([]);

  // Moves for active cycle
  const [moves, setMoves] = useState([]);
  const [moveType, setMoveType] = useState("OUT"); // OUT default
  const [moveAmount, setMoveAmount] = useState("");
  const [moveNote, setMoveNote] = useState("");

  // Close form
  const [cashCounted, setCashCounted] = useState("");
  const [keepCash, setKeepCash] = useState("");
  const [keepSource, setKeepSource] = useState("COMPANY"); // COMPANY | PERSONAL | OTHER
  const [keepPin, setKeepPin] = useState("");

  // Cash counter (optional)
  const [showCounter, setShowCounter] = useState(false);
  const DENOMS = useMemo(
    () => [100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01],
    []
  );
  const [denomCounts, setDenomCounts] = useState(() => {
    const o = {};
    [100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01].forEach((d) => (o[String(d)] = 0));
    return o;
  });

  // Pending cash payments (WAITING)
  const [pendingPays, setPendingPays] = useState([]);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingRejectNote, setPendingRejectNote] = useState('');

  const denomTotal = useMemo(() => {
    return Object.entries(denomCounts || {}).reduce((sum, [k, v]) => {
      const d = Number(k);
      const c = Number(v || 0);
      if (!Number.isFinite(d) || !Number.isFinite(c)) return sum;
      return sum + d * c;
    }, 0);
  }, [denomCounts]);

  const sums = useMemo(() => {
    const ins = (moves || []).filter((m) => String(m.type).toUpperCase() === "IN")
      .reduce((a, m) => a + Number(m.amount || 0), 0);
    const outs = (moves || []).filter((m) => String(m.type).toUpperCase() === "OUT")
      .reduce((a, m) => a + Number(m.amount || 0), 0);
    return { ins, outs };
  }, [moves]);

  const expectedCash = useMemo(() => {
    const opening = Number(cycle?.opening_cash || 0);
    return opening + sums.ins - sums.outs;
  }, [cycle, sums]);

  useEffect(() => {
    if (!showCounter) return;
    // Auto-fill cash counted from denomination counter.
    setCashCounted(String((Math.round(denomTotal * 100) / 100).toFixed(2)));
  }, [showCounter, denomTotal]);

  async function refresh(mode = "ALL") {
    setErr("");
    try {
      const has = await dbHasPendingHanded();
      const pending = !!has;
      setPendingHanded(pending);

      // never dead-end
      if (pending && tab !== "DISPATCH") setTab("DISPATCH");

      const c = await dbGetActiveCycle();
      setCycle(c || null);

      // carryover context if NO active cycle
      if (!c) {
        try {
          const co = await dbGetCarryoverToday();
          setCarry(co || { carry_cash: 0, carry_source: null, carry_person_pin: null });

          // prefill opening cash with carryover if user hasn't typed anything meaningful
          // (safe: only if openingCash is "0" or empty)
          const oc = String(openingCash || "").trim();
          if (oc === "" || oc === "0" || oc === "0.0" || oc === "0,0") {
            if (Number(co?.carry_cash || 0) > 0) {
              setOpeningCash(String(Number(co.carry_cash || 0)));
              setOpeningSource(String(co.carry_source || "COMPANY").toUpperCase());
              setOpeningPin(String(co.carry_person_pin || ""));
            }
          }
        } catch {
          // ignore if carryover cols don't exist
        }
      }

      // moves for open cycle
      if (c?.id) {
        const list = await dbListCycleMoves(c.id);
        setMoves(list || []);

        // prefill close forms (nice UX)
        setCashCounted(String(expectedCash));
        setKeepCash(String(carry?.carry_cash || 0));
        setKeepSource(String(carry?.carry_source || "COMPANY").toUpperCase());
        setKeepPin(String(carry?.carry_person_pin || ""));
      } else {
        setMoves([]);
      }

      // ✅ WAITING CASH PAYMENTS (mandatory popup when cycle is OPEN)
      if (c?.id && canApprove) {
        try {
          const res = await listPendingCashPayments(200);
          setPendingPays(Array.isArray(res?.items) ? res.items : []);
        } catch {
          setPendingPays([]);
        }
      } else {
        setPendingPays([]);
      }

      // dispatch list
      if (tab === "DISPATCH" || mode === "DISPATCH" || pending) {
        const list = await dbListPendingHanded();
        setHandedList(list || []);
      }

      // approvals (admin/dispatch)
      if (canApprove && user?.pin) {
        try {
          const list = await listPendingRequestsForApprover(user.pin, 100);
          setReqs(list || []);
        } catch {
          // non-blocking
          setReqs([]);
        }
      } else {
        setReqs([]);
      }

      // HISTORI (list days + cycles)
      if (tab === "HISTORI" || mode === "HISTORI") {
        setHistErr("");
        setHistLoading(true);
        try {
          const days = await dbListHistoryDays(30);
          const safeDays = Array.isArray(days) ? days : [];
          setHistDays(safeDays);

          // keep selected if still exists, otherwise pick first
          let sel = histSelected;
          if (!sel || !safeDays.find((d) => d.id === sel.id)) {
            sel = safeDays[0] || null;
            setHistSelected(sel);
          }

          if (sel?.id) {
            const cyc = await dbListCyclesByDay(sel.id);
            setHistCycles(Array.isArray(cyc) ? cyc : []);
          } else {
            setHistCycles([]);
          }
        } catch (e) {
          setHistErr(e?.message || String(e));
          setHistDays([]);
          setHistCycles([]);
        } finally {
          setHistLoading(false);
        }
      }
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    // Read current session
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
      setErr("DISPATCH DUHET ME PRANU DORËZIMIN E FUNDIT (HANDED) PARA SE ME U HAP CIKËL I RI.");
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
        // If not typed, default to logged user's PIN.
        opening_person_pin = String(openingPin || user?.pin || "").trim();
        if (!opening_person_pin) throw new Error("PIN MUNGON PËR PERSONAL.");
      }

      const opened = await dbOpenCycle({
        opening_cash,
        opening_source: src,
        opening_person_pin,
        opened_by: user?.name || "LOCAL",
      });

      // If opening cash comes from COMPANY, optionally record an OUT in company budget
      // so budget balance doesn't show discrepancy.
      if (src === 'COMPANY' && takeFromBudget && opening_cash > 0) {
        try {
          const { budgetAddOutMove } = await import('@/lib/companyBudgetDb');
          await budgetAddOutMove({
            type: 'OUT',
            amount: opening_cash,
            note: `TRANSFER TO ARKA (OPENING CASH) • ${dayKeyLocal(new Date())}`,
            created_by: user?.name || 'LOCAL',
            external_id: opened?.id ? `arka_open:${opened.id}` : null,
          });
        } catch {}
      }

      await refresh();
      setTab("OPEN");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  // =============================
  // WAITING CASH PAYMENTS (PENDING)
  // =============================
  const mustHandlePending = useMemo(() => {
    return !!(cycle?.id && canApprove && Array.isArray(pendingPays) && pendingPays.length > 0);
  }, [cycle?.id, canApprove, pendingPays]);

  async function applyPendingOne(p) {
    if (!cycle?.id) return;
    setPendingBusy(true);
    try {
      await applyPendingPaymentToCycle({
        pending: p,
        cycle_id: cycle.id,
        approved_by_pin: user?.pin || null,
        approved_by_name: user?.name || null,
        approved_by_role: user?.role || null,
      });
      const res = await listPendingCashPayments(200);
      setPendingPays(res?.items || []);
      await refresh('ALL');
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setPendingBusy(false);
    }
  }

  async function applyPendingAll() {
    if (!cycle?.id) return;
    setPendingBusy(true);
    try {
      for (const p of (pendingPays || [])) {
        await applyPendingPaymentToCycle({
          pending: p,
          cycle_id: cycle.id,
          approved_by_pin: user?.pin || null,
          approved_by_name: user?.name || null,
          approved_by_role: user?.role || null,
        });
      }
      const res = await listPendingCashPayments(200);
      setPendingPays(res?.items || []);
      await refresh('ALL');
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setPendingBusy(false);
    }
  }

  async function rejectPendingOne(p) {
    setPendingBusy(true);
    try {
      await rejectPendingPayment({
        pending: p,
        rejected_by_pin: user?.pin || null,
        rejected_by_name: user?.name || null,
        rejected_by_role: user?.role || null,
        reject_note: pendingRejectNote || null,
      });
      setPendingRejectNote('');
      const res = await listPendingCashPayments(200);
      setPendingPays(res?.items || []);
      await refresh('ALL');
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setPendingBusy(false);
    }
  }

  async function onAddMove() {
    if (!cycle?.id) return;
    setErr("");
    setBusy(true);
    try {
      const amt = parseEuroInput(moveAmount);
      if (Number.isNaN(amt) || amt <= 0) throw new Error("SHUMA E LËVIZJES DUHET > 0.");

      await dbAddCycleMove({
        cycle_id: cycle.id,
        type: String(moveType || "OUT").toUpperCase(), // IN | OUT
        amount: amt,
        note: String(moveNote || ""),
        source: "MANUAL",
        created_by: user?.name || "LOCAL",
      });

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

      const keep = parseEuroInput(keepCash);
      if (Number.isNaN(keep) || keep < 0) throw new Error("KEEP CASH S’ËSHTË VALIDE.");
      if (keep > counted) throw new Error("KEEP CASH s’mund të jetë më i madh se CASH COUNTED.");

      const ks = String(keepSource || "COMPANY").toUpperCase();
      if (!["COMPANY", "PERSONAL", "OTHER"].includes(ks)) throw new Error("KEEP SOURCE DUHET: COMPANY / PERSONAL / OTHER.");

      let kpin = "";
      if (ks === "PERSONAL") {
        // If not typed, default to logged user's PIN.
        kpin = String(keepPin || user?.pin || "").trim();
        if (!kpin) throw new Error("PIN MUNGON PËR KEEP CASH PERSONAL.");
      }

      await dbCloseCycle({
        cycle_id: cycle.id,
        expected_cash: expectedCash,
        cash_counted: counted,
        closed_by: user?.name || "LOCAL",
        keep_cash: keep,
        keep_source: ks,
        keep_person_pin: kpin,
      });

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
      await dbReceiveCycle({ cycle_id, received_by: user?.name || "DISPATCH" });
      await refresh("DISPATCH");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const arkaLocked = pendingHanded && !isDispatch;

  if (arkaLocked) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ border: "2px solid #7a1a1a", color: "#fff", padding: 14, borderRadius: 14, marginBottom: 12 }}>
          <div style={{ fontWeight: 900, letterSpacing: 2, marginBottom: 6 }}>ARKA E BLLOKUAR</div>
          DISPATCH DUHET ME KONFIRMU PRANIMIN E PARAVE (RECEIVE) PARA SE ME VAZHDU.
          <div style={{ marginTop: 10, opacity: 0.9 }}>
            {handedList?.length ? `DORËZIME NË PRITJE: ${handedList.length}` : 'KA DORËZIM NË PRITJE (HANDED).'}
          </div>
          <div style={{ marginTop: 10 }}>
            <button
              onClick={() => setTab("DISPATCH")}
              style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2 }}
            >
              SHKO TE DISPATCH
            </button>
          </div>
          <div style={{ marginTop: 10, opacity: 0.85 }}>VETËM DISPATCH MUND TA PRANOJË DORËZIMIN.</div>
        </div>

        {/* Tabs (only DISPATCH visible while locked) */}
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          <button
            onClick={() => setTab("DISPATCH")}
            style={{ flex: 1, padding: 12, borderRadius: 14, fontWeight: 900, letterSpacing: 2, opacity: 1 }}
          >
            DISPATCH
          </button>
        </div>

        {/* DISPATCH */}
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>DORËZIMET (HANDED)</div>
          {handedList?.length ? (
            handedList.map((h) => (
              <div key={h.id} style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 900, letterSpacing: 2 }}>
                  {h.day_key} · CYCLE {h.cycle_no}
                </div>
                <div style={{ marginTop: 6, opacity: 0.9 }}>
                  EXPECTED: {euro(h.expected_cash)}
                </div>
                <div style={{ marginTop: 10 }}>
                  <button
                    disabled
                    style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2, opacity: 0.5 }}
                  >
                    PRANO (VETËM DISPATCH)
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div style={{ opacity: 0.85 }}>S’KA DORËZIME PËR PRANIM.</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <button
          onClick={() => setTab("OPEN")}
          style={{ flex: 1, padding: 12, borderRadius: 14, fontWeight: 900, letterSpacing: 2, opacity: tab === "OPEN" ? 1 : 0.6 }}
        >
          OPEN
        </button>
        <button
          onClick={() => setTab("HISTORI")}
          style={{ flex: 1, padding: 12, borderRadius: 14, fontWeight: 900, letterSpacing: 2, opacity: tab === "HISTORI" ? 1 : 0.6 }}
        >
          HISTORI
        </button>
        <button
          onClick={() => setTab("DISPATCH")}
          style={{ flex: 1, padding: 12, borderRadius: 14, fontWeight: 900, letterSpacing: 2, opacity: tab === "DISPATCH" ? 1 : 0.6 }}
        >
          DISPATCH
        </button>

        {canApprove ? (
          <button
            onClick={() => setTab("KERKESA")}
            style={{ flex: 1, padding: 12, borderRadius: 14, fontWeight: 900, letterSpacing: 2, opacity: tab === "KERKESA" ? 1 : 0.6 }}
          >
            KËRKESA{reqs?.length ? ` (${reqs.length})` : ""}
          </button>
        ) : null}
      </div>

      {/* Error */}
      {err ? (
        <div style={{ border: "2px solid #7a1a1a", color: "#fff", padding: 12, borderRadius: 12, marginBottom: 12 }}>
          {err}
        </div>
      ) : null}

      {/* OPEN */}
      {tab === "OPEN" ? (
        <div style={{ display: "grid", gap: 10 }}>
          {!cycle ? (
            <>
              {pendingHanded ? (
                <div style={{ border: "2px solid #7a1a1a", color: "#fff", padding: 12, borderRadius: 12, opacity: 0.95 }}>
                  DISPATCH DUHET ME PRANU DORËZIMIN E FUNDIT (HANDED) PARA SE ME U HAP CIKËL I RI.
                  <div style={{ marginTop: 10 }}>
                    <button
                      onClick={() => setTab("DISPATCH")}
                      style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2 }}
                    >
                      SHKO TE DISPATCH
                    </button>
                  </div>
                </div>
              ) : null}

              <div style={{ opacity: 0.85, letterSpacing: 2, fontWeight: 900 }}>
                SOT: {dayKeyLocal(new Date())}
              </div>

              {/* Carryover context */}
              {Number(carry?.carry_cash || 0) > 0 ? (
                <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12, opacity: 0.95 }}>
                  <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>CARRYOVER NGA DJE / MBETUR N’ARKË</div>
                  <div style={{ marginTop: 6, fontWeight: 900 }}>
                    {euro(carry.carry_cash)} · {String(carry.carry_source || "COMPANY").toUpperCase()}
                    {String(carry.carry_source || "").toUpperCase() === "PERSONAL" && carry.carry_person_pin ? (
                      <> · PIN: {carry.carry_person_pin}</>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div style={{ opacity: 0.8, letterSpacing: 2, fontWeight: 900 }}>
                HAP CIKËL
              </div>

              <input
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                inputMode="decimal"
                placeholder="CASH FILLESTAR (p.sh. 20)"
                style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 900, letterSpacing: 1 }}
              />

              <select
                value={openingSource}
                onChange={(e) => setOpeningSource(e.target.value)}
                style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 900, letterSpacing: 1 }}
              >
                <option value="COMPANY">BURIMI: COMPANY</option>
                <option value="PERSONAL">BURIMI: PERSONAL</option>
                <option value="OTHER">BURIMI: OTHER</option>
              </select>

              {String(openingSource).toUpperCase() === 'COMPANY' ? (
                <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, opacity: 0.9, fontWeight: 900, letterSpacing: 1 }}>
                  <input
                    type="checkbox"
                    checked={takeFromBudget}
                    onChange={(e) => setTakeFromBudget(e.target.checked)}
                    style={{ width: 18, height: 18 }}
                  />
                  MERRE PREJ BUXHETIT (TRANSFER) — ME HY NË BUXHET SI OUT
                </label>
              ) : null}

              {String(openingSource).toUpperCase() === "PERSONAL" ? (
                <input
                  value={openingPin}
                  onChange={(e) => setOpeningPin(e.target.value)}
                  inputMode="numeric"
                  placeholder="PIN I PERSONIT (PERSONAL)"
                  style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 900, letterSpacing: 1 }}
                />
              ) : null}

              <button
                disabled={busy || pendingHanded}
                onClick={onOpenCycle}
                style={{ width: "100%", padding: 14, borderRadius: 14, fontWeight: 900, letterSpacing: 2, opacity: busy || pendingHanded ? 0.6 : 1 }}
              >
                HAP CIKLIN
              </button>
            </>
          ) : (
            <>
              <div style={{ opacity: 0.9, fontWeight: 900, letterSpacing: 2 }}>
                STATUS: {cycle.handoff_status}
              </div>

              <div style={{ opacity: 0.9, fontWeight: 900, letterSpacing: 2 }}>
                FILLIMI: {euro(cycle.opening_cash)} · {String(cycle.opening_source || "").toUpperCase()}
                {String(cycle.opening_source || "").toUpperCase() === "PERSONAL" && cycle.opening_person_pin ? (
                  <> · PIN: {cycle.opening_person_pin}</>
                ) : null}
              </div>

              {/* Totals */}
              <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, letterSpacing: 2 }}>
                  <div>IN</div>
                  <div>{euro(sums.ins)}</div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, letterSpacing: 2, marginTop: 6 }}>
                  <div>OUT</div>
                  <div>{euro(sums.outs)}</div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, letterSpacing: 2, marginTop: 10, opacity: 0.95 }}>
                  <div>EXPECTED CASH</div>
                  <div>{euro(expectedCash)}</div>
                </div>
              </div>

              {/* Add Move */}
              <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>SHTO LËVIZJE</div>

                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <select
                    value={moveType}
                    onChange={(e) => setMoveType(e.target.value)}
                    style={{ flex: 1, padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 1 }}
                  >
                    <option value="IN">IN</option>
                    <option value="OUT">OUT</option>
                  </select>

                  <input
                    value={moveAmount}
                    onChange={(e) => setMoveAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="€"
                    style={{ flex: 1, padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 1 }}
                  />
                </div>

                <input
                  value={moveNote}
                  onChange={(e) => setMoveNote(e.target.value)}
                  placeholder="SHËNIM (opsional)"
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 800, letterSpacing: 1, marginTop: 10 }}
                />

                <button
                  disabled={busy}
                  onClick={onAddMove}
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2, marginTop: 10, opacity: busy ? 0.6 : 1 }}
                >
                  SHTO
                </button>
              </div>

              {/* Moves list */}
              <div style={{ border: "1px solid rgba(255,255,255,0.15)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>LËVIZJET</div>

                {moves.length === 0 ? (
                  <div style={{ opacity: 0.75, marginTop: 8 }}>S’KA LËVIZJE.</div>
                ) : (
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
                          opacity: 0.95,
                        }}
                      >
                        <div style={{ fontWeight: 900, letterSpacing: 2 }}>
                          {String(m.type || "").toUpperCase()}
                          {m.note ? <span style={{ opacity: 0.8, letterSpacing: 1 }}> · {m.note}</span> : null}
                        </div>
                        <div style={{ fontWeight: 900 }}>{euro(m.amount)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Close */}
              <div style={{ border: "2px solid rgba(255,255,255,0.18)", borderRadius: 14, padding: 12 }}>
                <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>MBYLLE CIKLIN</div>

                <div style={{ marginTop: 8, opacity: 0.85, fontWeight: 900, letterSpacing: 1.5 }}>
                  EXPECTED: {euro(expectedCash)}
                </div>

                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <button
                    type="button"
                    onClick={() => setCashCounted(String(Number(expectedCash || 0).toFixed(2)))}
                    style={{ flex: 1, padding: 10, borderRadius: 12, fontWeight: 900, letterSpacing: 1.5 }}
                  >
                    MBUSH ME EXPECTED
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCounter((v) => !v);
                      if (!showCounter) {
                        // reset counts when opening counter
                        const o = {};
                        DENOMS.forEach((d) => (o[String(d)] = 0));
                        setDenomCounts(o);
                      }
                    }}
                    style={{ flex: 1, padding: 10, borderRadius: 12, fontWeight: 900, letterSpacing: 1.5, opacity: 0.95 }}
                  >
                    {showCounter ? "FSHEH NUMËRUESIN" : "NUMËRO ME MONEDHA"}
                  </button>
                </div>

                {showCounter ? (
                  <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: 12, marginTop: 10 }}>
                    <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.85 }}>
                      TOTALI NGA MONEDHAT: {euro(denomTotal)}
                    </div>
                    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                      {DENOMS.map((d) => (
                        <div key={String(d)} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <div style={{ width: 90, fontWeight: 900, letterSpacing: 1.5 }}>{euro(d)}</div>
                          <button
                            type="button"
                            onClick={() => setDenomCounts((s) => ({ ...s, [String(d)]: Math.max(0, Number(s[String(d)] || 0) - 1) }))}
                            style={{ width: 42, height: 36, borderRadius: 10, fontWeight: 900 }}
                          >
                            −
                          </button>
                          <input
                            value={String(denomCounts[String(d)] || 0)}
                            onChange={(e) =>
                              setDenomCounts((s) => ({
                                ...s,
                                [String(d)]: Math.max(0, Number(String(e.target.value || "0").replace(/\D/g, "") || 0)),
                              }))
                            }
                            inputMode="numeric"
                            style={{ flex: 1, padding: 10, borderRadius: 10, fontWeight: 900, letterSpacing: 1 }}
                          />
                          <button
                            type="button"
                            onClick={() => setDenomCounts((s) => ({ ...s, [String(d)]: Number(s[String(d)] || 0) + 1 }))}
                            style={{ width: 42, height: 36, borderRadius: 10, fontWeight: 900 }}
                          >
                            +
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div style={{ marginTop: 10, opacity: 0.85, fontWeight: 900, letterSpacing: 2 }}>
                  EXPECTED: {euro(expectedCash)}
                </div>

                <input
                  value={cashCounted}
                  onChange={(e) => setCashCounted(e.target.value)}
                  inputMode="decimal"
                  placeholder="CASH COUNTED (sa i numrove)"
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 1, marginTop: 10 }}
                />

                <input
                  value={keepCash}
                  onChange={(e) => setKeepCash(e.target.value)}
                  inputMode="decimal"
                  placeholder="KEEP CASH (sa po i lë n’arkë)"
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 1, marginTop: 10 }}
                />

                <select
                  value={keepSource}
                  onChange={(e) => setKeepSource(e.target.value)}
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 1, marginTop: 10 }}
                >
                  <option value="COMPANY">KEEP SOURCE: COMPANY</option>
                  <option value="PERSONAL">KEEP SOURCE: PERSONAL</option>
                  <option value="OTHER">KEEP SOURCE: OTHER</option>
                </select>

                {String(keepSource).toUpperCase() === "PERSONAL" ? (
                  <input
                    value={keepPin}
                    onChange={(e) => setKeepPin(e.target.value)}
                    inputMode="numeric"
                    placeholder="PIN (KEEP PERSONAL)"
                    style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 1, marginTop: 10 }}
                  />
                ) : null}

                <button
                  disabled={busy}
                  onClick={onCloseCycle}
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2, marginTop: 12, opacity: busy ? 0.6 : 1 }}
                >
                  MBYLLE → HANDED
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* DISPATCH */}
      {tab === "DISPATCH" ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ opacity: 0.85, fontWeight: 900, letterSpacing: 2 }}>
            DORËZIMET (HANDED)
          </div>

          {handedList.length === 0 ? (
            <div style={{ opacity: 0.75 }}>S’KA DORËZIME PËR PRANIM.</div>
          ) : (
            handedList.map((h) => (
              <div
                key={h.id}
                style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, padding: 12 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>
                    {h.day_key} · CIKLI {h.cycle_no}
                  </div>
                  <div style={{ fontWeight: 900 }}>{euro(h.cash_counted)}</div>
                </div>

                <div style={{ marginTop: 8, opacity: 0.8, fontWeight: 800 }}>
                  STATUS: {h.handoff_status}
                </div>

                <button
                  disabled={busy}
                  onClick={() => onReceiveCycle(h.id)}
                  style={{ width: "100%", padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2, marginTop: 10 }}
                >
                  PRANO → RECEIVED
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}

      {/* HISTORI */}
      {tab === "HISTORI" ? (
        <div style={{ opacity: 0.95 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ fontWeight: 900, letterSpacing: 2 }}>HISTORI</div>
            <button
              onClick={() => refresh("HISTORI")}
              style={{ padding: '8px 12px', borderRadius: 12, fontWeight: 900, letterSpacing: 2, opacity: histLoading ? 0.6 : 1 }}
            >
              REFRESH
            </button>
          </div>

          {histErr ? (
            <div style={{ marginTop: 10, border: '1px solid rgba(255,80,80,0.6)', borderRadius: 12, padding: 10, color: '#ffb0b0' }}>
              {histErr}
            </div>
          ) : null}

          <div style={{ marginTop: 12, opacity: 0.8, fontWeight: 900, letterSpacing: 2 }}>DITËT (30)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 10 }}>
            {histDays?.length ? (
              histDays.map((d) => {
                const active = histSelected?.id === d.id;
                const isClosed = !!d.closed_at;
                return (
                  <button
                    key={d.id}
                    onClick={async () => {
                      setHistSelected(d);
                      setHistErr("");
                      setHistLoading(true);
                      try {
                        const cycles = await dbListCyclesByDay(d.id);
                        setHistCycles(cycles || []);
                      } catch (e) {
                        setHistCycles([]);
                        setHistErr(e?.message || String(e));
                      } finally {
                        setHistLoading(false);
                      }
                    }}
                    style={{
                      padding: 12,
                      borderRadius: 14,
                      border: active ? '1px solid rgba(120,180,255,0.9)' : '1px solid rgba(255,255,255,0.16)',
                      background: active ? 'rgba(20,40,70,0.65)' : 'rgba(0,0,0,0.15)',
                      textAlign: 'left',
                      opacity: histLoading ? 0.7 : 1,
                    }}
                  >
                    <div style={{ fontWeight: 900, letterSpacing: 1 }}>{d.day_key}</div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                      {isClosed ? 'MBYLLUR ✅' : 'HAPUR 🟡'}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                      PRITET: {euro(d.expected_cash)}
                    </div>
                  </button>
                );
              })
            ) : (
              <div style={{ opacity: 0.75 }}>S’KA TË DHËNA.</div>
            )}
          </div>

          {histSelected ? (
            <div style={{ marginTop: 16 }}>
              <div style={{ opacity: 0.8, fontWeight: 900, letterSpacing: 2 }}>
                CIKLET — {histSelected.day_key}
              </div>
              <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
                {histCycles?.length ? (
                  histCycles.map((c) => (
                    <div
                      key={c.id}
                      style={{
                        border: '1px solid rgba(255,255,255,0.16)',
                        borderRadius: 14,
                        padding: 12,
                        background: 'rgba(0,0,0,0.15)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <div style={{ fontWeight: 900, letterSpacing: 1 }}>CIKLI #{c.cycle_no}</div>
                        <div style={{ fontWeight: 900, opacity: 0.9 }}>{c.handoff_status || c.status}</div>
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

      {/* =============================
          WAITING CASH PAYMENTS MODAL
          (mandatory when cycle is OPEN)
         ============================= */}
      {mustHandlePending ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            style={{
              width: 'min(920px, 100%)',
              maxHeight: '85vh',
              overflow: 'auto',
              border: '1px solid rgba(255,255,255,0.18)',
              borderRadius: 16,
              padding: 14,
              background: 'rgba(10,14,24,0.96)',
            }}
          >
            <div style={{ fontWeight: 900, letterSpacing: 2 }}>
              WAITING PAGESA CASH ({pendingPays.length})
            </div>
            <div style={{ marginTop: 6, opacity: 0.85, fontWeight: 800 }}>
              KE PAGESA TË BËRA KUR ARKA ISHTE E MBYLLUR. DUHET ME I KONFIRMU TASH.
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              <button
                disabled={pendingBusy}
                onClick={applyPendingAll}
                style={{ flex: 1, padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2, opacity: pendingBusy ? 0.6 : 1 }}
              >
                FUTE TË GJITHA N'ARKË
              </button>
            </div>

            <input
              value={pendingRejectNote}
              onChange={(e) => setPendingRejectNote(e.target.value)}
              placeholder="SHËNIM PËR REFUZIM (opsional)"
              style={{ width: '100%', padding: 12, borderRadius: 12, fontWeight: 800, marginTop: 10 }}
            />

            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              {pendingPays.map((p) => {
                const code = p.order_code || p.code || '';
                const nm = p.client_name || p.name || '';
                const when = p.created_at ? new Date(p.created_at).toLocaleString() : '';
                return (
                  <div key={p.external_id || p.id || JSON.stringify(p)} style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontWeight: 900, letterSpacing: 1.5 }}>
                        {String(p.type || 'IN').toUpperCase()} · #{code} · {nm}
                        {p.note ? <span style={{ opacity: 0.75, marginLeft: 8 }}>· {p.note}</span> : null}
                        {when ? <div style={{ opacity: 0.65, marginTop: 4 }}>{when}</div> : null}
                      </div>
                      <div style={{ fontWeight: 900, whiteSpace: 'nowrap' }}>{euro(p.amount)}</div>
                    </div>

                    <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                      <button
                        disabled={pendingBusy}
                        onClick={() => applyPendingOne(p)}
                        style={{ flex: 1, padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2, opacity: pendingBusy ? 0.6 : 1 }}
                      >
                        FUTE N'ARKË
                      </button>
                      <button
                        disabled={pendingBusy}
                        onClick={() => rejectPendingOne(p)}
                        style={{ flex: 1, padding: 12, borderRadius: 12, fontWeight: 900, letterSpacing: 2, opacity: pendingBusy ? 0.6 : 1 }}
                      >
                        REFUZO
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}