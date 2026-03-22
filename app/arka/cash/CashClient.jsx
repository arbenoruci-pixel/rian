"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import {
  listPendingCashPayments,
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
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("OPEN");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [pendingPays, setPendingPays] = useState([]);
  const [pendingRejectNote, setPendingRejectNote] = useState("");
  const [pendingModal, setPendingModal] = useState(false);
  const [pendingBusy, setPendingBusy] = useState(false);

  const [owedPays, setOwedPays] = useState([]);
  const [owedModal, setOwedModal] = useState(false);
  const [owedBusy, setOwedBusy] = useState(false);
  const [owedNote, setOwedNote] = useState("");

  const [handedList, setHandedList] = useState([]);

  const [companyBalance, setCompanyBalance] = useState(0);
  const [companyLedger, setCompanyLedger] = useState([]);
  const [budgetAmount, setBudgetAmount] = useState("");
  const [budgetCategory, setBudgetCategory] = useState("RROGË");
  const [budgetDescription, setBudgetDescription] = useState("");
  const [budgetBusy, setBudgetBusy] = useState(false);

  useEffect(() => {
    try {
      setUser(JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "null"));
    } catch {
      setUser(null);
    }
  }, []);

  const isDispatch = useMemo(() => {
    const role = String(user?.role || "").toUpperCase();
    return role === "DISPATCH" || role === "ADMIN";
  }, [user?.role]);

  const canAccessBudget = isDispatch;
  const hasPin = !!String(user?.pin || "").trim();

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
      .sort((a, b) => b.total - a.total || a.pin.localeCompare(b.pin));
  }, [pendingPays]);

  const openStats = useMemo(() => {
    const totalPending = (pendingPays || []).reduce((s, x) => s + Number(x.amount || 0), 0);
    const transportCollected = (pendingPays || [])
      .filter((x) => String(x?.type || "").toUpperCase() === "TRANSPORT")
      .reduce((s, x) => s + Number(x.amount || 0), 0);
    const workerDebt = (owedPays || [])
      .filter((x) => ["OWED", "REJECTED", "WORKER_DEBT"].includes(String(x?.status || "").toUpperCase()))
      .reduce((s, x) => s + Number(x.amount || 0), 0);
    const advances = (owedPays || [])
      .filter((x) => String(x?.status || "").toUpperCase() === "ADVANCE")
      .reduce((s, x) => s + Number(x.amount || 0), 0);
    return { totalPending, transportCollected, workerDebt, advances };
  }, [pendingPays, owedPays]);

  async function loadBudgetView(limit = 40) {
    try {
      const { data } = await supabase
        .from("company_budget_summary")
        .select("current_balance")
        .eq("id", 1)
        .single();
      setCompanyBalance(Number(data?.current_balance || 0));
    } catch {
      setCompanyBalance(0);
    }

    try {
      const ledger = await listCompanyLedger(limit);
      setCompanyLedger(Array.isArray(ledger) ? ledger : []);
    } catch {
      setCompanyLedger([]);
    }
  }

  async function refresh() {
    setErr("");
    try {
      try {
        const res = await listPendingCashPayments(120);
        setPendingPays(Array.isArray(res?.items) ? res.items : []);
      } catch {
        setPendingPays([]);
      }

      try {
        const handoffs = await listPendingDispatchHandoffs();
        setHandedList(Array.isArray(handoffs) ? handoffs : []);
      } catch {
        setHandedList([]);
      }

      if (hasPin) {
        try {
          const rows = await listWorkerDebtRows(user.pin, 80);
          setOwedPays(Array.isArray(rows) ? rows : []);
        } catch {
          setOwedPays([]);
        }
      } else {
        setOwedPays([]);
      }

      if (canAccessBudget || tab === "HISTORI") {
        await loadBudgetView(tab === "HISTORI" ? 80 : 24);
      }
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    if (!user && typeof window !== "undefined") return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, user?.pin, user?.role]);

  async function rejectPending(p) {
    const conf = window.confirm("A jeni i sigurt që doni ta shënoni këtë pagesë si BORXH?");
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
      if (rejected?.ok === false) throw new Error(rejected.error || "Dështoi shënimi si borxh");
      await refresh();
    } catch (e) {
      alert("❌ GABIM BORXHI: " + (e.message || String(e)));
    } finally {
      setPendingBusy(false);
    }
  }

  async function backToPending(p) {
    setOwedBusy(true);
    try {
      const res = await markOwedAsPending({
        pending: p,
        actor: { pin: user?.pin || null, name: user?.name || null, role: user?.role || null },
      });
      if (res?.ok === false) throw new Error(res.error || "Dështoi rikthimi në pending");
      await refresh();
    } catch (e) {
      alert("❌ GABIM: " + (e.message || String(e)));
    } finally {
      setOwedBusy(false);
    }
  }

  async function convertToAdvance(p) {
    setOwedBusy(true);
    try {
      const res = await markOwedAsAdvance({
        pending: p,
        actor: { pin: user?.pin || null, name: user?.name || null, role: user?.role || null },
        note: owedNote || null,
      });
      if (res?.ok === false) throw new Error(res.error || "Dështoi kalimi në avans");
      await refresh();
    } catch (e) {
      alert("❌ GABIM: " + (e.message || String(e)));
    } finally {
      setOwedBusy(false);
    }
  }

  async function onReceiveHandoff(handoffId) {
    if (!handoffId) return;
    if (!isDispatch) {
      setErr("VETËM DISPATCH / ADMIN MUND TA PRANOJË DORËZIMIN.");
      return;
    }
    setBusy(true);
    try {
      await acceptDispatchHandoff({
        handoffId,
        actor: { pin: user?.pin || null, name: user?.name || null },
      });
      await refresh();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRejectHandoff(handoffId) {
    if (!handoffId) return;
    if (!isDispatch) {
      setErr("VETËM DISPATCH / ADMIN MUND TA REFUZOJË DORËZIMIN.");
      return;
    }
    const note = window.prompt("Shënim për refuzimin", "KTHYER NGA DISPATCH") || "";
    setBusy(true);
    try {
      await rejectDispatchHandoff({
        handoffId,
        actor: { pin: user?.pin || null, name: user?.name || null },
        note,
      });
      await refresh();
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

  const recentBudgetOut = useMemo(
    () => (companyLedger || []).filter((x) => String(x?.direction || "").toUpperCase() === "OUT").slice(0, 12),
    [companyLedger]
  );

  return (
    <div className="cash-shell">
      <div className="cash-topbar">
        <div className="cash-heading">
          <div className="eyebrow">Apple dark mode</div>
          <h1 className="page-title">Cash Center</h1>
          <div className="page-subtitle">
            Pagesat në pritje, dispatch handoffs, buxheti dhe historia korporative.
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

      {tab === "OPEN" && (
        <div className="stack fade-in">
          <section className="metrics-grid">
            <article className="surface metric-card">
              <div className="metric-label">Cash në pritje</div>
              <div className="metric-value">{euro(openStats.totalPending)}</div>
            </article>
            <article className="surface metric-card">
              <div className="metric-label">Transport collected</div>
              <div className="metric-value">{euro(openStats.transportCollected)}</div>
            </article>
            <article className="surface metric-card">
              <div className="metric-label">Borxhe aktive</div>
              <div className="metric-value">{euro(openStats.workerDebt)}</div>
            </article>
            <article className="surface metric-card">
              <div className="metric-label">Avanse</div>
              <div className="metric-value">{euro(openStats.advances)}</div>
            </article>
          </section>

          <section className="surface hero-card">
            <div className="section-copy">
              <div className="eyebrow">Open queue</div>
              <div className="section-title">Pagesat në pritje</div>
              <div className="section-subtitle">
                Këto janë pagesat cash që kanë hyrë në sistem dhe presin trajtim financiar.
              </div>
            </div>
            <button className="btn btn-primary" onClick={() => setPendingModal(true)}>
              Shiko pagesat ({pendingPays?.length || 0})
            </button>
          </section>

          <section className="surface ledger-card">
            <div className="section-head">
              <div>
                <div className="section-title">Përmbledhje sipas PIN-it</div>
                <div className="section-subtitle">Grupim i shpejtë për të parë kush ka cash në pritje.</div>
              </div>
            </div>

            {pendingGroups.length ? (
              <div className="group-list">
                {pendingGroups.map((g) => (
                  <article key={g.pin} className="group-card">
                    <div className="group-head">
                      <div>
                        <div className="group-title">{g.pin === "PA_PIN" ? "Të panjohur" : g.pin}</div>
                        <div className="group-subtitle">{g.items.length} pagesa në pritje</div>
                      </div>
                      <div className="group-total">{euro(g.total)}</div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">S’ka pagesa në pritje.</div>
            )}
          </section>

          {hasPin && (
            <section className="surface ledger-card">
              <div className="section-head">
                <div>
                  <div className="section-title">Borxhi / Avanset e mia</div>
                  <div className="section-subtitle">Rreshtat aktivë për PIN-in tënd.</div>
                </div>
                <button className="btn btn-ghost" onClick={() => setOwedModal(true)}>
                  Shiko detajet ({owedPays?.length || 0})
                </button>
              </div>

              {owedPays?.length ? (
                <div className="ledger-list">
                  {owedPays.slice(0, 5).map((p) => {
                    const status = String(p?.status || "").toUpperCase();
                    const negative = ["OWED", "REJECTED", "WORKER_DEBT"].includes(status);
                    return (
                      <article key={p.id || p.external_id} className="ledger-item">
                        <div className="ledger-main">
                          <div className="ledger-left">
                            <span className={`pill ${negative ? "pill-negative" : "pill-positive"}`}>{status || "-"}</span>
                            <div className="ledger-copy">
                              <div className="ledger-kind">Porosia #{String(p.order_code || "").replace("#", "") || "-"}</div>
                              <div className="ledger-note">{p.client_name || p.note || "Pa përshkrim"}</div>
                            </div>
                          </div>
                          <div className="ledger-amount">{negative ? "-" : "+"}{euro(p.amount)}</div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">S’ka asnjë borxh apo avans aktiv për PIN-in tënd.</div>
              )}
            </section>
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

                {!!(h.cash_handoff_items || []).length && (
                  <div className="item-list">
                    {(h.cash_handoff_items || []).map((it) => (
                      <div key={it.id} className="item-card slim">
                        <div className="item-head">
                          <div>
                            <div className="item-title">#{String(it.order_code || "").replace("#", "") || "-"}</div>
                            <div className="item-subtitle">Pending payment #{it.pending_payment_id || "-"}</div>
                          </div>
                          <div className="item-amount">{euro(it.amount)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="action-grid">
                  <button className="btn btn-success" disabled={busy || !isDispatch} onClick={() => onReceiveHandoff(h.id)}>
                    Prano dorëzimin
                  </button>
                  <button className="btn btn-ghost" disabled={busy || !isDispatch} onClick={() => onRejectHandoff(h.id)}>
                    Refuzo
                  </button>
                </div>
              </section>
            ))
          ) : (
            <section className="surface empty-card">
              S’ka asnjë handoff në pritje për dispatch.
            </section>
          )}
        </div>
      )}

      {tab === "BUXHETI" && canAccessBudget && (
        <div className="stack fade-in">
          <section className="surface spotlight-card">
            <div className="metric-label">Buxheti aktual i kompanisë</div>
            <div className="spotlight-value">{euro(companyBalance)}</div>
          </section>

          <section className="surface form-card">
            <div className="section-head">
              <div>
                <div className="section-title">Shpenzim nga kompania</div>
                <div className="section-subtitle">Regjistro pagesë nga company budget summary + ledger.</div>
              </div>
            </div>

            <div className="field-row two">
              <input
                className="field"
                value={budgetAmount}
                onChange={(e) => setBudgetAmount(e.target.value)}
                inputMode="decimal"
                placeholder="Shuma"
              />
              <select className="field" value={budgetCategory} onChange={(e) => setBudgetCategory(e.target.value)}>
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
                <div className="section-subtitle">Daljet më të fundit nga company_budget_ledger.</div>
              </div>
            </div>

            {recentBudgetOut?.length ? (
              <div className="ledger-list">
                {recentBudgetOut.map((item) => (
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
          <section className="surface ledger-card">
            <div className="section-head">
              <div>
                <div className="section-title">Historia e korporatës</div>
                <div className="section-subtitle">Lëvizjet më të fundit nga company_budget_ledger.</div>
              </div>
            </div>

            {companyLedger?.length ? (
              <div className="ledger-list">
                {companyLedger.map((item) => {
                  const isIn = String(item?.direction || "").toUpperCase() === "IN";
                  return (
                    <article key={item.id} className="ledger-item">
                      <div className="ledger-main">
                        <div className="ledger-left">
                          <span className={`pill ${isIn ? "pill-positive" : "pill-negative"}`}>
                            {String(item.direction || "-")}
                          </span>
                          <div className="ledger-copy">
                            <div className="ledger-kind">{item.description || item.category || "Lëvizje korporative"}</div>
                            <div className="ledger-note">
                              {item.category || "TJETER"} • {item.created_by_name || item.approved_by_name || "Sistemi"}
                            </div>
                          </div>
                        </div>
                        <div className="ledger-amount">{isIn ? "+" : "-"}{euro(item.amount)}</div>
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
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">S’ka histori korporative akoma.</div>
            )}
          </section>
        </div>
      )}

      <Modal open={pendingModal} title={`Pagesat në pritje (${pendingPays?.length || 0})`} onClose={() => setPendingModal(false)}>
        {!pendingPays?.length ? (
          <div className="empty-state">S’ka asnjë pagesë të mbetur në pritje.</div>
        ) : (
          <div className="modal-stack">
            <div className="modal-note">
              Këto pagesa presin trajtim. Mund t’i kalosh si borxh nëse paratë nuk janë dorëzuar realisht.
            </div>
            <input
              className="field"
              value={pendingRejectNote}
              onChange={(e) => setPendingRejectNote(e.target.value)}
              placeholder="Shënim për borxh (opsional)"
            />

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
                      <div key={p.id || p.external_id} className="item-card">
                        <div className="item-head">
                          <div>
                            <div className="item-title">Porosia #{String(p.order_code || "").replace("#", "") || "-"}</div>
                            <div className="item-subtitle">{String(p.client_name || "Klient i panjohur")}</div>
                          </div>
                          <div className="item-amount">{euro(p.amount)}</div>
                        </div>
                        <div className="action-grid">
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

      <Modal open={owedModal} title={`Borxhi / Avanset (${owedPays?.length || 0})`} onClose={() => setOwedModal(false)}>
        {!owedPays?.length ? (
          <div className="empty-state">S’ka asnjë rresht aktiv.</div>
        ) : (
          <div className="modal-stack">
            <div className="modal-note">
              Riktheje një borxh në pending kur paratë janë dorëzuar, ose kaloje si avans kur mbetet te puntori.
            </div>
            <input
              className="field"
              value={owedNote}
              onChange={(e) => setOwedNote(e.target.value)}
              placeholder="Shënim për avans (opsional)"
            />
            <div className="item-list">
              {owedPays.map((p) => {
                const status = String(p?.status || "").toUpperCase();
                const canReturn = status !== "ADVANCE";
                return (
                  <div key={p.id || p.external_id} className="item-card">
                    <div className="item-head">
                      <div>
                        <div className="item-title">#{String(p.order_code || "").replace("#", "") || "-"}</div>
                        <div className="item-subtitle">{p.client_name || p.note || "Pa përshkrim"}</div>
                      </div>
                      <div className="item-amount">{euro(p.amount)}</div>
                    </div>
                    <div className="ledger-meta ledger-meta-inline">
                      <span>{status || "-"}</span>
                      <span>{p.created_at ? new Date(p.created_at).toLocaleString("sq-AL") : ""}</span>
                    </div>
                    <div className="action-grid">
                      {canReturn && (
                        <button className="btn btn-success" disabled={owedBusy} onClick={() => backToPending(p)}>
                          Ktheje në Pending
                        </button>
                      )}
                      <button className="btn btn-ghost" disabled={owedBusy} onClick={() => convertToAdvance(p)}>
                        Kaloje në Avans
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Modal>

      <style jsx>{`
        .cash-shell {
          min-height: 100vh;
          background: #000000;
          color: #ffffff;
          padding: 18px 14px 110px;
        }

        .cash-topbar,
        .stack {
          display: grid;
          gap: 14px;
          max-width: 1120px;
          margin: 0 auto;
        }

        .cash-topbar {
          margin-bottom: 14px;
        }

        .eyebrow {
          font-size: 11px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.16em;
          color: rgba(255,255,255,0.42);
          margin-bottom: 8px;
        }

        .page-title {
          margin: 0;
          font-size: 38px;
          line-height: 1;
          font-weight: 900;
          letter-spacing: -0.05em;
        }

        .page-subtitle,
        .section-subtitle,
        .group-subtitle,
        .item-subtitle,
        .dispatch-meta,
        .ledger-note,
        .modal-note {
          color: rgba(255,255,255,0.62);
          font-size: 13px;
          line-height: 1.45;
        }

        .segmented {
          display: grid;
          gap: 8px;
          padding: 8px;
          border-radius: 22px;
          background: #151518;
          border: 1px solid rgba(255,255,255,0.04);
        }

        .seg-btn {
          min-height: 48px;
          border: 0;
          border-radius: 16px;
          background: transparent;
          color: rgba(255,255,255,0.58);
          font-size: 14px;
          font-weight: 800;
          letter-spacing: 0.02em;
          cursor: pointer;
        }

        .seg-active {
          background: linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.06));
          color: #ffffff;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
        }

        .surface {
          background: #151518;
          border-radius: 26px;
          padding: 18px;
          box-shadow: 0 10px 28px rgba(0,0,0,0.32);
        }

        .hero-card,
        .spotlight-card,
        .form-card,
        .ledger-card,
        .dispatch-card,
        .empty-card {
          display: grid;
          gap: 14px;
        }

        .metrics-grid,
        .dispatch-stats,
        .field-row.two,
        .action-grid,
        .history-grid {
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .metrics-grid {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }

        .metric-card,
        .soft-panel,
        .group-card,
        .item-card {
          background: #0f0f12;
          border-radius: 20px;
          border: 1px solid rgba(255,255,255,0.04);
          padding: 14px;
        }

        .compact,
        .item-card.slim {
          padding: 12px 14px;
        }

        .metric-label,
        .soft-label {
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.42);
        }

        .metric-value,
        .soft-value,
        .dispatch-amount,
        .item-amount,
        .group-total,
        .spotlight-value {
          font-size: 34px;
          line-height: 1;
          font-weight: 900;
          letter-spacing: -0.05em;
          color: #ffffff;
          margin-top: 10px;
        }

        .soft-inline {
          margin-top: 8px;
          font-size: 16px;
          font-weight: 800;
        }

        .section-title {
          font-size: 22px;
          line-height: 1.05;
          letter-spacing: -0.04em;
          font-weight: 850;
          color: #ffffff;
        }

        .section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .btn,
        .field,
        .textarea {
          width: 100%;
          min-height: 50px;
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.05);
          background: #0f0f12;
          color: #ffffff;
          font-size: 15px;
          padding: 0 16px;
          outline: none;
        }

        .textarea {
          padding: 14px 16px;
          min-height: 104px;
          resize: vertical;
        }

        .btn {
          cursor: pointer;
          font-weight: 800;
          background: rgba(255,255,255,0.06);
        }

        .btn-primary {
          background: linear-gradient(180deg, #ffffff, #dddddd);
          color: #000000;
          border: 0;
        }

        .btn-success {
          background: rgba(255,255,255,0.12);
        }

        .btn-danger,
        .btn-ghost {
          background: rgba(255,255,255,0.05);
        }

        .group-list,
        .item-list,
        .ledger-list,
        .modal-stack {
          display: grid;
          gap: 12px;
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

        .ledger-meta-inline {
          margin-top: 10px;
          padding-top: 10px;
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
          max-width: 1120px;
          margin: 0 auto 14px;
          border-radius: 18px;
          padding: 14px 16px;
          border: 1px solid rgba(255,255,255,0.05);
        }

        .notice-error {
          background: rgba(255,255,255,0.08);
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
          width: min(100%, 620px);
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

        @media (max-width: 880px) {
          .metrics-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
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
