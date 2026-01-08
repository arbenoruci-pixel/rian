// app/arka/cash/CashClient.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { flushArkaQueue } from "@/lib/arkaCashSync";
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
} from "@/lib/arkaDb";

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

  // core
  const [cycle, setCycle] = useState(null);
  const [tab, setTab] = useState("OPEN"); // OPEN | HISTORI | DISPATCH

  // OPEN form
  const [openingCash, setOpeningCash] = useState("0");
  const [openingSource, setOpeningSource] = useState("COMPANY"); // COMPANY | PERSONAL | OTHER
  const [openingPin, setOpeningPin] = useState("");

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

  // NOTE: if you have user PIN from auth, wire it here
  const userPin = "";

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
        // ✅ IMPORTANT: bring in any queued order payments (from PRANIMI/PASTRIMI/GATI)
        // into the currently OPEN cycle.
        try {
          const flushed = await flushArkaQueue("LOCAL");
          if (flushed?.ok && Number(flushed.flushed || 0) > 0) {
            // re-read moves after flush
          }
        } catch {}

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
        opening_person_pin = String(openingPin || userPin || "").trim();
        if (!opening_person_pin) throw new Error("PIN MUNGON PËR PERSONAL.");
      }

      await dbOpenCycle({
        opening_cash,
        opening_source: src,
        opening_person_pin,
        opened_by: "LOCAL",
      });

      // After opening a cycle, immediately flush any queued payments.
      try {
        await flushArkaQueue("LOCAL");
      } catch {}

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

      await dbAddCycleMove({
        cycle_id: cycle.id,
        type: String(moveType || "OUT").toUpperCase(), // IN | OUT
        amount: amt,
        note: String(moveNote || ""),
        source: "MANUAL",
        created_by: "LOCAL",
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
        <div style={{ opacity: 0.75 }}>
          HISTORI: në `arkaDb.js` s’ka funksion për me i listu ditët/ciklet e kalume.
          <div style={{ marginTop: 10, opacity: 0.9 }}>
            Nëse ma dërgon file-n ku e ke pas HISTORI-n (ose shtojmë 1 function minimal), ta kthej 1:1.
          </div>
        </div>
      ) : null}
    </div>
  );
}