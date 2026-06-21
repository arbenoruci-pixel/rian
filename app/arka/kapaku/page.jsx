"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { supabase } from "@/lib/supabaseClient";
import { getActor } from "@/lib/actorSession";
import { buildMonthlyPayrollPreview, getCurrentPayrollMonth, getMonthWindow } from "@/lib/payrollMonthClose";

const RESERVE_AMOUNT = 1000;
const OWNER_REPAYMENT_PERCENT = 30;
const PROFIT_SPLIT_PERCENT = 70;
const OWNER_PROFIT_SHARE = 50;
const DB_TIMEOUT_MS = 4500;
const OPEN_CASH_STATUSES = ["PENDING", "COLLECTED"];
const OPEN_CASH_EXCLUDED_TYPES = new Set([
  "EXPENSE",
  "TIMA",
  "MEAL_PAYMENT",
  "MEAL_COVERED",
  "ADVANCE",
  "SALARY_PAYMENT",
]);

function n(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function parseMoneyInput(value) {
  const raw = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isKapakuManager(actor) {
  const role = upper(actor?.role);
  const pin = String(actor?.pin || "").trim();
  return pin === "2380" || ["MASTER", "ADMIN", "ADMIN_MASTER", "SUPERADMIN", "DISPATCH"].includes(role);
}

function budgetCategoryLabel(value) {
  const key = upper(value);
  if (key === "WORKER_TO_DISPATCH") return "PRANIM NGA DISPATCH";
  if (key === "MASTER_CASH_RECONCILE") return "RREGULLIM MASTER CASH";
  if (key === "PAYROLL_MONTH_CLOSE") return "MBYLLJE RROGASH";
  if (key === "MANUAL_BUDGET_ADJUSTMENT") return "RREGULLIM MANUAL BUXHETI";
  if (key === "OWNER_CAPITAL_IN") return "KAPITAL PRONARI";
  if (key === "OWNER_LOAN_IN") return "BORXH PRONARI";
  if (key === "OWNER_REPAYMENT_OUT") return "KTHIM PRONARI";
  if (key === "OWNER_PROFIT_DISTRIBUTION_OUT") return "NDARJE PROFITI";
  return value || "LËVIZJE";
}

function ownerEntryTypeLabel(value) {
  const key = upper(value);
  if (key === "CAPITAL_LONG_TERM") return "AFATGJATË";
  if (key === "LOAN_SHORT_TERM") return "AFATSHKURT";
  if (key === "REPAYMENT") return "KTHIM";
  if (key === "CORRECTION") return "KORRIGJIM";
  if (key === "WRITE_OFF") return "SHLYERJE";
  return value || "—";
}

function actionTitle(mode) {
  if (mode === "ADD_BUDGET") return "SHTO BUXHET";
  if (mode === "REMOVE_BUDGET") return "HEK NGA BUXHETI";
  if (mode === "ALIGN_BALANCE") return "RREGULLO CASH-IN REAL";
  return "RREGULLIM BUXHETI";
}

function money(value) {
  return `€${n(value).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(value) {
  const amount = n(value);
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${money(Math.abs(amount))}`;
}

function fmtDateTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("sq-AL", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function compactError(error) {
  const msg = String(error?.message || error?.details || error?.hint || error || "").trim();
  if (!msg) return "Nuk u lexua";
  if (msg.length > 120) return `${msg.slice(0, 120)}...`;
  return msg;
}

function withTimeout(promise, ms = DB_TIMEOUT_MS, label = "Kërkesa mori shumë kohë") {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(label)), ms);
    }),
  ]).finally(() => {
    try {
      if (timer) window.clearTimeout(timer);
    } catch {}
  });
}

function startOfCurrentMonthIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0).toISOString();
}

function isOpenCashRow(row) {
  const status = upper(row?.status);
  const type = upper(row?.type);
  if (!OPEN_CASH_STATUSES.includes(status)) return false;
  if (OPEN_CASH_EXCLUDED_TYPES.has(type)) return false;
  return true;
}

function ownerBucket(entries = [], ownerId, entryType) {
  return entries
    .filter((entry) => String(entry?.owner_id) === String(ownerId))
    .filter((entry) => upper(entry?.status || "ACTIVE") === "ACTIVE")
    .filter((entry) => upper(entry?.entry_type) === entryType)
    .reduce((sum, entry) => sum + n(entry?.remaining_amount), 0);
}

function ownerTotal(entries = [], ownerId) {
  return entries
    .filter((entry) => String(entry?.owner_id) === String(ownerId))
    .filter((entry) => upper(entry?.status || "ACTIVE") === "ACTIVE")
    .reduce((sum, entry) => sum + n(entry?.remaining_amount), 0);
}

function sourceLabel(row) {
  const src = String(row?.source_type || row?.source || "").trim();
  const id = row?.source_id || row?.sourceId || "";
  if (src && id) return `${budgetCategoryLabel(src)} #${id}`;
  return src ? budgetCategoryLabel(src) : (id ? `#${id}` : "—");
}

function ledgerDescription(row) {
  return String(row?.description || row?.note || row?.memo || row?.category || "—").trim() || "—";
}

function normalizeRpcArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRpcObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function readKapakuPreview({ startIso, endIso }) {
  const res = await withTimeout(
    supabase.rpc("get_arka_kapaku_preview", {
      p_month_start: startIso,
      p_month_end: endIso,
    }),
    DB_TIMEOUT_MS,
    "Kapaku preview: Nuk u lexua"
  );
  if (res?.error) throw res.error;
  return res?.data || {};
}

function MiniStat({ label, value, tone = "neutral", sub = "" }) {
  return (
    <div className={`arkaMiniStat ${tone}`}>
      <div className="arkaMiniStatLabel">{label}</div>
      <div className="arkaMiniStatValue">{value}</div>
      {sub ? <div className="arkaMiniStatSub">{sub}</div> : null}
    </div>
  );
}

function RowLine({ label, value, strong = false, tone = "" }) {
  return (
    <div style={styles.rowLine}>
      <span style={styles.rowLabel}>{label}</span>
      <strong style={{ ...styles.rowValue, ...(strong ? styles.rowValueStrong : null), ...(tone === "bad" ? styles.badText : null), ...(tone === "ok" ? styles.okText : null) }}>{value}</strong>
    </div>
  );
}

function ReadError({ label, error }) {
  if (!error) return null;
  return (
    <div style={styles.errorBox}>
      {label}: {error || "Nuk u lexua"}
    </div>
  );
}

function KapakuPage() {
  const [loading, setLoading] = useState(true);
  const [actor, setActor] = useState(null);
  const [actionMode, setActionMode] = useState(null);
  const [form, setForm] = useState({ amount: "", targetBalance: "", reason: "", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [state, setState] = useState({
    summary: null,
    ledger: [],
    owners: [],
    ownerEntries: [],
    fixedExpenses: [],
    users: [],
    monthPayments: [],
    openPayments: [],
    handoffs: [],
    errors: {},
  });

  async function reload() {
    setLoading(true);
    const month = getCurrentPayrollMonth();
    const { startIso, endIso } = getMonthWindow(month);

    try {
      const data = await readKapakuPreview({ startIso, endIso });
      setState({
        summary: normalizeRpcObject(data?.summary),
        ledger: normalizeRpcArray(data?.ledger),
        owners: normalizeRpcArray(data?.owners),
        ownerEntries: normalizeRpcArray(data?.ownerEntries),
        fixedExpenses: normalizeRpcArray(data?.fixedExpenses),
        users: normalizeRpcArray(data?.users),
        monthPayments: normalizeRpcArray(data?.monthPayments),
        openPayments: normalizeRpcArray(data?.openPayments),
        handoffs: normalizeRpcArray(data?.handoffs),
        errors: {},
      });
    } catch (error) {
      setState({
        summary: null,
        ledger: [],
        owners: [],
        ownerEntries: [],
        fixedExpenses: [],
        users: [],
        monthPayments: [],
        openPayments: [],
        handoffs: [],
        errors: {
          preview: compactError(error) || "Nuk u lexua",
          owners: "Nuk u lexua",
          ownerEntries: "Nuk u lexua",
        },
      });
    }

    setLoading(false);
  }

  useEffect(() => {
    try { setActor(getActor()); } catch { setActor(null); }
  }, []);

  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      if (alive) void reload();
    }, 80);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, []);

  const computed = useMemo(() => {
    const companyCash = n(state.summary?.current_balance);
    const totalIn = n(state.summary?.total_in);
    const totalOut = n(state.summary?.total_out);

    const activeOwners = (state.owners || []).filter((owner) => owner?.is_active !== false);
    const ownerCards = activeOwners.map((owner) => ({
      ...owner,
      totalRemaining: ownerTotal(state.ownerEntries, owner?.id),
      shortTermRemaining: ownerBucket(state.ownerEntries, owner?.id, "LOAN_SHORT_TERM"),
      longTermRemaining: ownerBucket(state.ownerEntries, owner?.id, "CAPITAL_LONG_TERM"),
    }));
    const totalOwnerBalance = ownerCards.reduce((sum, owner) => sum + n(owner.totalRemaining), 0);

    const fixedRows = (state.fixedExpenses || []).filter((row) => row && row.active !== false);
    const essentialObligations = fixedRows
      .filter((row) => row?.essential !== false)
      .reduce((sum, row) => sum + n(row?.amount), 0);

    const payrollRows = buildMonthlyPayrollPreview({
      workers: state.users || [],
      paymentRows: state.monthPayments || [],
      month: getCurrentPayrollMonth(),
    });
    const payrollNet = payrollRows.reduce((sum, row) => sum + n(row?.net), 0);

    const openCashRows = (state.openPayments || []).filter(isOpenCashRow);
    const masterCashRows = openCashRows.filter((row) => String(row?.created_by_pin || "").trim() === "2380");
    const workerCashRows = openCashRows.filter((row) => String(row?.created_by_pin || "").trim() !== "2380");
    const masterCash = masterCashRows.reduce((sum, row) => sum + n(row?.amount), 0);
    const workerCash = workerCashRows.reduce((sum, row) => sum + n(row?.amount), 0);
    const openCashBlockers = masterCash + workerCash;

    const pendingDispatch = (state.handoffs || []).reduce((sum, row) => sum + n(row?.amount || row?.total_amount), 0);

    const distributableProfit = +(
      companyCash
      - RESERVE_AMOUNT
      - essentialObligations
      - payrollNet
      - openCashBlockers
      - pendingDispatch
    ).toFixed(2);

    const positiveProfit = Math.max(0, distributableProfit);
    const ownerRepaymentPool = +(positiveProfit * (OWNER_REPAYMENT_PERCENT / 100)).toFixed(2);
    const profitSplitPool = +(positiveProfit - ownerRepaymentPool).toFixed(2);
    const arbenProfit = +(profitSplitPool * (OWNER_PROFIT_SHARE / 100)).toFixed(2);
    const fitimProfit = +(profitSplitPool * (OWNER_PROFIT_SHARE / 100)).toFixed(2);

    return {
      companyCash,
      totalIn,
      totalOut,
      ownerCards,
      totalOwnerBalance,
      essentialObligations,
      payrollRows,
      payrollNet,
      workerCash,
      masterCash,
      openCashBlockers,
      pendingDispatch,
      distributableProfit,
      ownerRepaymentPool,
      profitSplitPool,
      arbenProfit,
      fitimProfit,
    };
  }, [state]);

  const canManageKapaku = isKapakuManager(actor);
  const formAmount = parseMoneyInput(form.amount);
  const formTargetBalance = parseMoneyInput(form.targetBalance);
  const previewAfter = actionMode === "ADD_BUDGET"
    ? +(computed.companyCash + formAmount).toFixed(2)
    : actionMode === "REMOVE_BUDGET"
      ? +(computed.companyCash - formAmount).toFixed(2)
      : actionMode === "ALIGN_BALANCE"
        ? +formTargetBalance.toFixed(2)
        : computed.companyCash;
  const previewDelta = +(previewAfter - computed.companyCash).toFixed(2);

  function openBudgetAction(mode) {
    setActionMode(mode);
    setForm({ amount: "", targetBalance: "", reason: "", note: "" });
    setActionError("");
    setActionMessage("");
  }

  function closeBudgetAction() {
    if (submitting) return;
    setActionMode(null);
    setActionError("");
  }

  function updateForm(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setActionError("");
  }

  async function confirmBudgetAction() {
    if (!actionMode || submitting) return;
    const pin = String(actor?.pin || "").trim();
    const name = String(actor?.name || actor?.full_name || pin || "").trim();
    const reason = String(form.reason || "").trim();
    const note = String(form.note || "").trim();

    if (!canManageKapaku) {
      setActionError("Nuk ke qasje për këtë veprim.");
      return;
    }
    if (!pin) {
      setActionError("Mungon PIN-i i përdoruesit.");
      return;
    }
    if (!reason) {
      setActionError("Shkruaj arsyen e rregullimit.");
      return;
    }
    if ((actionMode === "ADD_BUDGET" || actionMode === "REMOVE_BUDGET") && formAmount <= 0) {
      setActionError("Shuma duhet të jetë më e madhe se 0.");
      return;
    }
    if (actionMode === "ALIGN_BALANCE" && formTargetBalance < 0) {
      setActionError("Cash real i numëruar nuk mund të jetë negativ.");
      return;
    }

    setSubmitting(true);
    setActionError("");
    setActionMessage("");
    try {
      const { error } = await supabase.rpc("post_manual_budget_adjustment", {
        p_adjustment_type: actionMode,
        p_amount: actionMode === "ALIGN_BALANCE" ? null : formAmount,
        p_target_balance: actionMode === "ALIGN_BALANCE" ? formTargetBalance : null,
        p_reason: reason,
        p_note: note || null,
        p_actor_pin: pin,
        p_actor_name: name || null,
      });
      if (error) throw error;
      setActionMode(null);
      setActionMessage("Buxheti u përditësua.");
      await reload();
    } catch (error) {
      setActionError(compactError(error) || "Buxheti nuk u përditësua.");
    } finally {
      setSubmitting(false);
    }
  }


  return (
    <div className="arkaSimplePage">
      <div className="arkaSimpleTop">
        <div>
          <div className="arkaSimpleEyebrow">KAPAKU I ARKËS</div>
          <h1 className="arkaSimpleTitle">KAPAKU I ARKËS</h1>
          <div className="arkaSimpleSub">KAPAKU • PREVIEW • RREGULLIME TË AUDITUARA</div>
        </div>
        <div className="arkaSimpleNav">
          <button className="arkaTopBtn" type="button" onClick={reload} disabled={loading}>{loading ? "DUKE LEXUAR" : "RIFRESKO"}</button>
          <Link className="arkaTopBtn" to="/arka">ARKA</Link>
        </div>
      </div>

      {loading ? <div className="arkaLoaderCard">DUKE LEXUAR KAPAKUN E ARKËS...</div> : null}
      {actionMessage ? <div style={styles.successBox}>{actionMessage}</div> : null}
      {actionError && !actionMode ? <div style={styles.errorBox}>BUXHETI: {actionError}</div> : null}
      <ReadError label="Kapaku preview RPC" error={state.errors.preview} />

      <section className="arkaHeroSingle arkaHeroMainDue">
        <div>
          <div className="arkaSectionTitle">BUXHETI AKTUAL</div>
          <div className="arkaSectionSub">COMPANY_BUDGET_SUMMARY ID=1</div>
        </div>
        <div className="arkaHeroDueHuge">{money(computed.companyCash)}</div>
      </section>

      <section className="arkaSectionCard">
        <div className="arkaSectionHeadCompact">
          <div>
            <div className="arkaSectionTitle">BUXHETI AKTUAL</div>
            <div className="arkaSectionSub">Cash në kompani / hyrje / dalje</div>
          </div>
          {canManageKapaku ? (
            <div style={styles.actionBtnWrap}>
              <button className="arkaTopBtn" type="button" onClick={() => openBudgetAction("ADD_BUDGET")}>SHTO BUXHET</button>
              <button className="arkaTopBtn" type="button" onClick={() => openBudgetAction("REMOVE_BUDGET")}>HEK NGA BUXHETI</button>
              <button className="arkaTopBtn" type="button" onClick={() => openBudgetAction("ALIGN_BALANCE")}>RREGULLO CASH-IN REAL</button>
            </div>
          ) : null}
        </div>
        <div className="arkaOwnerFormulaGrid compactStats">
          <MiniStat label="Cash në kompani" value={money(computed.companyCash)} tone="ok" />
          <MiniStat label="Total hyrje" value={money(computed.totalIn)} tone="info" />
          <MiniStat label="Total dalje" value={money(computed.totalOut)} tone="warn" />
          <MiniStat label="Përditësuar" value={fmtDateTime(state.summary?.updated_at)} tone="muted" />
        </div>
        <ReadError label="Buxheti aktual" error={state.errors.summary} />
      </section>

      <section className="arkaSectionCard">
        <div className="arkaSectionHeadCompact">
          <div>
            <div className="arkaSectionTitle">BORXHET NDAJ PRONARËVE</div>
            <div className="arkaSectionSub">Borxhe / investime • balancë historike</div>
          </div>
          <div className="arkaCashTotalPill">TOTAL {money(computed.totalOwnerBalance)}</div>
        </div>

        <div className="arkaSplitGrid detailPage">
          {computed.ownerCards.length ? computed.ownerCards.map((owner) => (
            <div key={owner.id || owner.owner_key} className="arkaWorkerCard">
              <div className="arkaWorkerTop">
                <div>
                  <div className="arkaWorkerName">{owner.display_name || owner.owner_key}</div>
                  <div className="arkaWorkerMeta">{owner.owner_key} • PROFIT {n(owner.profit_share_percent).toFixed(0)}%</div>
                </div>
                <div className="arkaCashTotalPill">{money(owner.totalRemaining)}</div>
              </div>
              <div style={styles.cleanBox}>
                <RowLine label="Afatshkurt" value={money(owner.shortTermRemaining)} />
                <RowLine label="Afatgjatë" value={money(owner.longTermRemaining)} />
                <RowLine label="Total i mbetur" value={money(owner.totalRemaining)} strong />
              </div>
            </div>
          )) : (
            <div className="arkaEmpty">Nuk u lexuan pronarët ose nuk ka rreshta.</div>
          )}
        </div>
        <ReadError label="Owner accounts" error={state.errors.owners} />
        <ReadError label="Owner capital entries" error={state.errors.ownerEntries} />
      </section>

      <section className="arkaSectionCard">
        <div className="arkaSectionHeadCompact">
          <div>
            <div className="arkaSectionTitle">OBLIGIME / RROGA / BLOCKERS</div>
            <div className="arkaSectionSub">Preview për waterfall</div>
          </div>
        </div>
        <div className="arkaOwnerFormulaGrid compactStats">
          <MiniStat label="Obligime" value={money(computed.essentialObligations)} tone="warn" />
          <MiniStat label="Rroga neto" value={money(computed.payrollNet)} tone="warn" />
          <MiniStat label="Cash i hapur workers" value={money(computed.workerCash)} tone={computed.workerCash > 0 ? "warn" : "ok"} />
          <MiniStat label="Master cash" value={money(computed.masterCash)} tone={computed.masterCash > 0 ? "warn" : "ok"} />
          <MiniStat label="Në pritje dispatch" value={money(computed.pendingDispatch)} tone={computed.pendingDispatch > 0 ? "warn" : "ok"} />
        </div>
        <ReadError label="Obligime" error={state.errors.fixedExpenses} />
        <ReadError label="Payroll users" error={state.errors.users} />
        <ReadError label="Payroll payments" error={state.errors.monthPayments} />
        <ReadError label="Cash i hapur" error={state.errors.openPayments} />
        <ReadError label="Në pritje dispatch" error={state.errors.handoffs} />
      </section>

      <section className="arkaSectionCard ownerFormulaBox">
        <div className="arkaSectionHeadCompact">
          <div>
            <div className="arkaSectionTitle">WATERFALL</div>
            <div className="arkaSectionSub">Preview vetëm • nuk krijon shpërndarje</div>
          </div>
          <div className="arkaCashTotalPill">{computed.distributableProfit > 0 ? "KA PROFIT" : "NUK KA PROFIT"}</div>
        </div>

        <div style={styles.cleanBox}>
          <RowLine label="Cash në kompani" value={money(computed.companyCash)} strong />
          <RowLine label="- Rezervë" value={money(RESERVE_AMOUNT)} />
          <RowLine label="- Obligime" value={money(computed.essentialObligations)} />
          <RowLine label="- Rroga neto" value={money(computed.payrollNet)} />
          <RowLine label="- Cash i hapur" value={money(computed.openCashBlockers)} />
          <RowLine label="- Në pritje dispatch" value={money(computed.pendingDispatch)} />
          <RowLine
            label="= Profit i disponueshëm"
            value={money(computed.distributableProfit)}
            strong
            tone={computed.distributableProfit > 0 ? "ok" : "bad"}
          />
        </div>

        {computed.distributableProfit <= 0 ? (
          <div style={styles.blockedBox}>NUK KA PROFIT TË DISPONUESHËM</div>
        ) : (
          <div className="arkaOwnerFormulaGrid compactStats" style={{ marginTop: 12 }}>
            <MiniStat label="Kthim borxhi 30%" value={money(computed.ownerRepaymentPool)} tone="info" />
            <MiniStat label="Ndarje profiti 70%" value={money(computed.profitSplitPool)} tone="ok" />
            <MiniStat label="Arben 50%" value={money(computed.arbenProfit)} tone="strong" />
            <MiniStat label="Fitim 50%" value={money(computed.fitimProfit)} tone="strong" />
          </div>
        )}
      </section>

      <section className="arkaSectionCard">
        <div className="arkaSectionHeadCompact">
          <div>
            <div className="arkaSectionTitle">PARASHIKIM PROFITI</div>
            <div className="arkaSectionSub">Default: rezervë {money(RESERVE_AMOUNT)} • kthim borxhi {OWNER_REPAYMENT_PERCENT}% • ndarje profiti {PROFIT_SPLIT_PERCENT}%</div>
          </div>
        </div>
        <div style={styles.cleanBox}>
          <RowLine label="Kthim borxhi/investimi" value={`${OWNER_REPAYMENT_PERCENT}% • ${money(computed.ownerRepaymentPool)}`} />
          <RowLine label="Ndarje profiti 70%" value={`${PROFIT_SPLIT_PERCENT}% • ${money(computed.profitSplitPool)}`} />
          <RowLine label="Arben 50%" value={money(computed.arbenProfit)} />
          <RowLine label="Fitim 50%" value={money(computed.fitimProfit)} />
        </div>
      </section>

      <section className="arkaSectionCard">
        <div className="arkaSectionHeadCompact">
          <div>
            <div className="arkaSectionTitle">LËVIZJET E FUNDIT</div>
            <div className="arkaSectionSub">20 rreshtat e fundit nga company_budget_ledger</div>
          </div>
        </div>

        {state.ledger.length ? (
          <div className="arkaCashCompactList">
            {state.ledger.map((row) => (
              <div className="arkaCashCompactRow mini" key={row.id || `${row.created_at}_${row.amount}_${row.category}`}>
                <div className="arkaCashCompactSummary" style={{ cursor: "default" }}>
                  <span className="arkaCashCode">{upper(row.direction) || "—"}</span>
                  <span className="arkaCashNameWrap">
                    <span className="arkaCashName">{budgetCategoryLabel(row.category)}</span>
                    <span className="arkaCashStamp">{fmtDateTime(row.created_at)} • {sourceLabel(row)}</span>
                  </span>
                  <span className="arkaCashAmount">{money(row.amount)}</span>
                </div>
                <div className="arkaCashCompactDetails">
                  <span>{ledgerDescription(row)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="arkaEmpty">Nuk ka lëvizje të lexuara.</div>
        )}
        <ReadError label="Company budget ledger" error={state.errors.ledger} />
      </section>

      {actionMode ? (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard}>
            <div className="arkaSectionHeadCompact">
              <div>
                <div className="arkaSectionTitle">{actionTitle(actionMode)}</div>
                <div className="arkaSectionSub">Veprimi kalon vetëm përmes RPC të audituar.</div>
              </div>
              <button className="arkaTopBtn" type="button" onClick={closeBudgetAction} disabled={submitting}>MBYLL</button>
            </div>

            <div style={styles.formGrid}>
              {actionMode === "ALIGN_BALANCE" ? (
                <label style={styles.fieldLabel}>
                  <span>SHUMA REALE E NUMËRUAR</span>
                  <input
                    style={styles.input}
                    inputMode="decimal"
                    value={form.targetBalance}
                    onChange={(e) => updateForm("targetBalance", e.target.value)}
                    placeholder="0.00"
                  />
                </label>
              ) : (
                <label style={styles.fieldLabel}>
                  <span>SHUMA</span>
                  <input
                    style={styles.input}
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(e) => updateForm("amount", e.target.value)}
                    placeholder="0.00"
                  />
                </label>
              )}

              <label style={styles.fieldLabel}>
                <span>ARSYE</span>
                <input
                  style={styles.input}
                  value={form.reason}
                  onChange={(e) => updateForm("reason", e.target.value)}
                  placeholder="Shkruaj arsyen e rregullimit"
                />
              </label>

              <label style={styles.fieldLabel}>
                <span>SHËNIM</span>
                <textarea
                  style={{ ...styles.input, minHeight: 72, resize: "vertical" }}
                  value={form.note}
                  onChange={(e) => updateForm("note", e.target.value)}
                  placeholder="Opsionale"
                />
              </label>
            </div>

            <div style={styles.cleanBox}>
              {actionMode === "ADD_BUDGET" ? (
                <>
                  <RowLine label="Buxheti aktual" value={money(computed.companyCash)} />
                  <RowLine label="Shtohet" value={money(formAmount)} />
                  <RowLine label="Buxheti pas ndryshimit" value={money(previewAfter)} strong tone="ok" />
                </>
              ) : null}
              {actionMode === "REMOVE_BUDGET" ? (
                <>
                  <RowLine label="Buxheti aktual" value={money(computed.companyCash)} />
                  <RowLine label="Hiqet" value={money(formAmount)} />
                  <RowLine label="Buxheti pas ndryshimit" value={money(previewAfter)} strong tone={previewAfter < 0 ? "bad" : "ok"} />
                </>
              ) : null}
              {actionMode === "ALIGN_BALANCE" ? (
                <>
                  <RowLine label="Buxheti në sistem" value={money(computed.companyCash)} />
                  <RowLine label="Cash real i numëruar" value={money(formTargetBalance)} />
                  <RowLine label="Diferenca" value={signedMoney(previewDelta)} tone={previewDelta >= 0 ? "ok" : "bad"} />
                  <RowLine label="Buxheti pas align" value={money(previewAfter)} strong />
                </>
              ) : null}
            </div>

            {actionError ? <div style={styles.errorBox}>{actionError}</div> : null}

            <button
              className="arkaPrimaryBtn"
              type="button"
              onClick={confirmBudgetAction}
              disabled={submitting}
              style={{ width: "100%", marginTop: 14 }}
            >
              {submitting ? "DUKE KONFIRMUAR..." : actionMode === "ADD_BUDGET" ? "KONFIRMO SHTIMIN" : actionMode === "REMOVE_BUDGET" ? "KONFIRMO HEQJEN" : "KONFIRMO ALIGN"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const styles = {
  cleanBox: {
    display: "grid",
    gap: 8,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.08)",
    background: "rgba(0,0,0,.24)",
  },
  rowLine: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minHeight: 32,
    borderBottom: "1px solid rgba(255,255,255,.06)",
  },
  rowLabel: {
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: ".13em",
    textTransform: "uppercase",
    color: "rgba(229,231,235,.62)",
  },
  rowValue: {
    fontSize: 13,
    fontWeight: 1000,
    color: "#fff",
    whiteSpace: "nowrap",
  },
  rowValueStrong: {
    fontSize: 16,
    color: "#dcfce7",
  },
  okText: {
    color: "#86efac",
  },
  badText: {
    color: "#fca5a5",
  },
  actionBtnWrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "flex-end",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    background: "rgba(0,0,0,.72)",
    backdropFilter: "blur(8px)",
  },
  modalCard: {
    width: "min(620px, 100%)",
    maxHeight: "92vh",
    overflow: "auto",
    borderRadius: 22,
    border: "1px solid rgba(255,255,255,.14)",
    background: "#07111f",
    boxShadow: "0 24px 80px rgba(0,0,0,.55)",
    padding: 16,
  },
  formGrid: {
    display: "grid",
    gap: 12,
    margin: "14px 0",
  },
  fieldLabel: {
    display: "grid",
    gap: 6,
    color: "rgba(229,231,235,.72)",
    fontSize: 10,
    fontWeight: 1000,
    letterSpacing: ".13em",
    textTransform: "uppercase",
  },
  input: {
    width: "100%",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.28)",
    color: "#fff",
    padding: "12px 13px",
    fontSize: 15,
    fontWeight: 800,
    outline: "none",
  },
  successBox: {
    marginTop: 10,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(34,197,94,.28)",
    background: "rgba(34,197,94,.10)",
    color: "#bbf7d0",
    fontSize: 11,
    fontWeight: 1000,
    letterSpacing: ".1em",
    textTransform: "uppercase",
  },
  blockedBox: {
    marginTop: 12,
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(245,158,11,.32)",
    background: "rgba(245,158,11,.12)",
    color: "#fde68a",
    fontSize: 11,
    fontWeight: 1000,
    letterSpacing: ".14em",
    textTransform: "uppercase",
  },
  errorBox: {
    marginTop: 10,
    padding: "9px 10px",
    borderRadius: 12,
    border: "1px solid rgba(245,158,11,.25)",
    background: "rgba(245,158,11,.08)",
    color: "#fde68a",
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: ".08em",
    textTransform: "uppercase",
  },
};

export default KapakuPage;
