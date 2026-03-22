"use client";

// app/arka/cash/CashClient.jsx

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  dbGetActiveCycle,
  dbOpenCycle,
  dbCloseCycle,
  dbAddCycleMove,
  dbListCycleMoves,
  dbGetCarryoverToday,
  dbListHistoryDays,
  dbListCyclesByDay,
} from "@/lib/arkaDb";

import {
  listPendingCashPayments,
  applyPendingPaymentToCycle,
  rejectPendingPayment,
  markOwedAsPending,
  markOwedAsAdvance,
} from "@/lib/arkaCashSync";

import {
  listPendingDispatchHandoffs,
  acceptDispatchHandoff,
  rejectDispatchHandoff,
  listWorkerDebtRows,
  listCompanyLedger,
  spendFromCompanyBudget,
} from "@/lib/corporateFinance";

import { budgetAddMove } from "@/lib/companyBudgetDb";

const euro = (n) =>
  `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

function parseEuroInput(v) {
  const s = String(v ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

function Modal({ open, title, onClose, children }) {
  if (!open) return null;
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="modal-content">
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
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
  const canAccessBudget = useMemo(() => {
    const role = String(user?.role || "").toUpperCase();
    return role === "DISPATCH" || role === "ADMIN";
  }, [user?.role]);

  const [tab, setTab] = useState("OPEN");

  const [cycle, setCycle] = useState(null);
  const [moves, setMoves] = useState([]);
  const [carry, setCarry] = useState({
    carry_cash: 0,
    carry_source: null,
    carry_person_pin: null,
  });

  const [pendingHanded, setPendingHanded] = useState(false);
  const [handedList, setHandedList] = useState([]);

  const [openModal, setOpenModal] = useState(false);
  const [openingCash, setOpeningCash] = useState("0");
  const [openingSource, setOpeningSource] = useState("COMPANY");
  const [openingPin, setOpeningPin] = useState("");

  const [moveType, setMoveType] = useState("OUT");
  const [moveAmount, setMoveAmount] = useState("");
  const [moveNote, setMoveNote] = useState("");

  const [closeModal, setCloseModal] = useState(false);
  const [cashCounted, setCashCounted] = useState("");
  const [closeReason, setCloseReason] = useState("");

  const [pendingPays, setPendingPays] = useState([]);
  const [pendingModal, setPendingModal] = useState(false);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingRejectNote, setPendingRejectNote] = useState("");

  const [owedPays, setOwedPays] = useState([]);
  const [owedModal, setOwedModal] = useState(false);
  const [owedBusy, setOwedBusy] = useState(false);
  const [owedNote, setOwedNote] = useState("");

  const [histDays, setHistDays] = useState([]);
  const [histSelected, setHistSelected] = useState(null);
  const [histCycles, setHistCycles] = useState([]);
  const [histLoading, setHistLoading] = useState(false);

  const [companyBalance, setCompanyBalance] = useState(0);
  const [companyLedger, setCompanyLedger] = useState([]);
  const [budgetAmount, setBudgetAmount] = useState("");
  const [budgetCategory, setBudgetCategory] = useState("RROGË");
  const [budgetDescription, setBudgetDescription] = useState("");
  const [budgetBusy, setBudgetBusy] = useState(false);

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

  async function loadBudgetView() {
    const { data, error } = await supabase
      .from("company_budget_summary")
      .select("current_balance")
      .eq("id", 1)
      .single();
    if (error) throw error;

    setCompanyBalance(Number(data?.current_balance || 0));

    const ledger = await listCompanyLedger(12);
    const recent = Array.isArray(ledger) ? ledger.filter((x) => String(x?.direction || "").toUpperCase() === "OUT") : [];
    setCompanyLedger(recent);
  }

  async function refresh(mode = "ALL") {
    setErr("");
    try {
      const dispatchHandoffs = await listPendingDispatchHandoffs();
      const safeHandoffs = Array.isArray(dispatchHandoffs) ? dispatchHandoffs : [];
      setPendingHanded(safeHandoffs.length > 0);
      setHandedList(safeHandoffs);

      const c = await dbGetActiveCycle();
      setCycle(c || null);

      if (!c) {
        try {
          const co = await dbGetCarryoverToday();
          setCarry(
            co || { carry_cash: 0, carry_source: null, carry_person_pin: null }
          );
        } catch {
          setCarry({ carry_cash: 0, carry_source: null, carry_person_pin: null });
        }
        setMoves([]);
      } else {
        const list = await dbListCycleMoves(c.id);
        setMoves(Array.isArray(list) ? list : []);
        setCashCounted(String(Number(expectedCash || 0).toFixed(2)));
      }

      if (mode === "DISPATCH" || tab === "DISPATCH" || safeHandoffs.length) {
        setHandedList(safeHandoffs);
      }

      if (hasPin) {
        try {
          const res = await listPendingCashPayments(80);
          setPendingPays(Array.isArray(res?.items) ? res.items : []);
        } catch {
          setPendingPays([]);
        }
      } else {
        setPendingPays([]);
      }

      if (user?.pin) {
        try {
          const rows = await listWorkerDebtRows(user.pin, 80);
          const safeRows = Array.isArray(rows) ? rows : [];
          setOwedPays(safeRows);
          if (safeRows.length) setOwedModal(true);
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

      if ((mode === "BUXHETI" || tab === "BUXHETI") && canAccessBudget) {
        await loadBudgetView();
      }
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    try {
      setUser(JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "null"));
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [tab]);

  async function applyPending(p) {
    if (!cycle?.id) return alert("GABIM: HAPE ARKËN SË PARI!");
    setPendingBusy(true);
    try {
      const applied = await applyPendingPaymentToCycle({
        pending: p,
        cycle_id: cycle.id,
        approved_by_pin: user?.pin || null,
        approved_by_name: user?.name || null,
        approved_by_role: user?.role || null,
      });

      if (!applied?.ok)
        throw new Error(applied?.error || "Dështoi pranim i pagesës në server!");

      setPendingPays((prev) => (prev || []).filter((x) => x.id !== p.id));
      alert("✅ Pagesa u pranua në Arkë me sukses!");
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

      if (rejected && rejected.ok === false)
        throw new Error(rejected.error || "Dështoi shënimi si borxh");

      setPendingPays((prev) => (prev || []).filter((x) => x.id !== p.id));
      alert("⚠️ Pagesa u kalua si BORXH me sukses!");
    } catch (e) {
      alert("❌ GABIM BORXHI: " + (e.message || String(e)));
    } finally {
      setPendingBusy(false);
    }
  }

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
      if (Number.isNaN(opening_cash) || opening_cash < 0)
        throw new Error("SHUMA S’ËSHTË VALIDE.");

      const src = String(openingSource || "COMPANY").toUpperCase();
      if (!["COMPANY", "PERSONAL", "OTHER"].includes(src))
        throw new Error("BURIMI DUHET: COMPANY / PERSONAL / OTHER.");

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
        if (src === "COMPANY" && Number(opening_cash || 0) > 0) {
          await budgetAddMove({
            direction: "OUT",
            amount: Number(opening_cash || 0),
            reason: "ARKA_OPEN",
            note: `OPEN CASH → ARKË${opened?.id ? ` (CYCLE ${opened.id})` : ""}`,
            source: "CASH",
            created_by: user?.name || "LOCAL",
            created_by_name: user?.name || "UNKNOWN",
            created_by_pin: user?.pin || null,
            ref_day_id: opened?.id || null,
            ref_type: "ARKA_CYCLE",
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
      const label =
        type === "IN"
          ? "PREJ KUJ (IN) [KOMPANI/PERSONAL]"
          : "KU SHKON (OUT) [KOMPANI/PERSONAL]";
      const raw = String(window.prompt(label, "KOMPANI") || "").trim().toUpperCase();
      const counterparty = raw === "PERSONAL" ? "PERSONAL" : "KOMPANI";

      let pin = String(user?.pin || "").trim();
      if (counterparty === "PERSONAL") {
        pin = String(window.prompt("SHKRUAJ PIN (PERSONAL)", pin || "") || "").trim();
        if (!pin) throw new Error("PIN MUNGON (PERSONAL).");
      }

      const noteExtra = `${counterparty}`;
      const note = `${String(moveNote || "")}${
        String(moveNote || "").trim() ? " • " : ""
      }${noteExtra}`.trim();

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

      if (counterparty === "KOMPANI") {
        const budDir = type === "OUT" ? "IN" : "OUT";
        try {
          await budgetAddMove({
            direction: budDir,
            amount: amt,
            reason: "ARKA_MANUAL",
            note: `ARKA ${type} • ${note}`,
            source: "CASH",
            created_by: user?.id || null,
            created_by_name: user?.name || null,
            created_by_pin: pin || null,
            ref_day_id: cycle?.id || null,
            ref_type: "ARKA_CYCLE",
            external_id: `arka_manual_${cycle?.id || "x"}_${Date.now()}`,
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
      if (Number.isNaN(counted) || counted < 0)
        throw new Error("CASH COUNTED S’ËSHTË VALIDE.");

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

  async function onReceiveCycle(handoffId) {
    if (!handoffId) return;
    setErr("");
    if (!isDispatch) {
      setErr("VETËM DISPATCH MUND TA PRANOJË DORËZIMIN.");
      return;
    }
    setBusy(true);
    try {
      await acceptDispatchHandoff({
        handoffId,
        actor: { pin: user?.pin || null, name: user?.name || null },
      });
      await refresh("DISPATCH");
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPayBudget() {
    if (!canAccessBudget) return;
    setErr("");
    setBudgetBusy(true);
    try {
      const amount = parseEuroInput(budgetAmount);
      if (Number.isNaN(amount) || amount <= 0) throw new Error("SHUMA DUHET > 0.");
      if (!String(budgetDescription || "").trim()) throw new Error("PËRSHKRIMI ËSHTË I DETYRUESHËM.");

      await spendFromCompanyBudget({
        actor: { pin: user?.pin || null, name: user?.name || null },
        amount,
        category: budgetCategory || "TJETER",
        description: String(budgetDescription || "").trim(),
      });

      setBudgetAmount("");
      setBudgetDescription("");
      await loadBudgetView();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBudgetBusy(false);
    }
  }

  const pendingGroups = useMemo(() => {
    const groups = new Map();
    for (const p of pendingPays || []) {
      const pin = String(p?.created_by_pin || p?.created_by_name || "PA_PIN").trim() || "PA_PIN";
      if (!groups.has(pin)) groups.set(pin, []);
      groups.get(pin).push(p);
    }
    return Array.from(groups.entries())
      .map(([pin, items]) => ({
        pin,
        items,
        total: items.reduce((s, x) => s + Number(x.amount || 0), 0),
      }))
      .sort((a, b) => a.pin.localeCompare(b.pin));
  }, [pendingPays]);

  return (
    <div className="cash-shell">
      <div className="cash-topbar">
        <div className="cash-heading">
          <div className="eyebrow">Apple dark mode</div>
          <h1 className="page-title">Cash Center</h1>
          <div className="page-subtitle">
            Arka ditore, dispatch handoffs dhe historiku në një pamje të pastër.
          </div>
        </div>

        <div
          className="segmented"
          role="tablist"
          aria-label="Cash tabs"
          style={{ gridTemplateColumns: `repeat(${canAccessBudget ? 4 : 3}, minmax(0, 1fr))` }}
        >
          <button className={`seg-btn ${tab === "OPEN" ? "seg-active" : ""}`} onClick={() => setTab("OPEN")}>
            Open
          </button>
          <button className={`seg-btn ${tab === "DISPATCH" ? "seg-active" : ""}`} onClick={() => setTab("DISPATCH")}>
            Dispatch
          </button>
          {canAccessBudget && (
            <button className={`seg-btn ${tab === "BUXHETI" ? "seg-active" : ""}`} onClick={() => setTab("BUXHETI")}>
              Buxheti
            </button>
          )}
          <button className={`seg-btn ${tab === "HISTORI" ? "seg-active" : ""}`} onClick={() => setTab("HISTORI")}>
            Histori
          </button>
        </div>
      </div>

      {err && <div className="notice notice-error">{err}</div>}

      {pendingHanded && !isDispatch && (
        <div className="notice notice-warning">
          <div className="notice-title">Arka është e bllokuar</div>
          <div className="notice-text">
            Dispatch duhet ta pranojë dorëzimin para se të vazhdosh.
          </div>
        </div>
      )}

      {tab === "OPEN" && (
        <div className="stack fade-in">
          {!cycle ? (
            <section className="surface hero-card">
              <div className="section-copy">
                <div className="eyebrow">Open cycle</div>
                <div className="section-title">Hap arkën e re</div>
                <div className="section-subtitle">
                  Nise ditën me një cikël të ri cash dhe mbaje gjendjen të qartë.
                </div>
              </div>

              {Number(carry?.carry_cash || 0) > 0 && (
                <div className="soft-panel">
                  <div className="soft-label">Carryover nga dje</div>
                  <div className="soft-value">{euro(carry.carry_cash)}</div>
                  <div className="soft-meta">
                    {String(carry.carry_source || "COMPANY").toUpperCase()}
                  </div>
                </div>
              )}

              <button className="btn btn-primary" disabled={busy || pendingHanded} onClick={() => setOpenModal(true)}>
                Hap arkën
              </button>
            </section>
          ) : (
            <>
              {pendingPays?.length > 0 && (
                <button className="banner-action" onClick={() => setPendingModal(true)}>
                  <span className="banner-left">
                    <span className="banner-dot" />
                    <span>Pagesa në pritje</span>
                  </span>
                  <strong>{pendingPays.length}</strong>
                </button>
              )}

              <section className="metrics-grid">
                <article className="surface metric-card">
                  <div className="metric-label">Hyrje</div>
                  <div className="metric-value">{euro(sums.ins)}</div>
                </article>
                <article className="surface metric-card">
                  <div className="metric-label">Dalje</div>
                  <div className="metric-value">{euro(sums.outs)}</div>
                </article>
              </section>

              <section className="surface spotlight-card">
                <div className="metric-label">Pritet në arkë</div>
                <div className="spotlight-value">{euro(expectedCash)}</div>
              </section>

              <section className="surface form-card">
                <div className="section-head">
                  <div>
                    <div className="section-title">Lëvizje manuale</div>
                    <div className="section-subtitle">
                      Shto hyrje ose dalje cash pa prekur motorin e ri korporativ.
                    </div>
                  </div>
                </div>

                <div className="field-row two">
                  <select className="field" value={moveType} onChange={(e) => setMoveType(e.target.value)}>
                    <option value="IN">IN · Shto</option>
                    <option value="OUT">OUT · Nxjerr</option>
                  </select>
                  <input className="field" value={moveAmount} onChange={(e) => setMoveAmount(e.target.value)} inputMode="decimal" placeholder="Shuma" />
                </div>

                <input className="field" value={moveNote} onChange={(e) => setMoveNote(e.target.value)} placeholder="Shënim opsional" />

                <button className="btn btn-secondary" disabled={busy} onClick={onAddMove}>
                  Shto lëvizjen
                </button>
              </section>

              <section className="surface ledger-card">
                <div className="section-head">
                  <div>
                    <div className="section-title">Lëvizjet e arkës</div>
                    <div className="section-subtitle">
                      Çdo hyrje dhe dalje e ditës në një pamje të pastër.
                    </div>
                  </div>
                </div>

                {moves?.length ? (
                  <div className="ledger-list">
                    {moves.map((m) => {
                      const isIN = String(m.type || "").toUpperCase() === "IN";
                      const executorName = String(
                        m.created_by_name || m.created_by || "Sistemi / i panjohur"
                      );

                      return (
                        <article key={m.id} className="ledger-item">
                          <div className="ledger-main">
                            <div className="ledger-left">
                              <span className={`pill ${isIN ? "pill-positive" : "pill-negative"}`}>
                                {String(m.type || "").toUpperCase()}
                              </span>
                              <div className="ledger-copy">
                                <div className="ledger-kind">
                                  {m.source === "ORDER_PAY" ? "Pagesë porosie" : "Lëvizje manuale"}
                                </div>
                                <div className="ledger-note">{m.note || "Pa shënim"}</div>
                              </div>
                            </div>
                            <div className="ledger-amount">{isIN ? "+" : "-"}{euro(m.amount)}</div>
                          </div>

                          <div className="ledger-meta">
                            <span>{executorName}</span>
                            <span>
                              {m.created_at
                                ? new Date(m.created_at).toLocaleTimeString("sq-AL", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : ""}
                            </span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="empty-state">S’ka asnjë lëvizje sot.</div>
                )}
              </section>

              <button
                className="btn btn-danger"
                onClick={() => {
                  setCashCounted(String(Number(expectedCash || 0).toFixed(2)));
                  setCloseModal(true);
                }}
              >
                Mbylle arkën
              </button>
            </>
          )}
        </div>
      )}

      {tab === "DISPATCH" && (
        <div className="stack fade-in">
          {handedList?.length ? (
            handedList.map((h) => (
              <section key={h.id} className="surface dispatch-card">
                <div className="dispatch-top">
                  <div>
                    <div className="eyebrow">Dispatch handoff</div>
                    <div className="section-title">{h.worker_name || h.worker_pin || "Punëtori"}</div>
                    <div className="dispatch-meta">Handoff #{h.id}</div>
                  </div>
                  <div className="dispatch-amount">{euro(h.amount || 0)}</div>
                </div>

                <div className="dispatch-stats">
                  <div className="soft-panel compact">
                    <div className="soft-label">Status</div>
                    <div className="soft-inline">{String(h.status || "").toUpperCase()}</div>
                  </div>
                  <div className="soft-panel compact">
                    <div className="soft-label">Pagesa</div>
                    <div className="soft-inline">{(h.cash_handoff_items || []).length}</div>
                  </div>
                </div>

                <div className="action-grid">
                  <button className="btn btn-success" disabled={busy || !isDispatch} onClick={() => onReceiveCycle(h.id)}>
                    Prano dorëzimin
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={busy || !isDispatch}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await rejectDispatchHandoff({
                          handoffId: h.id,
                          actor: { pin: user?.pin || null, name: user?.name || null },
                          note: "REFUZUAR NGA DISPATCH",
                        });
                        await refresh("DISPATCH");
                      } catch (e) {
                        setErr(e?.message || String(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Refuzo
                  </button>
                </div>
              </section>
            ))
          ) : (
            <section className="surface empty-card">
              <div className="section-title">Asnjë dorëzim në pritje</div>
              <div className="section-subtitle">
                Kur punëtorët dërgojnë cash handoff, do t’i shohësh këtu.
              </div>
            </section>
          )}
        </div>
      )}

      {tab === "BUXHETI" && canAccessBudget && (
        <div className="stack fade-in">
          <section className="surface spotlight-card">
            <div className="metric-label">Buxheti aktual i kompanisë</div>
            <div className="spotlight-value">{euro(companyBalance)}</div>
            <div className="section-subtitle">
              Gjendja live nga company_budget_summary për admin dhe dispatch.
            </div>
          </section>

          <section className="surface form-card">
            <div className="section-head">
              <div>
                <div className="section-title">Regjistro shpenzim</div>
                <div className="section-subtitle">
                  Rroga, fatura, karburant, materiale ose shpenzime të tjera nga kompania.
                </div>
              </div>
            </div>

            <div className="field-row two">
              <input
                className="field"
                value={budgetAmount}
                onChange={(e) => setBudgetAmount(e.target.value)}
                inputMode="decimal"
                placeholder="Shuma (€)"
              />
              <select
                className="field"
                value={budgetCategory}
                onChange={(e) => setBudgetCategory(e.target.value)}
              >
                <option value="RROGË">Rrogë</option>
                <option value="FATURË">Faturë</option>
                <option value="KARBURANT">Karburant</option>
                <option value="MATERIALE">Materiale</option>
                <option value="TJETER">Tjetër</option>
              </select>
            </div>

            <textarea
              className="field textarea"
              rows={3}
              value={budgetDescription}
              onChange={(e) => setBudgetDescription(e.target.value)}
              placeholder="Përshkrimi i shpenzimit"
            />

            <button className="btn btn-success" disabled={budgetBusy} onClick={onPayBudget}>
              Paguaj
            </button>
          </section>

          <section className="surface ledger-card">
            <div className="section-head">
              <div>
                <div className="section-title">Shpenzimet e fundit</div>
                <div className="section-subtitle">
                  Daljet më të fundit nga company_budget_ledger.
                </div>
              </div>
            </div>

            {companyLedger?.length ? (
              <div className="ledger-list">
                {companyLedger.map((item) => (
                  <article key={item.id} className="ledger-item">
                    <div className="ledger-main">
                      <div className="ledger-left">
                        <span className="pill">{String(item.category || "TJETER")}</span>
                        <div className="ledger-copy">
                          <div className="ledger-kind">{item.description || "Shpenzim i regjistruar"}</div>
                          <div className="ledger-note">{item.created_by_name || item.approved_by_name || "Kompania"}</div>
                        </div>
                      </div>
                      <div className="ledger-amount">-{euro(item.amount)}</div>
                    </div>

                    <div className="ledger-meta">
                      <span>{item.source_type || "manual"}</span>
                      <span>
                        {item.created_at
                          ? new Date(item.created_at).toLocaleString("sq-AL", {
                              day: "2-digit",
                              month: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">S’ka shpenzime të regjistruara ende.</div>
            )}
          </section>
        </div>
      )}

      {tab === "HISTORI" && (
        <div className="stack fade-in">
          <section className="surface form-card">
            <div className="section-head">
              <div>
                <div className="section-title">Zgjidh ditën</div>
                <div className="section-subtitle">
                  Shiko ciklet e mëparshme dhe lëvizjet kryesore të arkës.
                </div>
              </div>
            </div>

            {histLoading ? (
              <div className="empty-state">Duke ngarkuar historinë...</div>
            ) : histDays?.length ? (
              <div className="history-grid">
                {histDays.map((d) => (
                  <button
                    key={d.id}
                    className={`chip-btn ${histSelected?.id === d.id ? "chip-active" : ""}`}
                    onClick={() => setHistSelected(d)}
                  >
                    {d.day_key}
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">S’ka histori akoma.</div>
            )}
          </section>

          {histSelected && (
            <section className="surface ledger-card">
              <div className="section-head">
                <div>
                  <div className="section-title">{histSelected.day_key}</div>
                  <div className="section-subtitle">Përmbledhje e cikleve të regjistruara.</div>
                </div>
              </div>

              {histCycles?.length ? (
                <div className="group-list">
                  {histCycles.map((c) => (
                    <article key={c.id} className="group-card">
                      <div className="group-head">
                        <div>
                          <div className="group-title">Cycle #{c.id}</div>
                          <div className="group-subtitle">
                            {c.status || "-"} · {c.opened_by || c.closed_by || "ARKA"}
                          </div>
                        </div>
                        <div className="group-total">{euro(c.cash_counted ?? c.end_cash ?? c.expected_cash ?? 0)}</div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">S’ka cikle për këtë ditë.</div>
              )}
            </section>
          )}
        </div>
      )}

      <Modal open={openModal} title="Hap arkën" onClose={() => setOpenModal(false)}>
        <div className="modal-stack">
          <div className="modal-note">Vendos cash-in fillestar dhe burimin e tij.</div>
          <input className="field" value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} inputMode="decimal" placeholder="Cash fillestar" />
          <select className="field" value={openingSource} onChange={(e) => setOpeningSource(e.target.value)}>
            <option value="COMPANY">Company</option>
            <option value="PERSONAL">Personal</option>
            <option value="OTHER">Other</option>
          </select>
          {String(openingSource || "").toUpperCase() === "PERSONAL" && (
            <input className="field" value={openingPin} onChange={(e) => setOpeningPin(e.target.value)} inputMode="numeric" placeholder="PIN i personit" />
          )}
          <button className="btn btn-primary" disabled={busy} onClick={onOpenCycle}>
            Konfirmo hapjen
          </button>
        </div>
      </Modal>

      <Modal open={closeModal} title="Mbylle arkën" onClose={() => setCloseModal(false)}>
        <div className="modal-stack">
          <div className="summary-chip">
            <span>Expected</span>
            <strong>{euro(expectedCash)}</strong>
          </div>
          <input className="field" value={cashCounted} onChange={(e) => setCashCounted(e.target.value)} inputMode="decimal" placeholder="Cash counted" />
          <textarea className="field textarea" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="Nëse ka diskrepancë, shkruaj arsyen" rows={3} />
          <button className="btn btn-danger" disabled={busy} onClick={onCloseCycle}>
            Konfirmo mbylljen
          </button>
        </div>
      </Modal>

      <Modal open={pendingModal} title={`Pagesat në pritje (${pendingPays?.length || 0})`} onClose={() => setPendingModal(false)}>
        {!pendingPays?.length ? (
          <div className="empty-state">S’ka asnjë pagesë të mbetur jashtë arkës.</div>
        ) : (
          <div className="modal-stack">
            <div className="modal-note">
              Këto pagesa janë bërë gjatë kohës që arka ishte e mbyllur. A i ke paratë fizikisht?
            </div>
            <input className="field" value={pendingRejectNote} onChange={(e) => setPendingRejectNote(e.target.value)} placeholder="Shënim për borxh (opsional)" />

            <div className="group-list">
              {pendingGroups.map((g) => (
                <article key={g.pin} className="group-card">
                  <div className="group-head">
                    <div>
                      <div className="group-title">{g.pin === "PA_PIN" ? "Të panjohur" : g.pin}</div>
                      <div className="group-subtitle">Grupuar sipas PIN-it / burimit</div>
                    </div>
                    <div className="group-total">{euro(g.total)}</div>
                  </div>

                  <div className="item-list">
                    {g.items.map((p) => (
                      <div key={p.id} className="item-card">
                        <div className="item-head">
                          <div>
                            <div className="item-title">Porosia #{String(p.order_code || "").replace("#", "")}</div>
                            <div className="item-subtitle">{String(p.client_name || "Klient i panjohur")}</div>
                          </div>
                          <div className="item-amount">{euro(p.amount)}</div>
                        </div>
                        <div className="action-grid">
                          <button className="btn btn-success" disabled={pendingBusy} onClick={() => applyPending(p)}>
                            Prano
                          </button>
                          <button className="btn btn-ghost" disabled={pendingBusy} onClick={() => rejectPending(p)}>
                            Borxh
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={owedModal} title={`Borxhi i punëtorit (${owedPays?.length || 0})`} onClose={() => setOwedModal(false)}>
        {!owedPays?.length ? (
          <div className="empty-state">S’ka asnjë borxh aktiv.</div>
        ) : (
          <div className="modal-stack">
            <div className="modal-note">
              Këto pagesa janë shënuar si borxh për ty. Zgjidh nëse i ke dorëzuar paratë apo po i mban si avans.
            </div>
            <input className="field" value={owedNote} onChange={(e) => setOwedNote(e.target.value)} placeholder="Shënim opsional" />

            <div className="item-list">
              {owedPays.map((p) => (
                <div key={p.id || p.external_id || p.externalId} className="item-card">
                  <div className="item-head">
                    <div>
                      <div className="item-title">#{String(p.order_code || p.code || p.orderCode || "").replace("#", "")}</div>
                      <div className="item-subtitle">{String(p.client_name || p.name || p.clientName || "Klient")}</div>
                    </div>
                    <div className="item-amount">{euro(p.amount || 0)}</div>
                  </div>
                  <div className="action-grid">
                    <button
                      className="btn btn-primary"
                      disabled={owedBusy}
                      onClick={async () => {
                        setOwedBusy(true);
                        try {
                          await markOwedAsPending({ pending: p, actor: user });
                          await refresh();
                          if (owedPays.length <= 1) setOwedModal(false);
                        } finally {
                          setOwedBusy(false);
                        }
                      }}
                    >
                      Dorëzova paret
                    </button>

                    <button
                      className="btn btn-ghost"
                      disabled={owedBusy}
                      onClick={async () => {
                        setOwedBusy(true);
                        try {
                          await markOwedAsAdvance({ pending: p, actor: user, note: owedNote });
                          await refresh();
                          if (owedPays.length <= 1) setOwedModal(false);
                        } finally {
                          setOwedBusy(false);
                        }
                      }}
                    >
                      Prano avans
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <style jsx>{`
        .cash-shell {
          min-height: 100%;
          background: #000000;
          color: #ffffff;
          padding: 18px 16px 28px;
          max-width: 640px;
          margin: 0 auto;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .cash-topbar {
          display: grid;
          gap: 16px;
          margin-bottom: 18px;
        }

        .cash-heading {
          display: grid;
          gap: 6px;
        }

        .eyebrow {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.42);
        }

        .page-title {
          margin: 0;
          font-size: 34px;
          line-height: 0.98;
          letter-spacing: -0.06em;
          font-weight: 900;
          color: #ffffff;
        }

        .page-subtitle {
          font-size: 14px;
          line-height: 1.55;
          color: rgba(255,255,255,0.56);
        }

        .segmented {
          display: grid;
          gap: 6px;
          background: #111214;
          border: 1px solid rgba(255,255,255,0.06);
          padding: 6px;
          border-radius: 999px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
        }

        .seg-btn {
          appearance: none;
          border: none;
          min-height: 46px;
          border-radius: 999px;
          background: transparent;
          color: rgba(255,255,255,0.58);
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          transition: background .18s ease, color .18s ease, transform .18s ease;
        }

        .seg-active {
          background: rgba(255,255,255,0.14);
          color: #ffffff;
          box-shadow: 0 8px 20px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.05);
        }

        .stack {
          display: grid;
          gap: 14px;
        }

        .surface {
          background: #151518;
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 20px;
          padding: 18px;
          box-shadow: 0 14px 34px rgba(0,0,0,0.28);
        }

        .hero-card,
        .spotlight-card {
          padding: 22px;
        }

        .section-copy,
        .section-head,
        .modal-stack,
        .group-list,
        .item-list,
        .ledger-list {
          display: grid;
          gap: 12px;
        }

        .section-title {
          font-size: 22px;
          line-height: 1.05;
          font-weight: 800;
          letter-spacing: -0.04em;
          color: #ffffff;
        }

        .section-subtitle,
        .modal-note,
        .dispatch-meta,
        .ledger-note,
        .item-subtitle,
        .group-subtitle,
        .soft-meta {
          font-size: 13px;
          line-height: 1.5;
          color: rgba(255,255,255,0.58);
        }

        .soft-panel {
          background: #0f0f12;
          border: 1px solid rgba(255,255,255,0.04);
          border-radius: 18px;
          padding: 16px;
          display: grid;
          gap: 6px;
        }

        .compact {
          padding: 14px;
        }

        .soft-label,
        .metric-label {
          font-size: 12px;
          color: rgba(255,255,255,0.5);
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .soft-value,
        .metric-value,
        .dispatch-amount,
        .item-amount,
        .group-total,
        .spotlight-value {
          font-size: 32px;
          line-height: 1;
          font-weight: 900;
          letter-spacing: -0.05em;
          color: #ffffff;
        }

        .soft-inline {
          font-size: 18px;
          font-weight: 800;
          color: #ffffff;
        }

        .metrics-grid,
        .history-grid,
        .dispatch-stats,
        .field-row.two,
        .action-grid {
          display: grid;
          gap: 12px;
        }

        .metrics-grid,
        .dispatch-stats,
        .history-grid,
        .field-row.two,
        .action-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .metric-card {
          min-height: 128px;
          display: grid;
          align-content: space-between;
        }

        .spotlight-card {
          display: grid;
          gap: 10px;
        }

        .banner-action {
          appearance: none;
          border: 1px solid rgba(255,255,255,0.06);
          background: #151518;
          color: #ffffff;
          min-height: 58px;
          width: 100%;
          border-radius: 18px;
          padding: 0 18px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
          box-shadow: 0 14px 34px rgba(0,0,0,0.22);
        }

        .banner-left {
          display: inline-flex;
          align-items: center;
          gap: 12px;
        }

        .banner-dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: #34c759;
          box-shadow: 0 0 0 6px rgba(52,199,89,0.14);
          flex: 0 0 auto;
        }

        .field {
          width: 100%;
          min-height: 54px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.06);
          background: #0f0f12;
          color: #ffffff;
          padding: 0 16px;
          font-size: 15px;
          font-weight: 650;
          outline: none;
          box-sizing: border-box;
        }

        .textarea {
          padding-top: 14px;
          padding-bottom: 14px;
          min-height: 110px;
          resize: vertical;
        }

        .field:focus {
          border-color: rgba(255,255,255,0.16);
          box-shadow: 0 0 0 4px rgba(255,255,255,0.05);
        }

        .btn {
          appearance: none;
          border: none;
          width: 100%;
          min-height: 54px;
          border-radius: 16px;
          padding: 0 16px;
          font-size: 15px;
          font-weight: 800;
          cursor: pointer;
          transition: transform .16s ease, opacity .16s ease, box-shadow .16s ease;
        }

        .btn:disabled,
        .seg-btn:disabled,
        .chip-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn:not(:disabled):active,
        .seg-btn:not(:disabled):active,
        .chip-btn:not(:disabled):active {
          transform: scale(0.99);
        }

        .btn-primary {
          background: #ffffff;
          color: #000000;
          box-shadow: 0 10px 24px rgba(255,255,255,0.08);
        }

        .btn-secondary,
        .btn-ghost {
          background: rgba(255,255,255,0.06);
          color: #ffffff;
          border: 1px solid rgba(255,255,255,0.05);
        }

        .btn-success {
          background: #34c759;
          color: #061108;
          box-shadow: 0 10px 24px rgba(52,199,89,0.2);
        }

        .btn-danger {
          background: rgba(255,255,255,0.09);
          color: #ffffff;
          border: 1px solid rgba(255,255,255,0.06);
        }

        .ledger-item,
        .group-card,
        .item-card {
          background: #0f0f12;
          border: 1px solid rgba(255,255,255,0.04);
          border-radius: 18px;
          padding: 16px;
        }

        .ledger-main,
        .ledger-left,
        .group-head,
        .item-head,
        .dispatch-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .ledger-left {
          justify-content: flex-start;
          align-items: flex-start;
          flex: 1;
        }

        .ledger-copy {
          display: grid;
          gap: 4px;
        }

        .ledger-kind,
        .group-title,
        .item-title {
          font-size: 15px;
          font-weight: 800;
          color: #ffffff;
        }

        .ledger-amount {
          font-size: 22px;
          line-height: 1;
          font-weight: 900;
          color: #ffffff;
          letter-spacing: -0.04em;
        }

        .ledger-meta {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid rgba(255,255,255,0.05);
          display: flex;
          justify-content: space-between;
          gap: 12px;
          font-size: 12px;
          color: rgba(255,255,255,0.45);
        }

        .pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 28px;
          padding: 0 10px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.06em;
          background: rgba(255,255,255,0.06);
          color: #ffffff;
          text-transform: uppercase;
        }

        .pill-positive,
        .pill-negative {
          background: rgba(255,255,255,0.08);
          color: #ffffff;
        }

        .empty-state,
        .empty-card {
          text-align: center;
          color: rgba(255,255,255,0.55);
          font-size: 14px;
          font-weight: 600;
          padding: 18px 6px;
        }

        .notice {
          border-radius: 18px;
          padding: 14px 16px;
          margin-bottom: 14px;
          border: 1px solid rgba(255,255,255,0.05);
        }

        .notice-error {
          background: rgba(255,255,255,0.08);
          color: #ffffff;
        }

        .notice-warning {
          background: rgba(255,255,255,0.06);
          color: #ffffff;
        }

        .notice-title {
          font-size: 15px;
          font-weight: 800;
          margin-bottom: 4px;
        }

        .notice-text {
          font-size: 13px;
          color: rgba(255,255,255,0.68);
        }

        .summary-chip {
          border-radius: 18px;
          background: #0f0f12;
          border: 1px solid rgba(255,255,255,0.04);
          padding: 14px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          color: rgba(255,255,255,0.7);
          font-size: 13px;
          font-weight: 700;
        }

        .summary-chip strong {
          font-size: 22px;
          line-height: 1;
          letter-spacing: -0.04em;
          color: #ffffff;
        }

        .chip-btn {
          min-height: 46px;
          border: 1px solid rgba(255,255,255,0.05);
          background: #0f0f12;
          color: rgba(255,255,255,0.7);
          border-radius: 16px;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
        }

        .chip-active {
          background: rgba(255,255,255,0.12);
          color: #ffffff;
        }

        .modal-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.82);
          backdrop-filter: blur(18px);
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px;
        }

        .modal-content {
          width: min(100%, 520px);
          max-height: calc(100vh - 36px);
          overflow: auto;
          background: #151518;
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 24px;
          box-shadow: 0 18px 46px rgba(0,0,0,0.5);
          padding: 18px;
        }

        .modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }

        .modal-title {
          font-size: 20px;
          font-weight: 800;
          letter-spacing: -0.04em;
          color: #ffffff;
        }

        .icon-btn {
          appearance: none;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.05);
          color: #ffffff;
          width: 38px;
          height: 38px;
          border-radius: 999px;
          cursor: pointer;
          font-size: 15px;
          font-weight: 800;
        }

        @media (max-width: 560px) {
          .metrics-grid,
          .dispatch-stats,
          .history-grid,
          .field-row.two,
          .action-grid {
            grid-template-columns: 1fr;
          }

          .page-title {
            font-size: 30px;
          }

          .soft-value,
          .metric-value,
          .dispatch-amount,
          .item-amount,
          .group-total,
          .spotlight-value {
            font-size: 28px;
          }
        }
      `}</style>
    </div>
  );
}
