"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { processPendingPayments } from "@/lib/arkaCashSync";
import {
  dbGetActiveCycle,
  dbOpenCycle,
  dbCloseCycle,
  dbReceiveCycle,
  dbAddCycleMove,
  dbListCycleMoves,
  // ✅ compat: some builds export these only as *Today / *ForToday
  dbHasPendingHandedToday as dbHasPendingHanded,
  dbListHandedForToday as dbListPendingHanded,
  dbGetCarryoverToday,
} from "@/lib/arkaDb";

const euro = (n) =>
  `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

function parseEuroInput(v) {
  const s = String(v ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace(",", ".");
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normSrc(v) {
  const s = String(v || "").toUpperCase();
  if (s === "PERSONAL" || s === "COMPANY" || s === "OTHER") return s;
  // fallback: anything unknown counts as COMPANY for display only
  return "COMPANY";
}

export default function CashClient() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // core
  const [cycle, setCycle] = useState(null);
  const [tab, setTab] = useState("OPEN"); // OPEN | HISTORI | DISPATCH

  // OPEN form
  const [openingCash, setOpeningCash] = useState("0");
  const [openingSource, setOpeningSource] = useState("COMPANY"); // COMPANY | PERSONAL | OTHER
  const [openingPin, setOpeningPin] = useState("");

  // Carryover context (when no active cycle)
  const [carry, setCarry] = useState({
    carry_cash: 0,
    carry_source: null,
    carry_person_pin: null,
  });

  // Pending handed
  const [pendingHanded, setPendingHanded] = useState(false);
  const [pendingPayments, setPendingPayments] = useState(0);
  const [handedList, setHandedList] = useState([]);

  // Moves
  const [moves, setMoves] = useState([]);

  // Add Move form
  const [moveType, setMoveType] = useState("OUT"); // IN | OUT
  const [moveAmount, setMoveAmount] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [moveSource, setMoveSource] = useState("COMPANY"); // COMPANY | PERSONAL | OTHER
  const [movePin, setMovePin] = useState("");

  // Close form
  const [cashCounted, setCashCounted] = useState("");
  const [keepCash, setKeepCash] = useState("");
  const [keepSource, setKeepSource] = useState("COMPANY"); // COMPANY | PERSONAL | OTHER
  const [keepPin, setKeepPin] = useState("");

  // NOTE: wire from auth if you have it
  const userPin = "";

  // sums by type
  const sums = useMemo(() => {
    const ins = (moves || [])
      .filter((m) => String(m.type).toUpperCase() === "IN")
      .reduce((a, m) => a + Number(m.amount || 0), 0);

    const outs = (moves || [])
      .filter((m) => String(m.type).toUpperCase() === "OUT")
      .reduce((a, m) => a + Number(m.amount || 0), 0);

    return { ins, outs };
  }, [moves]);

  // expected cash physically in register (opening + in - out)
  const expectedCash = useMemo(() => {
    const opening = Number(cycle?.opening_cash || 0);
    return opening + sums.ins - sums.outs;
  }, [cycle, sums]);

  // ---------- PERSONAL vs COMPANY split ----------
  // PERSONAL FLOAT = opening(personal) + IN(personal) - OUT(personal)
  // COMPANY INCOME TODAY = only IN where source != PERSONAL (does NOT include opening cash)
  const split = useMemo(() => {
    const opening_is_personal = normSrc(cycle?.opening_source) === "PERSONAL";

    const opening_personal = opening_is_personal ? Number(cycle?.opening_cash || 0) : 0;

    const personal_in = (moves || [])
      .filter((m) => String(m.type).toUpperCase() === "IN" && normSrc(m.source) === "PERSONAL")
      .reduce((a, m) => a + Number(m.amount || 0), 0);

    const personal_out = (moves || [])
      .filter((m) => String(m.type).toUpperCase() === "OUT" && normSrc(m.source) === "PERSONAL")
      .reduce((a, m) => a + Number(m.amount || 0), 0);

    const personal_float = Math.max(0, opening_personal + personal_in - personal_out);

    const company_income = (moves || [])
      .filter((m) => String(m.type).toUpperCase() === "IN" && normSrc(m.source) !== "PERSONAL")
      .reduce((a, m) => a + Number(m.amount || 0), 0);

    // breakdown personal by pin (informative)
    const personal_by_pin = {};
    if (opening_is_personal) {
      const pin = String(cycle?.opening_person_pin || "").trim() || "PA PIN";
      personal_by_pin[pin] = (personal_by_pin[pin] || 0) + Number(cycle?.opening_cash || 0);
    }

    (moves || []).forEach((m) => {
      const t = String(m.type).toUpperCase();
      const src = normSrc(m.source);
      if (src !== "PERSONAL") return;
      const pin = String(m.person_pin || m.pin || "").trim() || "PA PIN";
      const amt = Number(m.amount || 0);
      if (t === "IN") personal_by_pin[pin] = (personal_by_pin[pin] || 0) + amt;
      if (t === "OUT") personal_by_pin[pin] = (personal_by_pin[pin] || 0) - amt;
    });

    // normalize to show only > 0
    const personal_breakdown = Object.entries(personal_by_pin)
      .map(([pin, amt]) => [pin, Math.max(0, Number(amt || 0))])
      .filter(([, amt]) => amt > 0)
      .sort((a, b) => b[1] - a[1]);

    return {
      personal_float,
      company_income,
      personal_breakdown, // [ [pin, amt], ... ]
    };
  }, [cycle, moves]);

  async function refresh(mode = "ALL") {
    setErr("");
    try {
      const has = await dbHasPendingHanded();
      const pending = !!has;
      setPendingHanded(pending);

      // count queued payments/moves (if table exists)
      try {
        const q = await supabase
          .from("arka_pending_cash_moves")
          .select("id", { count: "exact", head: true })
          .eq("status", "PENDING");
        setPendingPayments(Number(q.count || 0));
      } catch {
        // ignore
      }

      // never dead-end
      if (pending && tab !== "DISPATCH") setTab("DISPATCH");

      const c = await dbGetActiveCycle();
      setCycle(c || null);

      // carryover context if NO active cycle
      if (!c) {
        try {
          const co = await dbGetCarryoverToday();
          setCarry(co || { carry_cash: 0, carry_source: null, carry_person_pin: null });

          // prefill opening with carryover if openingCash not typed meaningfully
          const oc = String(openingCash || "").trim();
          if (oc === "" || oc === "0" || oc === "0.0" || oc === "0,0") {
            if (Number(co?.carry_cash || 0) > 0) {
              setOpeningCash(String(Number(co.carry_cash || 0)));
              setOpeningSource(normSrc(co.carry_source || "COMPANY"));
              setOpeningPin(String(co.carry_person_pin || ""));
            }
          }
        } catch {
          // ignore if carryover cols don't exist
        }
        setMoves([]);
      } else {
        // try to auto-sync queued payments/moves (if orders attempted to pay while no cycle was open)
        try {
          const cnt = await supabase
            .from("arka_pending_cash_moves")
            .select("id", { count: "exact", head: true })
            .eq("status", "PENDING");
          if (!cnt.error) setPendingPayments(Number(cnt.count || 0));
        } catch {}

        try {
          await processPendingPayments();
        } catch {}

        const list = await dbListCycleMoves(c.id);
        setMoves(list || []);

        // prefill close forms
        setCashCounted(String(expectedCash));
        setKeepCash(String(carry?.carry_cash || 0));
        setKeepSource(normSrc(carry?.carry_source || "COMPANY"));
        setKeepPin(String(carry?.carry_person_pin || ""));
      }

      // dispatch list
      if (tab === "DISPATCH" || mode === "DISPATCH" || pending) {
        const list = await dbListPendingHanded();
        setHandedList(list || []);
      }
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function onOpenCycle() {
    setErr("");

    if (pendingHanded) {
      setErr(
        "DISPATCH DUHET ME PRANU DORËZIMIN E FUNDIT (HANDED) PARA SE ME U HAP CIKËL I RI."
      );
      setTab("DISPATCH");
      return;
    }

    setBusy(true);
    try {
      const opening_cash = parseEuroInput(openingCash);
      if (Number.isNaN(opening_cash) || opening_cash < 0) {
        throw new Error("SHUMA S’ËSHTË VALIDE.");
      }

      const src = normSrc(openingSource || "COMPANY");

      let opening_person_pin = "";
      if (src === "PERSONAL") {
        opening_person_pin = String(openingPin || userPin || "").trim();
        if (!opening_person_pin) throw new Error("PIN MUNGON PËR PERSONAL.");
      }

      await dbOpenCycle({
        opening_cash,
        opening_source: src,
        opening_person_pin,
        opened_by: "LOCAL",
      });

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
      if (Number.isNaN(amt) || amt <= 0) throw new Error("SHUMA E LËVIZJES DUHET > 0.");

      const t = String(moveType || "OUT").toUpperCase();
      const src = normSrc(moveSource || "COMPANY");

      // ✅ personal move requires PIN
      let ppin = "";
      if (src === "PERSONAL") {
        ppin = String(movePin || userPin || "").trim();
        if (!ppin) throw new Error("PIN MUNGON PËR LËVIZJE PERSONAL.");
      }

      await dbAddCycleMove({
        cycle_id: cycle.id,
        type: t, // IN | OUT
        amount: amt,
        note: String(moveNote || ""),
        source: src, // ✅ stored in row
        created_by: "LOCAL",
        // optional extra fields if your table has them (won't break if db ignores)
        person_pin: ppin,
      });

      setMoveAmount("");
      setMoveNote("");
      setMoveSource("COMPANY");
      setMovePin("");
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

      // ✅ HARD GUARD: mos mbyll me 0 kur expected > 0
      if (Number(expectedCash || 0) > 0 && counted === 0) {
        throw new Error(
          "NUK MUND TË MBYLLET ME 0: KA CASH TË PRITSHËM. NUMRO CASH-IN OSE SHËNO KU KA SHKU (OUT)."
        );
      }

      const keep = parseEuroInput(keepCash);
      if (Number.isNaN(keep) || keep < 0) throw new Error("KEEP CASH S’ËSHTË VALIDE.");
      if (keep > counted) throw new Error("KEEP CASH s’mund të jetë më i madh se CASH COUNTED.");

      const ks = normSrc(keepSource || "COMPANY");

      let kpin = "";
      if (ks === "PERSONAL") {
        kpin = String(keepPin || userPin || "").trim();
        if (!kpin) throw new Error("PIN MUNGON PËR KEEP CASH PERSONAL.");
      }

      await dbCloseCycle({
        cycle_id: cycle.id,
        expected_cash: expectedCash,
        cash_counted: counted,
        closed_by: "LOCAL",
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
    setBusy(true);
    try {
      await dbReceiveCycle({ cycle_id, received_by: "DISPATCH" });
      await refresh("DISPATCH");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  // derived for close summary
  const companyCashInRegister = useMemo(() => {
    const counted = parseEuroInput(cashCounted);
    if (!Number.isFinite(counted)) return 0;
    return counted - Number(split.personal_float || 0);
  }, [cashCounted, split.personal_float]);

  return (
    <div style={{ padding: 16 }}>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <button
          onClick={() => setTab("OPEN")}
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 14,
            fontWeight: 900,
            letterSpacing: 2,
            opacity: tab === "OPEN" ? 1 : 0.6,
          }}
        >
          OPEN
        </button>
        <button
          onClick={() => setTab("HISTORI")}
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 14,
            fontWeight: 900,
            letterSpacing: 2,
            opacity: tab === "HISTORI" ? 1 : 0.6,
          }}
        >
          HISTORI
        </button>
        <button
          onClick={() => setTab("DISPATCH")}
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 14,
            fontWeight: 900,
            letterSpacing: 2,
            opacity: tab === "DISPATCH" ? 1 : 0.6,
          }}
        >
          DISPATCH
        </button>
      </div>

      {/* Error */}
      {err ? (
        <div
          style={{
            border: "2px solid #7a1a1a",
            color: "#fff",
            padding: 12,
            borderRadius: 12,
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      ) : null}

      {/* OPEN */}
      {tab === "OPEN" ? (
        <div style={{ display: "grid", gap: 10 }}>
          {!cycle ? (
            <>
              {pendingHanded ? (
                <div
                  style={{
                    border: "2px solid #7a1a1a",
                    color: "#fff",
                    padding: 12,
                    borderRadius: 12,
                    opacity: 0.95,
                  }}
                >
                  DISPATCH DUHET ME PRANU DORËZIMIN E FUNDIT (HANDED) PARA SE ME U HAP CIKËL I RI.
                  <div style={{ marginTop: 10 }}>
                    <button
                      onClick={() => setTab("DISPATCH")}
                      style={{
                        width: "100%",
                        padding: 12,
                        borderRadius: 12,
                        fontWeight: 900,
                        letterSpacing: 2,
                      }}
                    >
                      SHKO TE DISPATCH
                    </button>
                  </div>
                </div>
              ) : null}

              <div style={{ opacity: 0.85, letterSpacing: 2, fontWeight: 900 }}>
                SOT: {dayKeyLocal(new Date())}
              </div>

              {/* Carryover */}
              {Number(carry?.carry_cash || 0) > 0 ? (
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 14,
                    padding: 12,
                    opacity: 0.95,
                  }}
                >
                  <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>
                    CARRYOVER NGA DJE / MBETUR N’ARKË
                  </div>
                  <div style={{ marginTop: 6, fontWeight: 900 }}>
                    {euro(carry.carry_cash)} · {normSrc(carry.carry_source || "COMPANY")}
                    {normSrc(carry.carry_source || "") === "PERSONAL" && carry.carry_person_pin ? (
                      <> · PIN: {carry.carry_person_pin}</>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {pendingPayments > 0 ? (
                <div
                  style={{
                    border: "1px solid rgba(59,130,246,0.55)",
                    background: "rgba(59,130,246,0.08)",
                    borderRadius: 14,
                    padding: 12,
                    opacity: 0.95,
                  }}
                >
                  <div style={{ fontWeight: 900, letterSpacing: 2 }}>
                    KA PAGESA/LEVIZJE NË PRITJE: {pendingPayments}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>
                    Hap ciklin dhe sistemi i fut automatikisht n’ARKË.
                  </div>
                </div>
              ) : null}

              <div style={{ opacity: 0.8, letterSpacing: 2, fontWeight: 900 }}>HAP CIKËL</div>

              <input
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
                inputMode="decimal"
                placeholder="CASH FILLESTAR (p.sh. 20)"
                style={{
                  width: "100%",
                  padding: 14,
                  borderRadius: 14,
                  fontWeight: 900,
                  letterSpacing: 1,
                }}
              />

              <select
                value={openingSource}
                onChange={(e) => setOpeningSource(e.target.value)}
                style={{
                  width: "100%",
                  padding: 14,
                  borderRadius: 14,
                  fontWeight: 900,
                  letterSpacing: 1,
                }}
              >
                <option value="COMPANY">BURIMI: COMPANY</option>
                <option value="PERSONAL">BURIMI: PERSONAL (PIN OBLIGATIVE)</option>
                <option value="OTHER">BURIMI: OTHER</option>
              </select>

              {normSrc(openingSource) === "PERSONAL" ? (
                <input
                  value={openingPin}
                  onChange={(e) => setOpeningPin(e.target.value)}
                  inputMode="numeric"
                  placeholder="PIN I PERSONIT (PERSONAL)"
                  style={{
                    width: "100%",
                    padding: 14,
                    borderRadius: 14,
                    fontWeight: 900,
                    letterSpacing: 1,
                  }}
                />
              ) : null}

              <button
                disabled={busy || pendingHanded}
                onClick={onOpenCycle}
                style={{
                  width: "100%",
                  padding: 14,
                  borderRadius: 14,
                  fontWeight: 900,
                  letterSpacing: 2,
                  opacity: busy || pendingHanded ? 0.6 : 1,
                }}
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
                OPENING: {euro(cycle.opening_cash)} · {normSrc(cycle.opening_source)}
                {normSrc(cycle.opening_source) === "PERSONAL" && cycle.opening_person_pin ? (
                  <> · PIN: {cycle.opening_person_pin}</>
                ) : null}
              </div>

              {pendingPayments > 0 ? (
                <div
                  style={{
                    border: "1px solid rgba(250, 204, 21, 0.45)",
                    background: "rgba(250, 204, 21, 0.10)",
                    borderRadius: 14,
                    padding: 12,
                  }}
                >
                  <div style={{ fontWeight: 900, letterSpacing: 2 }}>
                    PAGESA NË PRITJE: {pendingPayments}
                  </div>
                  <div style={{ opacity: 0.85, marginTop: 6, fontWeight: 700 }}>
                    Disa pagesa janë bërë kur s’kishte cikël OPEN. Kliko “SYNC” që t’i futë në këtë cikël.
                  </div>
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await processPendingPayments();
                        await refresh("MOVES_ONLY");
                      } catch (e) {
                        alert(String(e?.message || e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    style={{
                      width: "100%",
                      padding: 12,
                      borderRadius: 12,
                      fontWeight: 900,
                      letterSpacing: 2,
                      marginTop: 10,
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    SYNC PAGESAT
                  </button>
                </div>
              ) : null}

              {/* Totals */}
              <div
                style={{
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 14,
                  padding: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontWeight: 900,
                    letterSpacing: 2,
                  }}
                >
                  <div>IN (TOTAL)</div>
                  <div>{euro(sums.ins)}</div>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontWeight: 900,
                    letterSpacing: 2,
                    marginTop: 6,
                  }}
                >
                  <div>OUT (TOTAL)</div>
                  <div>{euro(sums.outs)}</div>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontWeight: 900,
                    letterSpacing: 2,
                    marginTop: 10,
                    opacity: 0.95,
                  }}
                >
                  <div>EXPECTED CASH (FIZIK)</div>
                  <div>{euro(expectedCash)}</div>
                </div>
              </div>

              {/* Add Move */}
              <div
                style={{
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 14,
                  padding: 12,
                }}
              >
                <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>
                  SHTO LËVIZJE
                </div>

                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <select
                    value={moveType}
                    onChange={(e) => setMoveType(e.target.value)}
                    style={{
                      flex: 1,
                      padding: 12,
                      borderRadius: 12,
                      fontWeight: 900,
                      letterSpacing: 1,
                    }}
                  >
                    <option value="IN">IN</option>
                    <option value="OUT">OUT</option>
                  </select>

                  <input
                    value={moveAmount}
                    onChange={(e) => setMoveAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="€"
                    style={{
                      flex: 1,
                      padding: 12,
                      borderRadius: 12,
                      fontWeight: 900,
                      letterSpacing: 1,
                    }}
                  />
                </div>

                <select
                  value={moveSource}
                  onChange={(e) => setMoveSource(e.target.value)}
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    fontWeight: 900,
                    letterSpacing: 1,
                    marginTop: 10,
                  }}
                >
                  <option value="COMPANY">SOURCE: COMPANY</option>
                  <option value="PERSONAL">SOURCE: PERSONAL (PIN OBLIGATIVE)</option>
                  <option value="OTHER">SOURCE: OTHER</option>
                </select>

                {normSrc(moveSource) === "PERSONAL" ? (
                  <input
                    value={movePin}
                    onChange={(e) => setMovePin(e.target.value)}
                    inputMode="numeric"
                    placeholder="PIN (PERSONAL MOVE)"
                    style={{
                      width: "100%",
                      padding: 12,
                      borderRadius: 12,
                      fontWeight: 900,
                      letterSpacing: 1,
                      marginTop: 10,
                    }}
                  />
                ) : null}

                <input
                  value={moveNote}
                  onChange={(e) => setMoveNote(e.target.value)}
                  placeholder="SHËNIM (opsional)"
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    fontWeight: 800,
                    letterSpacing: 1,
                    marginTop: 10,
                  }}
                />

                <button
                  disabled={busy}
                  onClick={onAddMove}
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    fontWeight: 900,
                    letterSpacing: 2,
                    marginTop: 10,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  SHTO
                </button>
              </div>

              {/* Moves */}
              <div
                style={{
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 14,
                  padding: 12,
                }}
              >
                <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>LËVIZJET</div>

                {moves.length === 0 ? (
                  <div style={{ opacity: 0.75, marginTop: 8 }}>S’KA LËVIZJE.</div>
                ) : (
                  <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                    {moves.map((m) => (
                      <div
                        key={m.id}
                        style={{
                          border: "1px solid rgba(255,255,255,0.10)",
                          borderRadius: 12,
                          padding: 10,
                          opacity: 0.95,
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <div style={{ fontWeight: 900, letterSpacing: 2 }}>
                            {String(m.type || "").toUpperCase()} · {normSrc(m.source)}
                            {m.note ? (
                              <span style={{ opacity: 0.8, letterSpacing: 1 }}> · {m.note}</span>
                            ) : null}
                            {normSrc(m.source) === "PERSONAL" && (m.person_pin || m.pin) ? (
                              <span style={{ opacity: 0.85, letterSpacing: 1 }}>
                                {" "}
                                · PIN: {m.person_pin || m.pin}
                              </span>
                            ) : null}
                          </div>
                          <div style={{ fontWeight: 900 }}>{euro(m.amount)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Close summary + Close */}
              <div
                style={{
                  border: "2px solid rgba(255,255,255,0.18)",
                  borderRadius: 14,
                  padding: 12,
                }}
              >
                <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>MBYLLE CIKLIN</div>

                {/* ✅ Summary block */}
                <div
                  style={{
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 12,
                    padding: 12,
                    marginTop: 10,
                  }}
                >
                  <div style={{ fontWeight: 900, letterSpacing: 2, opacity: 0.9 }}>PËRMBLEDHJE CASH</div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 10,
                      fontWeight: 900,
                      letterSpacing: 2,
                    }}
                  >
                    <div>EXPECTED CASH (FIZIK)</div>
                    <div>{euro(expectedCash)}</div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 8,
                      fontWeight: 900,
                      letterSpacing: 2,
                    }}
                  >
                    <div>COMPANY INCOME SOT</div>
                    <div>{euro(split.company_income)}</div>
                  </div>

                  <div style={{ marginTop: 10, fontWeight: 900, letterSpacing: 2, opacity: 0.95 }}>
                    PERSONAL (JO KOMPANI): {euro(split.personal_float)}
                  </div>

                  {split.personal_breakdown.length ? (
                    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                      {split.personal_breakdown.map(([pin, amt]) => (
                        <div
                          key={pin}
                          style={{ display: "flex", justifyContent: "space-between", opacity: 0.95 }}
                        >
                          <div style={{ fontWeight: 900, letterSpacing: 2 }}>PIN {pin}</div>
                          <div style={{ fontWeight: 900 }}>{euro(amt)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ marginTop: 8, opacity: 0.7 }}>S’KA PERSONAL FLOAT.</div>
                  )}
                </div>

                <input
                  value={cashCounted}
                  onChange={(e) => setCashCounted(e.target.value)}
                  inputMode="decimal"
                  placeholder="CASH COUNTED (sa i numrove)"
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    fontWeight: 900,
                    letterSpacing: 1,
                    marginTop: 10,
                  }}
                />

                <div style={{ marginTop: 8, opacity: 0.85, fontWeight: 900, letterSpacing: 2 }}>
                  CASH I KOMPANISË N’ARKË: {euro(companyCashInRegister)}
                </div>

                {Number(companyCashInRegister) < 0 ? (
                  <div
                    style={{
                      marginTop: 6,
                      border: "2px solid #7a1a1a",
                      padding: 10,
                      borderRadius: 12,
                    }}
                  >
                    CASH COUNTED ËSHTË MË I VOGËL SE PERSONAL FLOAT. KJO DUHET ME U QARTËSU.
                  </div>
                ) : null}

                <input
                  value={keepCash}
                  onChange={(e) => setKeepCash(e.target.value)}
                  inputMode="decimal"
                  placeholder="KEEP CASH (sa po i lë n’arkë)"
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    fontWeight: 900,
                    letterSpacing: 1,
                    marginTop: 10,
                  }}
                />

                <select
                  value={keepSource}
                  onChange={(e) => setKeepSource(e.target.value)}
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    fontWeight: 900,
                    letterSpacing: 1,
                    marginTop: 10,
                  }}
                >
                  <option value="COMPANY">KEEP SOURCE: COMPANY</option>
                  <option value="PERSONAL">KEEP SOURCE: PERSONAL (PIN OBLIGATIVE)</option>
                  <option value="OTHER">KEEP SOURCE: OTHER</option>
                </select>

                {normSrc(keepSource) === "PERSONAL" ? (
                  <input
                    value={keepPin}
                    onChange={(e) => setKeepPin(e.target.value)}
                    inputMode="numeric"
                    placeholder="PIN (KEEP PERSONAL)"
                    style={{
                      width: "100%",
                      padding: 12,
                      borderRadius: 12,
                      fontWeight: 900,
                      letterSpacing: 1,
                      marginTop: 10,
                    }}
                  />
                ) : null}

                <button
                  disabled={busy || Number(companyCashInRegister) < 0}
                  onClick={onCloseCycle}
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    fontWeight: 900,
                    letterSpacing: 2,
                    marginTop: 12,
                    opacity: busy ? 0.6 : 1,
                  }}
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
          <div style={{ opacity: 0.85, fontWeight: 900, letterSpacing: 2 }}>DORËZIMET (HANDED)</div>

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

                <div style={{ marginTop: 8, opacity: 0.8, fontWeight: 800 }}>STATUS: {h.handoff_status}</div>

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
        <div style={{ opacity: 0.75 }}>
          HISTORI: (ky tab i vjetër kërkon funksion listimi nga DB).
          <div style={{ marginTop: 10, opacity: 0.9 }}>
            Nëse don, hapi tjetër: ta shtojmë 1 funksion minimal në arkaDb.js për me i listu ciklet (pa prish asgjë).
          </div>
        </div>
      ) : null}
    </div>
  );
}
