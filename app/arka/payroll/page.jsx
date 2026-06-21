"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { useRouter } from "@/lib/routerCompat.jsx";
import { supabase } from "@/lib/supabaseClient";
import { listPendingPaymentRecords } from "@/lib/arkaService";
import { ARKA_ACTION, ARKA_SOURCE_MODULE } from "@/lib/arka/arkaConstants";
import { arkaTransaction, buildArkaIdempotencyKey } from "@/lib/arka/arkaClient";
import { deleteUserRecord, listUserRecords, updateUserRecord } from "@/lib/usersService";
import { buildMonthlyPayrollPreview, getCurrentPayrollMonth, getMonthWindow, isPayrollEligibleWorker } from "@/lib/payrollMonthClose";

function jparse(s, fallback) {
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
}
function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }
function parseAmountInput(v) {
  const raw = String(v ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
function euro(n) {
  return `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;
}
function normalizeDbError(errLike) {
  const msg = String(errLike?.message || errLike?.details || errLike?.hint || errLike || "");
  const low = msg.toLowerCase();

  if (low.includes("duplicate key") && low.includes("pin")) {
    return "⚠️ Ky PIN po përdoret nga një anëtar tjetër i stafit. Zgjidhni një PIN unik.";
  }
  if (low.includes("schema cache") || low.includes("could not find")) {
    return "⏳ Sistemi po përditësohet. Prisni pak dhe provoni përsëri.";
  }
  return msg || "Ndodhi një gabim i panjohur.";
}
function paydayDue(day) {
  const d = Number(day || 0);
  if (!d) return false;
  return new Date().getDate() >= d;
}
function formatDateTime(s) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("sq-AL", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}
function formatPaidDateTime(s) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleString("sq-AL", {
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
function formatBelgradeDateTime(s) {
  if (!s) return "—";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Belgrade",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(s)).reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
    return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
  } catch {
    return "—";
  }
}
function textValue(...values) {
  for (const value of values) {
    const s = String(value ?? "").trim();
    if (s) return s;
  }
  return "";
}
function adminCashDisplayCode(row) {
  const code = textValue(row?.code, row?.order_code, row?.transport_code_str, row?.client_code);
  const status = String(row?.status || "").toUpperCase();
  const source = String(row?.source_module || row?.source || row?.order_source || row?.module || row?.origin || row?.order_type || "").toUpperCase();
  const isTransport = source.includes("TRANSPORT") || Boolean(row?.transport_id || row?.transport_order_id) || String(code || "").toUpperCase().startsWith("T");
  if (!code && isTransport && status === "COLLECTED") return "TRANSPORT COLLECTED PA KOD";
  return code || "—";
}
function adminCashClientName(row) {
  return textValue(row?.client_name, row?.customer_name, row?.name, row?.created_for_name, row?.data?.client_name, row?.data?.name) || "—";
}
function adminCashSourceModule(row) {
  return textValue(row?.source_module, row?.source, row?.order_source, row?.module, row?.origin, row?.order_type) || "—";
}
function adminCashNote(row) {
  return textValue(row?.note, row?.description, row?.data?.note, row?.data?.comment) || "—";
}
function adminCashBreakdownLabel(row) {
  const status = String(row?.status || "").toUpperCase();
  const code = textValue(row?.code, row?.order_code, row?.transport_code_str, row?.client_code);
  const source = adminCashSourceModule(row).toUpperCase();
  const isTransport = source.includes("TRANSPORT") || Boolean(row?.transport_id || row?.transport_order_id) || String(code || "").toUpperCase().startsWith("T");
  if (isTransport && status === "COLLECTED" && !code) return "TRANSPORT COLLECTED PA KOD";
  if (isTransport) return `TRANSPORT ${status || "OPEN"}`;
  return `BASE ${status || "OPEN"}`;
}
function workerCashDisplayCode(row) {
  const source = String(row?.source_module || "").toUpperCase();
  const fallbackId = textValue(row?.payment_id, row?.id);
  if (source === "TRANSPORT") return textValue(row?.transport_code_str) || fallbackId || "—";
  const orderCode = textValue(row?.order_code, row?.code, row?.client_code);
  if (orderCode) return String(orderCode).startsWith("#") ? String(orderCode) : `#${orderCode}`;
  return fallbackId || "—";
}
function workerCashIsTransport(row) {
  const source = String(row?.source_module || "").toUpperCase();
  return source === "TRANSPORT" || Boolean(row?.transport_code_str);
}
function extractM2FromPayment(row) {
  const direct = Number(row?.transport_m2 || row?.data?.transport_m2 || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const note = String(row?.note || row?.data?.note || "");
  const matches = Array.from(note.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*(?:m²|m2|m\^2)/gi));
  const raw = matches.length ? matches[matches.length - 1]?.[1] : "";
  if (!raw) return 0;

  const value = Number(String(raw).replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function buildHybridCashDisplayRow(row, commissionRateM2) {
  const amount = Number(row?.amount || 0);
  const m2 = workerCashIsTransport(row) ? extractM2FromPayment(row) : 0;
  const commissionKept = Math.max(0, m2 * Number(commissionRateM2 || 0));
  const baseHandover = amount - commissionKept;
  return {
    row,
    amount,
    m2,
    commissionKept,
    baseHandover,
  };
}

const ADMIN_CASH_TEST_RE = /test/i;
const ADMIN_CASH_SUSPICIOUS_RE = /(offline|ofline|xxxx|asd|final)/i;
const ADMIN_CASH_CLASS_FILTERS = [
  { key: 'ALL', label: 'TË GJITHA' },
  { key: 'REAL_CANDIDATE', label: 'REAL CANDIDATE' },
  { key: 'TEST', label: 'TEST' },
  { key: 'SUSPICIOUS', label: 'SUSPICIOUS' },
  { key: 'EXCLUDED', label: 'EXCLUDED' },
];
function adminCashSearchText(row) {
  return `${adminCashClientName(row)} ${adminCashNote(row)}`;
}
function classifyAdminCashPayment(row) {
  const text = adminCashSearchText(row);
  if (row?.active_exclusion) return { key: 'EXCLUDED', label: 'EXCLUDED', tone: 'excluded' };
  if (ADMIN_CASH_TEST_RE.test(text)) return { key: 'TEST', label: 'TEST CANDIDATE', tone: 'test' };
  if (ADMIN_CASH_SUSPICIOUS_RE.test(text)) return { key: 'SUSPICIOUS', label: 'SUSPICIOUS', tone: 'suspicious' };
  return { key: 'REAL_CANDIDATE', label: 'REAL CANDIDATE', tone: 'real' };
}
function buildAdminCashClassSummary(rows) {
  const summary = {
    REAL_CANDIDATE: { key: 'REAL_CANDIDATE', label: 'real candidate total', total: 0, count: 0 },
    TEST: { key: 'TEST', label: 'test candidate total', total: 0, count: 0 },
    SUSPICIOUS: { key: 'SUSPICIOUS', label: 'suspicious total', total: 0, count: 0 },
    EXCLUDED: { key: 'EXCLUDED', label: 'excluded total', total: 0, count: 0 },
  };
  (rows || []).forEach((row) => {
    const cls = classifyAdminCashPayment(row);
    const bucket = summary[cls.key];
    if (!bucket) return;
    bucket.total += Number(row?.amount || 0);
    bucket.count += 1;
  });
  return summary;
}
function badgeFromHistory(row) {
  const status = String(row?.status || "").toUpperCase();
  const type = String(row?.type || "").toUpperCase();

  if (status === "ADVANCE") return { label: "AVANS", tone: "orange" };
  if (status === "WORKER_DEBT" || status === "OWED" || status === "REJECTED") return { label: "BORXH", tone: "red" };
  if (status === "CLEARED_PAID") return { label: "RROGË / SHLYER", tone: "green" };
  if (type === "IN") return { label: "DORËZIM", tone: "blue" };
  return { label: status || type || "VEPRIM", tone: "slate" };
}

const AUTH_REPAIR_WAIT_MS = 1800;
const DB_TIMEOUT_MS = 3500;
const MONTH_CLOSE_EXCLUDED_CASH_TYPES = new Set(['EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED', 'ADVANCE', 'SALARY_PAYMENT']);
const MONTH_CLOSE_EXPENSE_TYPES = new Set(['EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED']);

function isMonthlyExpenseRow(row) {
  const type = String(row?.type || '').toUpperCase();
  const status = String(row?.status || '').toUpperCase();
  if (status !== 'ACCEPTED_BY_DISPATCH') return false;
  return MONTH_CLOSE_EXPENSE_TYPES.has(type);
}

function withTimeout(promise, ms = DB_TIMEOUT_MS, label = 'db_timeout') {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(label);
        err.code = 'TEPIHA_TIMEOUT';
        reject(err);
      }, ms);
    }),
  ]).finally(() => {
    try { if (timer) clearTimeout(timer); } catch {}
  });
}


function AccessDeniedPanel() {
  return (
    <div style={{ minHeight: '100vh', background: '#05070d', color: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18, fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' }}>
      <div style={{ width: 'min(520px, 100%)', border: '1px solid rgba(239,68,68,.35)', background: 'linear-gradient(180deg,#111827,#070b12)', borderRadius: 22, padding: 18, boxShadow: '0 22px 70px rgba(0,0,0,.55)' }}>
        <div style={{ fontSize: 12, letterSpacing: '.14em', color: '#fca5a5', fontWeight: 1000, marginBottom: 8 }}>ARKA</div>
        <div style={{ fontSize: 24, lineHeight: 1.1, fontWeight: 1000 }}>Nuk ke qasje në këtë faqe</div>
        <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.45, color: '#cbd5e1' }}>Kjo faqe kërkon autorizim. Zgjidh një faqe tjetër poshtë.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
          <Link prefetch={false} href="/" style={{ textAlign: 'center', textDecoration: 'none', borderRadius: 14, background: '#2563eb', color: '#fff', padding: 13, fontSize: 14, fontWeight: 1000 }}>HOME</Link>
          <Link prefetch={false} href="/arka" style={{ textAlign: 'center', textDecoration: 'none', borderRadius: 14, background: '#334155', color: '#fff', padding: 13, fontSize: 14, fontWeight: 1000 }}>ARKA</Link>
        </div>
      </div>
    </div>
  );
}

export default function PayrollPage() {
  const router = useRouter();
  const [actor, setActor] = useState(null);
  const [masterPin, setMasterPin] = useState("");
  const [staff, setStaff] = useState([]);
  const [debtsMap, setDebtsMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [advanceModal, setAdvanceModal] = useState(null);
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceNote, setAdvanceNote] = useState("");
  const [advanceBusy, setAdvanceBusy] = useState(false);

  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({
    salary: "",
    salary_day: "",
    avans_manual: "",
    borxh_afatgjat: "",
  });

  const [salaryModal, setSalaryModal] = useState(null);
  const [deductAutoAdvance, setDeductAutoAdvance] = useState(true);
  const [deductManualAdvance, setDeductManualAdvance] = useState(true);
  const [deductLongTermAmount, setDeductLongTermAmount] = useState("");
  const [workerHistory, setWorkerHistory] = useState([]);
  const [payrollMonth, setPayrollMonth] = useState(() => getCurrentPayrollMonth());
  const [payrollMonthRows, setPayrollMonthRows] = useState([]);
  const [payrollMonthLoading, setPayrollMonthLoading] = useState(false);
  const [payrollMonthError, setPayrollMonthError] = useState("");
  const [monthCloseSummary, setMonthCloseSummary] = useState(null);
  const [monthCloseError, setMonthCloseError] = useState("");
  const [closedMonthSnapshot, setClosedMonthSnapshot] = useState(null);
  const [closedMonthItems, setClosedMonthItems] = useState([]);
  const [selectedPayrollRow, setSelectedPayrollRow] = useState(null);
  const [showAdminCashDetails, setShowAdminCashDetails] = useState(false);
  const [adminCashClassFilter, setAdminCashClassFilter] = useState('ALL');
  const [adminCashMarkingId, setAdminCashMarkingId] = useState(null);
  const [adminCashMarkMessage, setAdminCashMarkMessage] = useState("");

  const normalizedRole = String(actor?.role || '').toUpperCase();
  const isAdminUser = ['ADMIN', 'ADMIN_MASTER', 'DISPATCH', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(normalizedRole);

  useEffect(() => {
    let cancelled = false;

    const boot = () => {
      const a = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
      if (!a) return false;

      setActor(a);
      try { localStorage.removeItem("MASTER_ADMIN_PIN"); } catch {}

      const role = String(a?.role || '').toUpperCase();
      if (!["ADMIN", "ADMIN_MASTER", "DISPATCH", "OWNER", "PRONAR", "SUPERADMIN"].includes(role)) {
        router.push('/arka');
        return true;
      }

      void reloadAll(false);
      return true;
    };

    if (boot()) return undefined;

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (boot()) return;
      router.push("/login");
    }, AUTH_REPAIR_WAIT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [router]);

  useEffect(() => {
    if (!actor || !isAdminUser) return;
    void reloadMonthlyPayrollPreview(payrollMonth);
  }, [actor?.pin, isAdminUser, payrollMonth]);

  async function reloadAll(isSilent = false) {
    if (!isSilent) setLoading(true);
    try {
      const st = await withTimeout(listUserRecords({ orderBy: "name", ascending: true, eq: { is_active: true } }), DB_TIMEOUT_MS, 'arka_payroll_users_timeout');
      setStaff((st || []).filter((u) => u?.is_active !== false));

      const rawDebts = await withTimeout(listPendingPaymentRecords({
        select: "amount, created_by_name",
        in: { status: ["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"] },
      }), DB_TIMEOUT_MS, 'arka_payroll_debts_timeout');

      const dMap = {};
      (rawDebts || []).forEach((d) => {
        const amt = Number(d.amount || 0);
        const name = String(d.created_by_name || "").trim().toUpperCase();
        if (!name) return;
        dMap[name] = (dMap[name] || 0) + amt;
      });
      setDebtsMap(dMap);
    } catch (err) {
      if (!isSilent) {
        console.warn('PATCH M V25: ARKA/PAYROLL DB timeout/failure; fail-open instead of stuck loader.', err);
      }
    } finally {
      if (!isSilent) setLoading(false);
    }
  }

  async function reloadMonthlyPayrollPreview(monthValue = payrollMonth) {
    const month = String(monthValue || getCurrentPayrollMonth()).slice(0, 7);
    const { startIso, endIso } = getMonthWindow(month);

    setPayrollMonthLoading(true);
    setPayrollMonthError("");
    try {
      setMonthCloseError("");

      const closedRes = await supabase
        .from("payroll_month_closes")
        .select("*")
        .eq("month_key", month)
        .eq("status", "CLOSED")
        .is("cancelled_at", null)
        .order("closed_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (closedRes?.error) throw closedRes.error;

      if (closedRes?.data?.id) {
        const itemsRes = await supabase
          .from("payroll_month_close_items")
          .select("*")
          .eq("close_id", closedRes.data.id)
          .order("worker_name", { ascending: true });

        if (itemsRes?.error) throw itemsRes.error;

        setClosedMonthSnapshot(closedRes.data);
        setClosedMonthItems(Array.isArray(itemsRes?.data) ? itemsRes.data : []);
        setPayrollMonthRows([]);
        setMonthCloseSummary(null);
        setMonthCloseError("");
        return;
      }

      setClosedMonthSnapshot(null);
      setClosedMonthItems([]);

      const [monthRes, paidRes, budgetRes, fixedRes, adminCashRes, exclusionRes] = await Promise.all([
        supabase
          .from("arka_pending_payments")
          .select("*")
          .gte("created_at", startIso)
          .lt("created_at", endIso)
          .order("created_at", { ascending: false })
          .limit(3000),

        supabase
          .from("arka_pending_payments")
          .select("*")
          .eq("status", "SALARY_PAID")
          .ilike("note", `%RROGA ${month}%`)
          .order("created_at", { ascending: false })
          .limit(500),

        supabase
          .from("company_budget_summary")
          .select("current_balance,total_in,total_out")
          .eq("id", 1)
          .maybeSingle(),

        supabase
          .from("company_fixed_expenses")
          .select("id,title,amount,due_day,essential,active")
          .eq("active", true)
          .order("due_day", { ascending: true })
          .limit(500),

        supabase
          .from("arka_pending_payments")
          .select("*")
          .eq("created_by_pin", "2380")
          .in("status", ["PENDING", "COLLECTED"])
          .order("created_at", { ascending: false })
          .limit(2000),

        supabase
          .from("arka_payment_exclusions")
          .select("payment_id, reason_type, reason_note, created_at, created_by_name")
          .is("cancelled_at", null)
          .limit(5000),
      ]);

      if (monthRes.error) throw monthRes.error;
      if (paidRes.error) throw paidRes.error;

      const map = new Map();
      [...(Array.isArray(monthRes.data) ? monthRes.data : []), ...(Array.isArray(paidRes.data) ? paidRes.data : [])].forEach((row) => {
        const key = String(row?.id || `${row?.status}_${row?.amount}_${row?.created_at}_${Math.random()}`);
        map.set(key, row);
      });

      const rows = [...map.values()];
      const activeExclusions = new Map();
      if (!exclusionRes?.error && Array.isArray(exclusionRes?.data)) {
        exclusionRes.data.forEach((row) => {
          const paymentId = String(row?.payment_id || '').trim();
          if (paymentId) activeExclusions.set(paymentId, row);
        });
      }
      const payrollRows = rows.map((row) => ({
        ...row,
        active_exclusion: activeExclusions.get(String(row?.id || '').trim()) || null,
      }));
      const adminCashRows = (adminCashRes?.error ? [] : (Array.isArray(adminCashRes?.data) ? adminCashRes.data : []))
        .filter((row) => !MONTH_CLOSE_EXCLUDED_CASH_TYPES.has(String(row?.type || '').toUpperCase()))
        .map((row) => ({
          ...row,
          active_exclusion: activeExclusions.get(String(row?.id || '').trim()) || null,
        }));
      const adminCashClassSummary = buildAdminCashClassSummary(adminCashRows);
      const adminCashBlockingRows = adminCashRows.filter((row) => !row?.active_exclusion);
      const adminCashOpenTotal = adminCashBlockingRows.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
      const adminCashOpenCount = adminCashBlockingRows.length;
      const adminBreakdownMap = new Map();
      adminCashBlockingRows.forEach((row) => {
        const label = adminCashBreakdownLabel(row);
        const current = adminBreakdownMap.get(label) || { label, total: 0, count: 0 };
        current.total += Number(row?.amount || 0);
        current.count += 1;
        adminBreakdownMap.set(label, current);
      });
      const adminCashOpenBreakdown = [...adminBreakdownMap.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));

      setPayrollMonthRows(payrollRows);
      setMonthCloseSummary({
        companyCash: Number(budgetRes?.data?.current_balance || 0),
        budgetError: budgetRes?.error ? normalizeDbError(budgetRes.error) : "",
        fixedExpenses: fixedRes?.error ? [] : (Array.isArray(fixedRes?.data) ? fixedRes.data : []),
        fixedExpensesError: fixedRes?.error ? normalizeDbError(fixedRes.error) : "",
        adminCashOpenTotal,
        adminCashOpenCount,
        adminCashOpenBreakdown,
        adminCashOpenRows: adminCashRows,
        adminCashClassSummary,
        adminCashOpenError: adminCashRes?.error ? normalizeDbError(adminCashRes.error) : "",
        adminCashExclusionsError: exclusionRes?.error ? normalizeDbError(exclusionRes.error) : "",
      });
      if (budgetRes?.error || fixedRes?.error || adminCashRes?.error || exclusionRes?.error) {
        setMonthCloseError([
          budgetRes?.error ? `Buxheti: ${normalizeDbError(budgetRes.error)}` : '',
          fixedRes?.error ? `Obligimet: ${normalizeDbError(fixedRes.error)}` : '',
          adminCashRes?.error ? `Admin/master cash: ${normalizeDbError(adminCashRes.error)}` : '',
          exclusionRes?.error ? `Exclusions: ${normalizeDbError(exclusionRes.error)}` : '',
        ].filter(Boolean).join(' • '));
      }
    } catch (err) {
      console.warn("PRO PAYROLL PREVIEW LOAD ERROR", err);
      setPayrollMonthRows([]);
      setClosedMonthSnapshot(null);
      setClosedMonthItems([]);
      setPayrollMonthError(normalizeDbError(err));
    } finally {
      setPayrollMonthLoading(false);
    }
  }

  async function markAdminCashPaymentAsTestVoid(payment) {
    if (!payment?.id || adminCashMarkingId) return;

    const ok = window.confirm("Kjo pagesë nuk do të llogaritet për payroll/MASTER cash. Pagesa origjinale nuk fshihet. Vazhdo?");
    if (!ok) return;

    setAdminCashMarkMessage("");
    setAdminCashMarkingId(payment.id);
    try {
      const insertRow = {
        payment_id: payment.id,
        reason_type: 'TEST',
        reason_note: 'Marked from MASTER CASH cleanup',
        amount_snapshot: Number(payment?.amount || 0),
        client_name_snapshot: payment?.client_name || null,
        order_code_snapshot: payment?.order_code || payment?.code || null,
        transport_code_snapshot: payment?.transport_code_str || null,
        status_snapshot: payment?.status || null,
        type_snapshot: payment?.type || null,
        source_module_snapshot: payment?.source_module || null,
        created_by_pin: String(actor?.pin || masterPin || '2380'),
        created_by_name: String(actor?.name || actor?.full_name || actor?.display_name || 'MASTER USER'),
        created_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('arka_payment_exclusions')
        .insert(insertRow);

      if (error) {
        const low = String(error?.message || error?.details || error?.code || '').toLowerCase();
        if (error?.code === '23505' || low.includes('duplicate key') || low.includes('unique')) {
          setAdminCashMarkMessage('Kjo pagesë është përjashtuar më herët.');
          await reloadMonthlyPayrollPreview(payrollMonth);
          return;
        }
        throw error;
      }

      setAdminCashMarkMessage('Pagesa u markua si TEST / VOID.');
      await reloadMonthlyPayrollPreview(payrollMonth);
    } catch (err) {
      console.warn('ADMIN CASH TEST/VOID MARK ERROR', err);
      setAdminCashMarkMessage(normalizeDbError(err));
    } finally {
      setAdminCashMarkingId(null);
    }
  }

  function startFinanceEdit(u) {
    setEditingId(u.id);
    setEditForm({
      salary: String(u.salary ?? ""),
      salary_day: String(u.salary_day ?? ""),
      avans_manual: String(u.avans_manual ?? ""),
      borxh_afatgjat: String(u.borxh_afatgjat ?? ""),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveFinanceEdit() {
    if (!editingId) return;
    setActionBusy(true);

    const dayRaw = Number(editForm.salary_day || 0);
    const payload = {
      salary: Number(editForm.salary || 0),
      salary_day: dayRaw >= 1 && dayRaw <= 31 ? dayRaw : null,
      avans_manual: Number(editForm.avans_manual || 0),
      borxh_afatgjat: Number(editForm.borxh_afatgjat || 0),
    };

    try {
      await updateUserRecord(editingId, payload);
      setEditingId(null);
      await reloadAll(false);
    } catch (err) {
      alert("GABIM: " + normalizeDbError(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function fetchWorkerHistory(workerName) {
    if (!workerName) return setWorkerHistory([]);
    try {
      const data = await listPendingPaymentRecords({
        eq: { created_by_name: workerName },
        orderBy: "created_at",
        ascending: false,
        limit: 30,
      });
      setWorkerHistory(data || []);
    } catch (err) {
      console.error("History error:", err);
      setWorkerHistory([]);
    }
  }

  function openSalaryModal(u) {
    const workerName = String(u.name || "").trim().toUpperCase();
    const baseSalary = Number(u.salary || 0);
    const autoDebt = Number(debtsMap[workerName] || 0);
    const manualAdvance = Number(u.avans_manual || 0);
    const longTermDebt = Number(u.borxh_afatgjat || 0);

    setSalaryModal({
      ...u,
      baseSalary,
      autoDebt,
      manualAdvance,
      totalAdvance: autoDebt + manualAdvance,
      longTermDebt,
    });
    setDeductAutoAdvance(true);
    setDeductManualAdvance(true);
    setDeductLongTermAmount("");
    fetchWorkerHistory(u.name || "");
  }

  function openAdvanceModal(u) {
    setAdvanceModal(u);
    setAdvanceAmount("");
    setAdvanceNote("");
    fetchWorkerHistory(u.name || "");
  }

  async function handleAddAdvance() {
    if (!advanceModal || !masterPin) {
      alert("Kërkohet Master PIN për këtë veprim.");
      return;
    }
    const amt = parseAmountInput(advanceAmount);
    if (!(amt > 0)) {
      alert("Shkruaj shumën e avansit.");
      return;
    }
    const conf = confirm(`A dëshironi të regjistroni avans ${euro(amt)} për ${advanceModal?.name || 'punëtorin'}?`);
    if (!conf) return;

    setAdvanceBusy(true);
    try {
      await arkaTransaction({
        action: ARKA_ACTION.EXPENSE_REQUEST,
        actorPin: actor?.pin || advanceModal?.pin || null,
        actorName: actor?.name || null,
        actorRole: actor?.role || null,
        workerPin: advanceModal?.pin || null,
        workerName: advanceModal?.name || null,
        paymentType: 'ADVANCE',
        sourceModule: ARKA_SOURCE_MODULE.ARKA,
        status: 'ADVANCE',
        amount: amt,
        note: String(advanceNote || 'AVANS').trim() || 'AVANS',
        idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.EXPENSE_REQUEST, [advanceModal?.pin || '', 'ADVANCE', amt]),
      });
      alert(`✅ Avansi ${euro(amt)} u regjistrua për ${advanceModal?.name || 'punëtorin'}.`);
      setAdvanceModal(null);
      setAdvanceAmount("");
      setAdvanceNote("");
      await reloadAll(false);
    } catch (err) {
      alert('GABIM: ' + normalizeDbError(err));
    } finally {
      setAdvanceBusy(false);
    }
  }

  const payableAmount = useMemo(() => {
    if (!salaryModal) return 0;
    const baseSalary = Number(salaryModal.baseSalary || 0);
    const personalAdvance = Number(salaryModal.autoDebt || 0) + Number(salaryModal.manualAdvance || 0);
    return Math.max(0, baseSalary - personalAdvance);
  }, [salaryModal]);

  async function handlePaySalary() {
    if (!salaryModal || !masterPin) {
      alert("Kërkohet Master PIN për pagesën e rrogës.");
      return;
    }
    if (actionBusy) return;

    const workerPin = String(salaryModal?.pin || '').trim();
    const workerName = String(salaryModal?.name || '').trim();
    const baseSalary = Number(salaryModal?.baseSalary || 0);
    const autoAdvanceAmount = Number(salaryModal?.autoDebt || 0);
    const manualAdvanceAmount = Number(salaryModal?.manualAdvance || 0);
    const advanceAmount = autoAdvanceAmount + manualAdvanceAmount;
    const netAmount = Number(payableAmount || 0);

    if (!workerPin) {
      alert("Mungon PIN-i i punëtorit.");
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(String(payrollMonth || ''))) {
      alert("Muaji i payroll nuk është valid.");
      return;
    }

    const conf = confirm(
      `Konfirmo pagesën e rrogës për ${workerName || workerPin}:\n\n` +
      `Muaji: ${payrollMonth}\n` +
      `Rroga bazë: ${euro(baseSalary)}\n` +
      `Avans që zbritet: ${euro(advanceAmount)}\n` +
      `Neto për pagesë: ${euro(netAmount)}\n\n` +
      `Sistemi do ta zbresë buxhetin, do krijojë ledger OUT dhe marker SALARY_PAYMENT/SALARY_PAID.`
    );
    if (!conf) return;

    setActionBusy(true);
    try {
      const res = await arkaTransaction({
        action: ARKA_ACTION.PAYROLL_SALARY_PAYMENT,
        actorPin: String(masterPin || '').trim(),
        actorName: actor?.name || 'MASTER USER',
        actorRole: actor?.role || 'ADMIN',
        workerId: salaryModal?.id || null,
        workerPin,
        workerName,
        monthKey: payrollMonth,
        amount: netAmount,
        baseSalary,
        advanceAmount,
        autoAdvanceAmount,
        manualAdvanceAmount,
        idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.PAYROLL_SALARY_PAYMENT, [payrollMonth, workerPin]),
      });
      if (!res?.ok) throw new Error(res?.error || 'SALARY_PAYMENT_FAILED');

      alert(res?.duplicate
        ? `✅ Rroga për ${workerName || workerPin} ishte e regjistruar më herët për ${payrollMonth}. Nuk u krijua pagesë e dytë.`
        : `✅ Rroga u pagua për ${workerName || workerPin}. Neto: ${euro(netAmount)}.`
      );
      setSalaryModal(null);
      await reloadAll(true);
      await reloadMonthlyPayrollPreview(payrollMonth);
    } catch (err) {
      alert('GABIM: ' + normalizeDbError(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleMoveAdvancesToLongTerm() {
    if (!salaryModal || !masterPin) {
      alert("Kërkohet Master PIN për këtë veprim.");
      return;
    }
    const totalToMove = Number(salaryModal.autoDebt || 0) + Number(salaryModal.manualAdvance || 0);
    if (totalToMove <= 0) {
      alert("Ky punëtor nuk ka avanse për t'i kaluar në borxh afatgjatë.");
      return;
    }

    const conf = confirm(
      `A dëshironi t'i kaloni avanset (${euro(totalToMove)}) në borxh afatgjatë për ${salaryModal.name}?`
    );
    if (!conf) return;

    setActionBusy(true);
    try {
      const nowIso = new Date().toISOString();
      const workerPin = String(salaryModal?.pin || '').trim();
      const workerName = String(salaryModal?.name || '').trim();
      const clearStatuses = ["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"];
      const targetMap = new Map();

      const collectRows = async (field, value) => {
        if (!value) return;
        const { data, error } = await supabase
          .from("arka_pending_payments")
          .select("id,amount,status,type,created_by_pin,created_by_name,note")
          .in("status", clearStatuses)
          .eq(field, value)
          .limit(500);
        if (error) throw error;
        for (const row of Array.isArray(data) ? data : []) {
          if (row?.id) targetMap.set(String(row.id), row);
        }
      };

      await collectRows("created_by_pin", workerPin);
      await collectRows("created_by_name", workerName);

      for (const row of targetMap.values()) {
        const res = await arkaTransaction({
          action: ARKA_ACTION.VOID_OR_REVERSE_PAYMENT,
          actorPin: String(masterPin || workerPin || 'MASTER'),
          actorName: `Payroll ${String(workerName || workerPin || '').trim()}`.trim(),
          paymentId: row.id,
          note: `MOVE_ADVANCE_TO_LONG_TERM • ${workerName || workerPin}`,
          idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.VOID_OR_REVERSE_PAYMENT, [row.id, workerPin || workerName || 'worker']),
        });
        if (!res?.ok) throw new Error(res?.error || 'ARKA_ADVANCE_CLEAR_FAILED');
      }

      const nextLongTerm = Number(salaryModal.longTermDebt || 0) + totalToMove;
      const { error: err2 } = await supabase
        .from("users")
        .update({
          avans_manual: 0,
          borxh_afatgjat: nextLongTerm,
        })
        .eq("id", salaryModal.id);
      if (err2) throw err2;

      alert(`✅ Avanset u kaluan në borxh afatgjatë për ${salaryModal.name}.`);
      setSalaryModal(null);
      await reloadAll(false);
      await reloadMonthlyPayrollPreview(payrollMonth);
    } catch (e) {
      alert("GABIM: " + normalizeDbError(e));
    } finally {
      setActionBusy(false);
    }
  }


  async function handleDeleteWorker(u) {
    if (!isAdminUser || !u?.id) return;
    const ok = window.confirm(`A jeni i sigurt që dëshironi të fshini punëtorin ${u?.name || ''} nga lista e rrogave?`);
    if (!ok) return;
    setActionBusy(true);
    try {
      const res = await deleteUserRecord(u.id);
      if (salaryModal?.id === u.id) setSalaryModal(null);
      if (editingId === u.id) setEditingId(null);
      setStaff((prev) => (prev || []).filter((row) => row?.id !== u.id));
      await reloadAll(false);
      if (res?.mode === 'deactivated') {
        alert(`✅ ${u?.name || 'Përdoruesi'} u çaktivizua dhe u hoq nga lista aktive.`);
      }
    } catch (err) {
      alert('GABIM: ' + normalizeDbError(err));
    } finally {
      setActionBusy(false);
    }
  }

  const financeCards = useMemo(() => {
    return (staff || [])
      .filter(isPayrollEligibleWorker)
      .map((u) => {
        const workerName = String(u.name || "").trim().toUpperCase();
        const autoDebt = Number(debtsMap[workerName] || 0);
        const manualAdvance = Number(u.avans_manual || 0);
        const longTermDebt = Number(u.borxh_afatgjat || 0);
        const baseSalary = Number(u.salary || 0);
        return {
          ...u,
          autoDebt,
          manualAdvance,
          longTermDebt,
          baseSalary,
          totalAdvance: autoDebt + manualAdvance,
        };
      });
  }, [staff, debtsMap]);

  const monthlyPayrollPreview = useMemo(() => buildMonthlyPayrollPreview({
    workers: financeCards,
    paymentRows: payrollMonthRows,
    month: payrollMonth,
  }), [financeCards, payrollMonthRows, payrollMonth]);

  const monthlyPayrollTotals = useMemo(() => {
    return (monthlyPayrollPreview || []).reduce((acc, row) => {
      acc.gross += Number(row.gross || 0);
      acc.deductions += Number(row.deductions || 0);
      acc.net += Number(row.net || 0);
      acc.carryOver += Number(row.carryOver || 0);
      acc.openCash += Number(row.openCash || 0);
      acc.pendingHandoff += Number(row.pendingHandoff || 0);
      if (row.statusKind === 'ok') acc.okCount += 1;
      if (row.statusKind === 'blocked') acc.blockedCount += 1;
      if (row.statusKind === 'review') acc.reviewCount += 1;
      if (row.statusKind === 'paid') {
        acc.paidCount += 1;
        acc.paidTotal += Number(row.salaryPaidAmount || 0);
      }
      return acc;
    }, { gross: 0, deductions: 0, net: 0, carryOver: 0, openCash: 0, pendingHandoff: 0, okCount: 0, blockedCount: 0, reviewCount: 0, paidCount: 0, paidTotal: 0 });
  }, [monthlyPayrollPreview]);

  const selectedPayrollDetails = useMemo(() => {
    if (!selectedPayrollRow) return null;
    return (monthlyPayrollPreview || []).find((row) => row.key === selectedPayrollRow.key) || null;
  }, [monthlyPayrollPreview, selectedPayrollRow]);

  const selectedPayrollOpenCashRows = useMemo(() => {
    const workerPin = String(selectedPayrollDetails?.pin || "").trim();
    if (!workerPin) return [];
    return (Array.isArray(payrollMonthRows) ? payrollMonthRows : [])
      .filter((row) => {
        const status = String(row?.status || "").toUpperCase();
        const type = String(row?.type || "").toUpperCase();
        const createdByPin = String(row?.created_by_pin || "").trim();
        if (!['PENDING', 'COLLECTED'].includes(status)) return false;
        if (!createdByPin || createdByPin === '2380') return false;
        if (createdByPin !== workerPin) return false;
        if (MONTH_CLOSE_EXCLUDED_CASH_TYPES.has(type)) return false;
        return true;
      })
      .slice()
      .sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
  }, [payrollMonthRows, selectedPayrollDetails?.pin]);

  const selectedPayrollOpenCashTotal = useMemo(() => {
    return selectedPayrollOpenCashRows.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
  }, [selectedPayrollOpenCashRows]);

  const selectedPayrollIsHybridTransport = selectedPayrollDetails?.is_hybrid_transport === true;
  const selectedPayrollCommissionRateM2 = Number(selectedPayrollDetails?.commission_rate_m2 || 0);
  const selectedPayrollShowHybridCash = selectedPayrollIsHybridTransport && selectedPayrollCommissionRateM2 > 0;

  const selectedPayrollHybridCashRows = useMemo(() => {
    if (!selectedPayrollShowHybridCash) return [];
    return selectedPayrollOpenCashRows.map((row) => buildHybridCashDisplayRow(row, selectedPayrollCommissionRateM2));
  }, [selectedPayrollOpenCashRows, selectedPayrollShowHybridCash, selectedPayrollCommissionRateM2]);

  const selectedPayrollHybridCashTotals = useMemo(() => {
    return selectedPayrollHybridCashRows.reduce((acc, item) => {
      acc.gross += Number(item?.amount || 0);
      acc.m2 += Number(item?.m2 || 0);
      acc.commissionKept += Number(item?.commissionKept || 0);
      acc.baseHandover += Number(item?.baseHandover || 0);
      return acc;
    }, { gross: 0, m2: 0, commissionKept: 0, baseHandover: 0 });
  }, [selectedPayrollHybridCashRows]);

  function getFinanceWorkerForPayrollRow(row) {
    if (!row) return null;
    return (financeCards || []).find((worker) => {
      const sameId = row?.id && worker?.id && String(row.id) === String(worker.id);
      const samePin = row?.pin && worker?.pin && String(row.pin) === String(worker.pin);
      return sameId || samePin;
    }) || row;
  }

  function openPayrollPayModal(row) {
    const worker = getFinanceWorkerForPayrollRow(row);
    if (!worker) return;
    openSalaryModal(worker);
  }

  const monthClosePreview = useMemo(() => {
    const rows = Array.isArray(payrollMonthRows) ? payrollMonthRows : [];
    const fixedExpenses = Array.isArray(monthCloseSummary?.fixedExpenses) ? monthCloseSummary.fixedExpenses : [];

    const cashRows = rows.filter((row) => !row?.active_exclusion && !MONTH_CLOSE_EXCLUDED_CASH_TYPES.has(String(row?.type || '').toUpperCase()));
    const cashInHandRows = cashRows.filter((row) => ['PENDING', 'COLLECTED'].includes(String(row?.status || '').toUpperCase()));
    const dispatchRows = cashRows.filter((row) => String(row?.status || '').toUpperCase() === 'PENDING_DISPATCH_APPROVAL');
    const collectedRows = cashRows.filter((row) => {
      const status = String(row?.status || '').toUpperCase();
      return !['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL'].includes(status);
    });
    const expenseRows = rows.filter(isMonthlyExpenseRow);

    const activeFixed = fixedExpenses.filter((row) => row && row.active !== false);
    const essentialFixed = activeFixed.filter((row) => row.essential !== false);
    const fixedTotal = activeFixed.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
    const essentialTotal = essentialFixed.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
    const payrollNet = Number(monthlyPayrollTotals?.net || 0);
    const companyCash = Number(monthCloseSummary?.companyCash || 0);
    const adminCashOpenTotal = Number(monthCloseSummary?.adminCashOpenTotal || 0);
    const adminCashOpenCount = Number(monthCloseSummary?.adminCashOpenCount || 0);
    const adminCashOpenBreakdown = Array.isArray(monthCloseSummary?.adminCashOpenBreakdown)
      ? monthCloseSummary.adminCashOpenBreakdown
      : [];
    const adminCashOpenRows = Array.isArray(monthCloseSummary?.adminCashOpenRows)
      ? monthCloseSummary.adminCashOpenRows
      : [];
    const adminCashClassSummary = monthCloseSummary?.adminCashClassSummary || buildAdminCashClassSummary(adminCashOpenRows);
    const cashInHand = cashInHandRows.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
    const pendingDispatch = dispatchRows.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
    const collectedMonth = collectedRows.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
    const monthExpenses = expenseRows.reduce((sum, row) => sum + Number(row?.amount || 0), 0);
    const afterPayments = companyCash - essentialTotal - payrollNet;
    const reasons = [];

    if (cashInHand > 0) reasons.push(`Ka cash në dorë te punëtorët: ${euro(cashInHand)}`);
    if (adminCashOpenTotal > 0) reasons.push(`Ka cash admin/master të hapur: ${euro(adminCashOpenTotal)}`);
    if (pendingDispatch > 0) reasons.push(`Ka cash në pritje dispatch: ${euro(pendingDispatch)}`);
    if (companyCash < payrollNet + essentialTotal) reasons.push(`Cash-i i kompanisë nuk mjafton për rroga + obligime esenciale: mungojnë ${euro((payrollNet + essentialTotal) - companyCash)}`);
    if (monthCloseSummary?.budgetError) reasons.push(`Company budget nuk u lexua plotësisht: ${monthCloseSummary.budgetError}`);
    if (monthCloseSummary?.fixedExpensesError) reasons.push(`Obligimet fikse nuk u lexuan plotësisht: ${monthCloseSummary.fixedExpensesError}`);
    if (monthCloseSummary?.adminCashOpenError) reasons.push(`Admin/master cash nuk u lexua plotësisht: ${monthCloseSummary.adminCashOpenError}`);

    const safe =
      cashInHand <= 0 &&
      adminCashOpenTotal <= 0 &&
      pendingDispatch <= 0 &&
      companyCash >= payrollNet + essentialTotal &&
      !monthCloseSummary?.budgetError &&
      !monthCloseSummary?.fixedExpensesError &&
      !monthCloseSummary?.adminCashOpenError;

    return {
      month: payrollMonth,
      companyCash,
      collectedMonth,
      cashInHand,
      cashInHandCount: cashInHandRows.length,
      adminCashOpenTotal,
      adminCashOpenCount,
      adminCashOpenBreakdown,
      adminCashOpenRows,
      adminCashClassSummary,
      pendingDispatch,
      pendingDispatchCount: dispatchRows.length,
      monthExpenses,
      fixedTotal,
      essentialTotal,
      fixedCount: activeFixed.length,
      payrollNet,
      okWorkers: monthlyPayrollTotals.okCount,
      blockedWorkers: monthlyPayrollTotals.blockedCount,
      afterPayments,
      safe,
      reasons,
    };
  }, [payrollMonthRows, monthCloseSummary, monthlyPayrollTotals, payrollMonth]);

  const payrollGroups = useMemo(() => {
    const rows = Array.isArray(monthlyPayrollPreview) ? monthlyPayrollPreview : [];
    return {
      blocked: rows.filter((row) => row.statusKind === 'blocked'),
      ok: rows.filter((row) => row.statusKind === 'ok'),
      review: rows.filter((row) => row.statusKind === 'review'),
      paid: rows.filter((row) => row.statusKind === 'paid'),
    };
  }, [monthlyPayrollPreview]);

  const monthCloseMissing = Math.max(
    0,
    Number(monthClosePreview?.payrollNet || 0) + Number(monthClosePreview?.essentialTotal || 0) - Number(monthClosePreview?.companyCash || 0)
  );
  const monthCloseTopReasons = (monthClosePreview?.reasons || []).slice(0, 2);

  const adminCashFilteredRows = useMemo(() => {
    const rows = Array.isArray(monthClosePreview?.adminCashOpenRows) ? monthClosePreview.adminCashOpenRows : [];
    if (adminCashClassFilter === 'ALL') return rows;
    return rows.filter((row) => classifyAdminCashPayment(row).key === adminCashClassFilter);
  }, [monthClosePreview?.adminCashOpenRows, adminCashClassFilter]);

  function renderWorkerRow(row, tone = row?.statusKind || 'review') {
    return (
      <button type="button" className={`workerRow ${tone}`} key={row.key} onClick={() => setSelectedPayrollRow(row)}>
        <div className="workerLeft">
          <strong>{row.name}</strong>
          <small>PIN {row.pin || "—"}</small>
        </div>
        <div className="workerRight">
          <span className={`miniBadge ${tone}`}>{row.statusLabel}</span>
          <b>{euro(row.net)}</b>
        </div>
        {(row.warnings || []).length ? <em>{row.warnings[0]}</em> : null}
      </button>
    );
  }

  const isClosedMonth = String(closedMonthSnapshot?.status || "").toUpperCase() === "CLOSED";
  const closedWorkerItems = useMemo(() => {
    return (Array.isArray(closedMonthItems) ? closedMonthItems : [])
      .slice()
      .sort((a, b) => String(a?.worker_name || "").localeCompare(String(b?.worker_name || "")));
  }, [closedMonthItems]);

  if (actor && !isAdminUser) return <AccessDeniedPanel />;

  return (
    <div className="payrollPage">
      <div className="shell">
        <div className="topbar payrollHeader">
          <div>
            <div className="eyebrow">ARKA / PAYROLL</div>
            <h1 className="title">Mbyllja mujore</h1>
            <p className="subtitle">Kontroll para pagesës së rrogave.</p>
          </div>

          <div className="topActions">
            <Link prefetch={false} href="/arka" className="navBtn">← KTHEHU</Link>
            <button
              type="button"
              className="navBtn refreshBtn"
              onClick={() => reloadMonthlyPayrollPreview(payrollMonth)}
              disabled={payrollMonthLoading}
            >
              {payrollMonthLoading ? "PO LEXOHET..." : "RIFRESKO"}
            </button>
          </div>
        </div>

        <details className="adminTools">
          <summary>ADMIN TOOLS</summary>
          <div className="adminToolsBody">
            <label className="adminPinBox">
              <span>Master PIN</span>
              <input
                type="password"
                value={masterPin}
                placeholder="****"
                onChange={(e) => setMasterPin(onlyDigits(e.target.value))}
                autoComplete="off"
              />
            </label>
            <Link prefetch={false} href="/arka/stafi" className="staffManageLink">MENAXHIMI I STAFIT</Link>
          </div>
        </details>

        {isClosedMonth ? (
          <section className="financeDashboard closedSnapshotDashboard">
            <div className="heroStatus safe closedHero">
              <div>
                <span>{payrollMonth}</span>
                <h2>MUAJI ËSHTË MBYLLUR</h2>
                <p>Snapshot read-only nga payroll_month_closes.</p>
              </div>
              <div className="statusPill safe">CLOSED</div>
              <div className="heroReasons">
                <small>Close ID #{closedMonthSnapshot?.id || "—"} · Mbyllur: {formatPaidDateTime(closedMonthSnapshot?.closed_at || closedMonthSnapshot?.created_at)}</small>
              </div>
            </div>

            {payrollMonthError ? <div className="proError">Gabim në snapshot: {payrollMonthError}</div> : null}

            <div className="monthControlStrip">
              <label>
                <span>Muaji</span>
                <input
                  type="month"
                  value={payrollMonth}
                  onChange={(e) => setPayrollMonth(e.target.value || getCurrentPayrollMonth())}
                />
              </label>
              <div>
                <span>Payroll status</span>
                <strong>CLOSED</strong>
              </div>
            </div>

            <div className="primaryMoneyGrid">
              <div className="moneyTile good"><span>BALANCA PARA</span><strong>{euro(closedMonthSnapshot?.company_balance_before)}</strong><small>Snapshot</small></div>
              <div className="moneyTile danger"><span>PAYROLL OUT</span><strong>{euro(closedMonthSnapshot?.total_net_pay)}</strong><small>{Number(closedMonthSnapshot?.total_workers || 0)} punëtorë</small></div>
              <div className="moneyTile info"><span>RROGA BAZË</span><strong>{euro(closedMonthSnapshot?.total_salary_base)}</strong><small>Advances: {euro(closedMonthSnapshot?.total_advances)}</small></div>
              <div className="moneyTile good"><span>BALANCA PAS</span><strong>{euro(closedMonthSnapshot?.company_balance_after)}</strong><small>Ledger #{closedMonthSnapshot?.company_ledger_entry_id || "—"}</small></div>
            </div>

            <div className="secondaryMoneyGrid">
              <div className="smallTile warn"><span>CASH HAPUR NË MBYLLJE</span><strong>{euro(closedMonthSnapshot?.total_cash_open_at_close)}</strong><small>Snapshot</small></div>
              <div className="smallTile warn"><span>DISPATCH NË PRITJE</span><strong>{euro(closedMonthSnapshot?.total_pending_dispatch_at_close)}</strong><small>Snapshot</small></div>
              <div className="smallTile danger"><span>OBLIGIME SNAPSHOT</span><strong>{euro(closedMonthSnapshot?.total_essential_obligations)}</strong><small>Nuk bllokon më muajin e mbyllur</small></div>
            </div>

            <section className="workerSection okpay">
              <div className="sectionHead">
                <h3>SNAPSHOT I RROGAVE</h3>
                <span>{closedWorkerItems.length}</span>
              </div>
              <div className="workerList">
                {closedWorkerItems.length ? closedWorkerItems.map((row) => (
                  <div className="workerRow ok" key={row?.id || `${row?.worker_pin}_${row?.worker_name}`}>
                    <div className="workerLeft">
                      <strong>{row?.worker_name || "—"}</strong>
                      <small>PIN {row?.worker_pin || "—"}</small>
                    </div>
                    <div className="workerRight">
                      <span className={`miniBadge ${String(row?.status || "").includes("ACCEPT") ? "green" : "ok"}`}>{row?.status === "PENDING_WORKER_ACCEPTANCE" ? "NË PRITJE TË PUNTORIT" : (row?.status || "CLOSED")}</span>
                      <b>{euro(row?.net_pay)}</b>
                    </div>
                  </div>
                )) : <div className="emptyCompact">Nuk ka worker snapshot për këtë muaj.</div>}
              </div>
            </section>
          </section>
        ) : (
        <section className="financeDashboard">
          <div className={`heroStatus ${monthClosePreview.safe ? 'safe' : 'blocked'}`}>
            <div>
              <span>{payrollMonth}</span>
              <h2>{monthClosePreview.safe ? 'SAFE PËR PAYROLL' : 'NUK ËSHTË SAFE'}</h2>
              <p>{monthClosePreview.safe ? 'Mund të vazhdosh pas kontrollit final.' : `Mungojnë: ${euro(monthCloseMissing)}`}</p>
            </div>
            <div className={`statusPill ${monthClosePreview.safe ? 'safe' : 'blocked'}`}>
              {monthClosePreview.safe ? 'SAFE' : 'BLLOKUAR'}
            </div>
            <div className="heroReasons">
              {monthCloseTopReasons.length ? monthCloseTopReasons.map((reason) => <small key={reason}>{reason}</small>) : <small>Pa bllokues kryesorë.</small>}
            </div>
          </div>

          {payrollMonthError ? <div className="proError">Gabim në preview: {payrollMonthError}</div> : null}
          {monthCloseError ? <div className="proError">Lexim jo i plotë: {monthCloseError}</div> : null}

          <div className="monthControlStrip">
            <label>
              <span>Muaji</span>
              <input
                type="month"
                value={payrollMonth}
                onChange={(e) => setPayrollMonth(e.target.value || getCurrentPayrollMonth())}
              />
            </label>
            <div>
              <span>Payroll status</span>
              <strong>{monthClosePreview.safe ? 'SAFE' : 'KONTROLLO'}</strong>
            </div>
          </div>

          <div className="primaryMoneyGrid">
            <div className="moneyTile good"><span>CASH NË KOMPANI</span><strong>{euro(monthClosePreview.companyCash)}</strong><small>Gjendja aktuale</small></div>
            <div className="moneyTile danger"><span>OBLIGIME</span><strong>{euro(monthClosePreview.fixedTotal)}</strong><small>{monthClosePreview.fixedCount} aktive</small></div>
            <div className="moneyTile info"><span>PAYROLL NET</span><strong>{euro(monthClosePreview.payrollNet)}</strong><small>{monthClosePreview.okWorkers} OK · {monthClosePreview.blockedWorkers} bllokuar</small></div>
            <div className={`moneyTile ${monthClosePreview.afterPayments >= 0 ? 'good' : 'danger'}`}><span>MBETET PAS PAGESAVE</span><strong>{euro(monthClosePreview.afterPayments)}</strong><small>Pas obligimeve dhe rrogave</small></div>
          </div>

          <div className="secondaryMoneyGrid">
            <div className="smallTile warn"><span>CASH NË DORË</span><strong>{euro(monthClosePreview.cashInHand)}</strong><small>{monthClosePreview.cashInHandCount} raste</small></div>
            <div className="smallTile warn"><span>NË PRITJE DISPATCH</span><strong>{euro(monthClosePreview.pendingDispatch)}</strong><small>{monthClosePreview.pendingDispatchCount} raste</small></div>
            <div className="smallTile danger"><span>SHPENZIME MUAJORE</span><strong>{euro(monthClosePreview.monthExpenses)}</strong><small>Për këtë muaj</small></div>
          </div>

          <section className="workerSection reviewpay adminCashSection">
            <div className="sectionHead">
              <h3>CASH ADMIN / MASTER I HAPUR</h3>
              <span>{monthClosePreview.adminCashOpenCount || 0}</span>
            </div>
            <button
              type="button"
              className="adminCashSummaryCard"
              onClick={() => setShowAdminCashDetails((value) => !value)}
              aria-expanded={showAdminCashDetails}
            >
              <div>
                <span>MASTER USER TOTAL</span>
                <strong>{euro(monthClosePreview.adminCashOpenTotal)}</strong>
                <small>{monthClosePreview.adminCashOpenCount || 0} pagesa</small>
              </div>
              <b>{showAdminCashDetails ? "MBYLL DETAJET" : "SHIKO DETAJET"}</b>
            </button>
            <div className="secondaryMoneyGrid">
              {(monthClosePreview.adminCashOpenBreakdown || []).map((item) => (
                <div key={item.label} className="smallTile warn">
                  <span>{item.label}</span>
                  <strong>{euro(item.total)}</strong>
                  <small>{Number(item.count || 0)} pagesa</small>
                </div>
              ))}
            </div>
            {showAdminCashDetails ? (
              <div className="adminCashDetailsPanel">
                <div className="adminCashDetailsHead">
                  <strong>Detajet read-only</strong>
                  <small>Burimi: arka_pending_payments + arka_payment_exclusions · insert-only audit</small>
                </div>
                <div className="adminCashClassSummaryGrid">
                  {['REAL_CANDIDATE', 'TEST', 'SUSPICIOUS', 'EXCLUDED'].map((key) => {
                    const item = monthClosePreview.adminCashClassSummary?.[key] || { total: 0, count: 0 };
                    const label = key === 'REAL_CANDIDATE' ? 'real candidate total' : key === 'TEST' ? 'test candidate total' : key === 'SUSPICIOUS' ? 'suspicious total' : 'excluded total';
                    return (
                      <div key={key} className={`adminCashClassSummary ${key.toLowerCase()}`}>
                        <span>{label}</span>
                        <strong>{euro(item.total)}</strong>
                        <small>{Number(item.count || 0)} pagesa</small>
                      </div>
                    );
                  })}
                </div>
                <div className="adminCashFilterChips">
                  {ADMIN_CASH_CLASS_FILTERS.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className={adminCashClassFilter === item.key ? 'active' : ''}
                      onClick={() => setAdminCashClassFilter(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {adminCashMarkMessage ? <div className="adminCashMarkMessage">{adminCashMarkMessage}</div> : null}
                <div className="adminCashTableWrap">
                  <table className="adminCashTable">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>KODI</th>
                        <th>KLIENTI</th>
                        <th>SHUMA</th>
                        <th>STATUS</th>
                        <th>TYPE</th>
                        <th>SOURCE</th>
                        <th>CLASS</th>
                        <th>PAGUAR</th>
                        <th>NOTE</th>
                        <th>VEPRIM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminCashFilteredRows.length ? adminCashFilteredRows.map((row, index) => {
                        const cls = classifyAdminCashPayment(row);
                        return (
                          <tr key={String(row?.id || `${row?.created_at || 'row'}_${index}`)}>
                            <td>{row?.id || "—"}</td>
                            <td>{adminCashDisplayCode(row)}</td>
                            <td>{adminCashClientName(row)}</td>
                            <td>{euro(row?.amount)}</td>
                            <td>{row?.status || "—"}</td>
                            <td>{row?.type || "—"}</td>
                            <td>{adminCashSourceModule(row)}</td>
                            <td><span className={`adminCashClassBadge ${cls.tone}`}>{cls.label}</span></td>
                            <td>{formatPaidDateTime(row?.created_at)}</td>
                            <td>{adminCashNote(row)}</td>
                            <td>
                              {['TEST', 'SUSPICIOUS'].includes(cls.key) ? (
                                <button
                                  type="button"
                                  className="adminCashMarkBtn"
                                  disabled={adminCashMarkingId === row?.id}
                                  onClick={() => markAdminCashPaymentAsTestVoid(row)}
                                >
                                  {adminCashMarkingId === row?.id ? 'DUKE MARKUAR…' : 'MARKO SI TEST / VOID'}
                                </button>
                              ) : cls.key === 'EXCLUDED' ? (
                                <span className="adminCashExcludedNote">PËRJASHTUAR</span>
                              ) : '—'}
                            </td>
                          </tr>
                        );
                      }) : (
                        <tr>
                          <td colSpan="11">Nuk ka pagesa admin/master për këtë filtër.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </section>

          <section className="workerSection blockers">
            <div className="sectionHead">
              <h3>PUNËTORË QË BLOKOJNË</h3>
              <span>{payrollGroups.blocked.length}</span>
            </div>
            <div className="workerList">
              {payrollGroups.blocked.length ? payrollGroups.blocked.map((row) => renderWorkerRow(row, 'blocked')) : <div className="emptyCompact">Asnjë punëtor nuk e bllokon payroll-in.</div>}
            </div>
          </section>

          <section className="workerSection okpay">
            <div className="sectionHead">
              <h3>OK PËR PAGESË</h3>
              <span>{payrollGroups.ok.length}</span>
            </div>
            <div className="workerList">
              {payrollGroups.ok.length ? payrollGroups.ok.map((row) => renderWorkerRow(row, 'ok')) : <div className="emptyCompact">Nuk ka punëtorë OK për pagesë.</div>}
            </div>
          </section>

          <section className="workerSection reviewpay">
            <div className="sectionHead">
              <h3>KONTROLLO</h3>
              <span>{payrollGroups.review.length}</span>
            </div>
            <div className="workerList">
              {payrollGroups.review.length ? payrollGroups.review.map((row) => renderWorkerRow(row, 'review')) : <div className="emptyCompact">Nuk ka punëtorë për kontroll shtesë.</div>}
            </div>
          </section>

          <section className="workerSection paidpay">
            <div className="sectionHead">
              <h3>PAGUAR</h3>
              <span>{payrollGroups.paid.length}</span>
            </div>
            <div className="workerList">
              {payrollGroups.paid.length ? payrollGroups.paid.map((row) => renderWorkerRow(row, 'paid')) : <div className="emptyCompact">Nuk ka punëtorë të paguar për këtë muaj.</div>}
            </div>
          </section>

          <details className="calcDetails">
            <summary>SI LLOGARITET PAYROLL?</summary>
            <div className="calcGrid">
              <div><span>Rroga bazë total</span><strong>{euro(monthlyPayrollTotals.gross)}</strong></div>
              <div><span>Zbritet nga rroga</span><strong>{euro(monthlyPayrollTotals.deductions)}</strong></div>
              <div><span>Avans bartet</span><strong>{euro(monthlyPayrollTotals.carryOver)}</strong></div>
              <div><span>Cash hapur</span><strong>{euro(monthlyPayrollTotals.openCash)}</strong></div>
              <div><span>Dorëzim në pritje</span><strong>{euro(monthlyPayrollTotals.pendingHandoff)}</strong></div>
              <div><span>Paguar këtë muaj</span><strong>{euro(monthlyPayrollTotals.paidTotal)}</strong></div>
            </div>
            <p>Rroga mujore llogaritet nga rroga bazë minus avansi personal. Cash-i i hapur dhe dorëzimi në pritje përdoren vetëm për bllokim/kontroll.</p>
          </details>
        </section>
        )}

        {editingId && (
          <section className="editPanel">
            <div className="editTop">
              <div>
                <div className="editEyebrow">Finance Edit</div>
                <div className="editTitle">Rregullo Parametrat e Rrogës</div>
              </div>
              <button className="closeBtn" onClick={() => setEditingId(null)}>✕</button>
            </div>

            <div className="formGrid">
              <label className="field">
                <span>Rroga bazë (€)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  className="fieldInput salaryField"
                  value={editForm.salary}
                  onChange={(e) => setEditForm({ ...editForm, salary: onlyDigits(e.target.value) })}
                  placeholder="P.sh. 500"
                />
              </label>

              <label className="field">
                <span>Dita e rrogës (1–31)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  className="fieldInput"
                  value={editForm.salary_day}
                  onChange={(e) => setEditForm({ ...editForm, salary_day: onlyDigits(e.target.value) })}
                  placeholder="P.sh. 25"
                />
              </label>

              <label className="field">
                <span>Avans manual (€)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  className="fieldInput warningField"
                  value={editForm.avans_manual}
                  onChange={(e) => setEditForm({ ...editForm, avans_manual: onlyDigits(e.target.value) })}
                  placeholder="P.sh. 50"
                />
              </label>

              <label className="field">
                <span>Borxh afatgjatë (€)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  className="fieldInput dangerField"
                  value={editForm.borxh_afatgjat}
                  onChange={(e) => setEditForm({ ...editForm, borxh_afatgjat: onlyDigits(e.target.value) })}
                  placeholder="P.sh. 200"
                />
              </label>
            </div>

            <div className="editActions">
              <button className="saveBtn" onClick={saveFinanceEdit} disabled={actionBusy}>
                RUAJ NDRYSHIMET
              </button>
            </div>
          </section>
        )}

        {loading ? (
          <div className="empty">Po lexohen financat...</div>
        ) : null}
      </div>

      {selectedPayrollDetails && (
        <div
          className="fullOverlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelectedPayrollRow(null);
          }}
        >
          <div className="fullModal payrollDetailModal">
            <div className="modalTop">
              <div>
                <div className="modalEyebrow">DETAJE TË RROGËS</div>
                <div className="modalTitle">{selectedPayrollDetails.name}</div>
                <div className="modalWorker">PIN {selectedPayrollDetails.pin || "—"} · {payrollMonth}</div>
              </div>
              <button className="closeBtn" onClick={() => setSelectedPayrollRow(null)}>✕</button>
            </div>

            <div className="detailGrid">
              <div className="detailBox good">
                <span>Rroga bazë</span>
                <strong>{euro(selectedPayrollDetails.gross)}</strong>
              </div>
              <div className="detailBox warn">
                <span>Avans personal</span>
                <strong>{euro(selectedPayrollDetails.deductions)}</strong>
              </div>
              <div className="detailBox main">
                <span>Për me ia dhënë</span>
                <strong>{euro(selectedPayrollDetails.net)}</strong>
              </div>
              <div className="detailBox paidBox">
                <span>Paguar këtë muaj</span>
                <strong>{euro(selectedPayrollDetails.salaryPaidAmount || 0)}</strong>
              </div>
            </div>

            <div className="detailFormula">
              <div className="formulaTitle">Formula e rrogës</div>
              <div className="formulaLine">
                RROGA BAZË {euro(selectedPayrollDetails.baseSalary)}
                {" - "} AVANS PERSONAL {euro(selectedPayrollDetails.advancesTotal)}
                {" = "} NETO {euro(selectedPayrollDetails.net)}
              </div>
              <div className="formulaNote">
                Vetëm avansi personal zbritet nga rroga. Komisioni, ushqimi, shpenzimet e kompanisë, borxhi informativ dhe cash-i i klientëve nuk e ulin rrogën mujore në këtë ekran.
              </div>
            </div>

            <div className="breakdownGrid">
              <div className="breakdownCard infoOnly">
                <h3>PAGA QË LLOGARITET</h3>
                <p><span>Rroga bazë</span><strong>{euro(selectedPayrollDetails.baseSalary)}</strong></p>
                <p><span>Komision ditor informativ</span><strong>{euro(selectedPayrollDetails.transportCommission)}</strong></p>
                <p><span>Transport m²</span><strong>{Number(selectedPayrollDetails.transportM2 || 0).toFixed(2)} m²</strong></p>
              </div>

              <div className="breakdownCard deductOnly">
                <h3>ZBRITET NGA RROGA</h3>
                <p><span>Avans personal</span><strong>{euro(selectedPayrollDetails.advancesTotal)}</strong></p>
                
                
              </div>

              <div className="breakdownCard blockOnly">
                <h3>BLLOKON PAGESËN, POR NUK ZBRITET</h3>
                <p><span>Cash hapur</span><strong>{euro(selectedPayrollDetails.openCash)}</strong></p>
                <p><span>Dorëzim në pritje</span><strong>{euro(selectedPayrollDetails.pendingHandoff)}</strong></p>
                <p><span>Status</span><strong>{selectedPayrollDetails.statusLabel}</strong></p>
              </div>
            </div>

            <div className="workerCashDeliverySection">
              <div className="workerCashDeliveryHead">
                <div>
                  <h3>PAGESAT QË DUHET ME I DORËZU</h3>
                  <p>Read-only lista e cash-it të hapur për këtë punëtor.</p>
                </div>
                <strong>{selectedPayrollShowHybridCash ? euro(selectedPayrollHybridCashTotals.baseHandover) : euro(selectedPayrollOpenCashTotal)}</strong>
              </div>

              {selectedPayrollShowHybridCash && selectedPayrollOpenCashRows.length ? (
                <div className="hybridCashSummary">
                  <h3>PËRMBLEDHJE CASH HYBRID</h3>
                  <p><span>CASH BRUTO NGA KLIENTËT</span><strong>{euro(selectedPayrollHybridCashTotals.gross)}</strong></p>
                  <p><span>KOMISION I MBAJTUR NGA PUNËTORI</span><strong>{euro(selectedPayrollHybridCashTotals.commissionKept)}</strong></p>
                  <p><span>DUHET ME DORËZU NË BAZË</span><strong>{euro(selectedPayrollHybridCashTotals.baseHandover)}</strong></p>
                </div>
              ) : null}

              {selectedPayrollOpenCashRows.length ? (
                <div className="workerCashDeliveryList">
                  {selectedPayrollShowHybridCash ? selectedPayrollHybridCashRows.map((item) => (
                    <div className="workerCashDeliveryRow hybrid" key={item?.row?.id || `${item?.row?.created_at}_${item?.row?.amount}`}>
                      <div className="workerCashDeliveryMain">
                        <strong>{workerCashDisplayCode(item?.row)}</strong>
                        <span>{textValue(item?.row?.client_name, item?.row?.data?.client_name, item?.row?.customer_name, item?.row?.name) || "—"}</span>
                      </div>
                      <div className="workerCashDeliveryMeta hybridMeta">
                        <p><span>Cash bruto</span><b>{euro(item?.amount)}</b></p>
                        <p><span>m²</span><b>{Number(item?.m2 || 0).toFixed(2)} m²</b></p>
                        <p><span>Komision i mbajtur</span><b>{euro(item?.commissionKept)}</b></p>
                        <p><span>Për bazë</span><b>{euro(item?.baseHandover)}</b></p>
                        <small>{String(item?.row?.status || "—").toUpperCase()} · {formatBelgradeDateTime(item?.row?.created_at)}</small>
                      </div>
                    </div>
                  )) : selectedPayrollOpenCashRows.map((payment) => (
                    <div className="workerCashDeliveryRow" key={payment?.id || `${payment?.created_at}_${payment?.amount}`}>
                      <div className="workerCashDeliveryMain">
                        <strong>{workerCashDisplayCode(payment)}</strong>
                        <span>{textValue(payment?.client_name, payment?.data?.client_name, payment?.customer_name, payment?.name) || "—"}</span>
                      </div>
                      <div className="workerCashDeliveryMeta">
                        <b>{euro(payment?.amount)}</b>
                        <span>{String(payment?.status || "—").toUpperCase()} · {textValue(payment?.source_module) || "—"}</span>
                        <small>{formatBelgradeDateTime(payment?.created_at)}</small>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="workerCashDeliveryEmpty">Nuk ka pagesa të hapura për dorëzim.</div>
              )}

              {selectedPayrollShowHybridCash ? (
                <div className="workerCashDeliveryTotal hybridTotals">
                  <p><span>CASH BRUTO NGA KLIENTËT</span><strong>{euro(selectedPayrollHybridCashTotals.gross)}</strong></p>
                  <p><span>KOMISION I MBAJTUR</span><strong>{euro(selectedPayrollHybridCashTotals.commissionKept)}</strong></p>
                  <p><span>DUHET ME DORËZU NË BAZË</span><strong>{euro(selectedPayrollHybridCashTotals.baseHandover)}</strong></p>
                </div>
              ) : (
                <div className="workerCashDeliveryTotal">
                  <span>TOTAL CASH PËR DORËZIM</span>
                  <strong>{euro(selectedPayrollOpenCashTotal)}</strong>
                </div>
              )}
            </div>

            {selectedPayrollDetails.warnings.length ? (
              <div className="detailWarnings">
                <strong>Çka duhet kontrolluar para pagesës</strong>
                <ul>
                  {selectedPayrollDetails.warnings.map((w) => {
                    const isHybridCashWarning = selectedPayrollShowHybridCash && /^Ka cash të hapur:/i.test(String(w || ""));
                    if (isHybridCashWarning) {
                      return (
                        <React.Fragment key={w}>
                          <li>Cash bruto i hapur: {euro(selectedPayrollHybridCashTotals.gross)}</li>
                          <li>Komision i mbajtur: {euro(selectedPayrollHybridCashTotals.commissionKept)}</li>
                          <li>Duhet me dorëzu në bazë: {euro(selectedPayrollHybridCashTotals.baseHandover)}</li>
                        </React.Fragment>
                      );
                    }
                    return <li key={w}>{w}</li>;
                  })}
                </ul>
              </div>
            ) : (
              <div className="detailOk">
                {selectedPayrollDetails.statusKind === 'paid'
                  ? 'Ky puntor është PAGUAR për këtë muaj. Mos e paguaj përsëri.'
                  : 'Ky puntor është OK për pagesë. Nuk ka cash/dorëzim që e bllokon rrogën.'}
              </div>
            )}

            <div className="detailActions">
              <button
                type="button"
                className="advanceBtn"
                onClick={() => {
                  const row = selectedPayrollDetails;
                  setSelectedPayrollRow(null);
                  openAdvanceModal(getFinanceWorkerForPayrollRow(row));
                }}
              >
                💸 SHTO AVANS
              </button>
              <button
                type="button"
                className="editMini"
                onClick={() => {
                  const row = selectedPayrollDetails;
                  setSelectedPayrollRow(null);
                  startFinanceEdit(getFinanceWorkerForPayrollRow(row));
                }}
              >
                EDITO RROGËN / PARAMETRAT
              </button>
              <button
                type="button"
                className="payBtn detailPayBtn"
                disabled={selectedPayrollDetails.statusKind !== 'ok'}
                onClick={() => {
                  const row = selectedPayrollDetails;
                  setSelectedPayrollRow(null);
                  openPayrollPayModal(row);
                }}
              >
                💳 PAGUAJ RROGËN
              </button>
            </div>
            {selectedPayrollDetails.statusKind !== 'ok' ? (
              <div className="detailPayGuard">
                Butoni hapet vetëm kur statusi është OK PËR PAGESË dhe nuk është paguar këtë muaj.
              </div>
            ) : null}
          </div>
        </div>
      )}

      {advanceModal && (
        <div
          className="fullOverlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setAdvanceModal(null);
          }}
        >
          <div className="fullModal compactModal">
            <div className="modalTop">
              <div>
                <div className="modalEyebrow">Quick Advance</div>
                <div className="modalTitle">Shto Avans</div>
                <div className="modalWorker">{advanceModal.name}</div>
              </div>
              <button className="closeBtn" onClick={() => setAdvanceModal(null)}>✕</button>
            </div>

            <div className="advanceIntro">
              Çdo avans që shton këtu ruhet si hyrje reale dhe llogaritet vetë te payroll-i. Nuk ke nevojë me e mbledh dorazi.
            </div>

            <div className="advanceGrid">
              <label className="field">
                <span>Shuma e avansit (€)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  className="fieldInput warningField"
                  value={advanceAmount}
                  onChange={(e) => setAdvanceAmount(e.target.value)}
                  placeholder="P.sh. 20"
                />
              </label>
              <label className="field advanceWide">
                <span>Shënim (opsionale)</span>
                <input
                  type="text"
                  className="fieldInput"
                  value={advanceNote}
                  onChange={(e) => setAdvanceNote(e.target.value)}
                  placeholder="P.sh. Naftë / para xhepi / urgjente"
                />
              </label>
            </div>

            <div className="advanceHintRow">
              <div className="advanceHintCard">
                <span>Avanset aktuale</span>
                <strong>{euro((Number(debtsMap[String(advanceModal?.name || '').trim().toUpperCase()] || 0) || 0) + Number(advanceModal?.avans_manual || 0))}</strong>
              </div>
              <div className="advanceHintCard muted">
                <span>Do të zbritet automatikisht</span>
                <strong>TE PAGA</strong>
              </div>
            </div>

            <div className="actionStack compactActions">
              <button className="amberCta" disabled={advanceBusy} onClick={handleAddAdvance}>
                {advanceBusy ? 'PO REGJISTROHET...' : 'RUAJ AVANSIN'}
              </button>
            </div>

            <div className="historyPane slimHistory">
              <div className="historyTop">
                <div className="historyTitle">Historiku i Shpejtë</div>
                <div className="historySub">Veprimet e fundit për këtë punëtor</div>
              </div>
              {workerHistory.length === 0 ? (
                <div className="historyEmpty">Nuk ka histori financiare për këtë punëtor.</div>
              ) : (
                <div className="historyList smallHistoryList">
                  {workerHistory.slice(0, 8).map((row) => {
                    const badge = badgeFromHistory(row);
                    return (
                      <div className="historyCard" key={row.id}>
                        <div className="historyCardTop">
                          <div className={`historyBadge ${badge.tone}`}>{badge.label}</div>
                          <div className="historyDate">{formatDateTime(row.created_at)}</div>
                        </div>
                        <div className="historyAmount">{euro(row.amount)}</div>
                        <div className="historyNote">{row.note || 'Pa shënim'}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {salaryModal && (
        <div
          className="fullOverlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSalaryModal(null);
          }}
        >
          <div className="fullModal">
            <div className="modalTop">
              <div>
                <div className="modalEyebrow">Smart Payroll</div>
                <div className="modalTitle">Fletëpagesa Moderne</div>
                <div className="modalWorker">{salaryModal.name}</div>
              </div>
              <button className="closeBtn" onClick={() => setSalaryModal(null)}>✕</button>
            </div>

            <div className="payMainGrid">
              <div className="paySummary">
                <div className="bigNumberCard salaryPayoutCard">
                  <span>Për me ia dhënë</span>
                  <strong>{euro(payableAmount)}</strong>
                  <small>Formula fikse: Rroga bazë − avansi personal. Nuk ka zgjedhje manuale këtu.</small>
                </div>

                <div className="salaryFormulaBox">
                  <div className="formulaTitle">Formula e pagesës</div>
                  <div className="formulaLine">
                    RROGA BAZË {euro(salaryModal.baseSalary)}
                    {" - "} AVANS PERSONAL {euro(Number(salaryModal.autoDebt || 0) + Number(salaryModal.manualAdvance || 0))}
                    {" = "} PËR PAGESË {euro(payableAmount)}
                  </div>
                </div>

                <div className="summaryList">
                  <div className="summaryRow salaryRow">
                    <span>Rroga bazë</span>
                    <strong>{euro(salaryModal.baseSalary)}</strong>
                  </div>
                  <div className="summaryRow deductRow">
                    <span>Avans personal që zbritet</span>
                    <strong>{euro(Number(salaryModal.autoDebt || 0) + Number(salaryModal.manualAdvance || 0))}</strong>
                  </div>
                  <div className="summaryRow mutedRow">
                    <span>Borxh afatgjatë informativ</span>
                    <strong>{euro(salaryModal.longTermDebt)}</strong>
                  </div>
                </div>

                <div className="warningBox">
                  ✅ Në këtë ekran nga rroga zbritet vetëm avansi personal. Ushqimi, komisioni, shpenzimet dhe borxhi informativ nuk zbriten nga rroga mujore.
                </div>

                <div className="actionStack">
                  <button className="greenCta" disabled={actionBusy} onClick={handlePaySalary}>
                    PAGUAJ RROGËN • {euro(payableAmount)}
                  </button>
                </div>
              </div>

              <div className="historyPane">
                <div className="historyTop">
                  <div className="historyTitle">Historiku Financiar</div>
                  <div className="historySub">30 veprimet e fundit</div>
                </div>

                {workerHistory.length === 0 ? (
                  <div className="historyEmpty">Nuk ka histori financiare për këtë punëtor.</div>
                ) : (
                  <div className="historyList">
                    {workerHistory.map((row) => {
                      const badge = badgeFromHistory(row);
                      return (
                        <div className="historyCard" key={row.id}>
                          <div className="historyCardTop">
                            <div className={`historyBadge ${badge.tone}`}>{badge.label}</div>
                            <div className="historyDate">{formatDateTime(row.created_at)}</div>
                          </div>
                          <div className="historyAmount">{euro(row.amount)}</div>
                          <div className="historyNote">{row.note || "Pa shënim"}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .payrollPage {
          min-height: 100vh;
          background:
            radial-gradient(circle at top left, rgba(167, 243, 208, .22), transparent 34%),
            radial-gradient(circle at top right, rgba(191, 219, 254, .28), transparent 28%),
            #f8fafc;
          color: #0f172a;
          padding: 28px 16px 40px;
          font-family: Inter, system-ui, -apple-system, sans-serif;
        }
        .shell { max-width: 1260px; margin: 0 auto; }
        .topbar {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 18px;
          flex-wrap: wrap;
          margin-bottom: 18px;
        }
        .eyebrow, .heroLabel, .modalEyebrow, .editEyebrow {
          font-size: 12px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: .16em;
          color: #64748b;
        }
        .title {
          margin: 8px 0 0;
          font-size: clamp(30px, 3vw, 44px);
          line-height: 1;
          font-weight: 900;
          letter-spacing: -.05em;
          color: #0f172a;
        }
        .subtitle {
          margin: 12px 0 0;
          color: #475569;
          font-size: 15px;
          max-width: 760px;
        }
        .topActions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .navBtn {
          text-decoration: none;
          background: rgba(255,255,255,.88);
          color: #0f172a;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 12px 16px;
          font-weight: 800;
          box-shadow: 0 4px 6px rgba(0,0,0,.05);
        }
        .primaryGhost {
          color: #0369a1;
          background: #f0f9ff;
          border-color: #bae6fd;
        }
        .hero {
          display: grid;
          grid-template-columns: 1.2fr .9fr;
          gap: 16px;
          margin-bottom: 18px;
        }
        .heroLeft, .heroRight, .editPanel, .moneyCard, .fullModal {
          background: rgba(255,255,255,.94);
          border: 1px solid rgba(226,232,240,.9);
          box-shadow: 0 10px 30px rgba(15,23,42,.05);
        }
        .heroLeft, .heroRight {
          border-radius: 28px;
          padding: 24px;
        }
        .heroValue {
          margin-top: 8px;
          font-size: 58px;
          line-height: 1;
          font-weight: 900;
          letter-spacing: -.06em;
          color: #0f172a;
        }
        .heroCaption {
          margin-top: 10px;
          color: #64748b;
          font-size: 14px;
        }
        .pinBox {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .pinBox span {
          color: #64748b;
          font-weight: 800;
          letter-spacing: .12em;
          text-transform: uppercase;
          font-size: 12px;
        }
        .pinBox input, .fieldInput, .deductBox input {
          width: 100%;
          border: 1px solid #dbe4ef;
          background: #fff;
          border-radius: 18px;
          padding: 16px;
          font-size: 16px;
          font-weight: 700;
          outline: none;
          box-sizing: border-box;
          color: #0f172a;
        }
        .editPanel {
          border-radius: 28px;
          padding: 22px;
          margin-bottom: 18px;
        }
        .editTop {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 14px;
          margin-bottom: 16px;
        }
        .editTitle {
          margin-top: 8px;
          font-size: 26px;
          font-weight: 900;
          line-height: 1.02;
          letter-spacing: -.04em;
          color: #0f172a;
        }
        .closeBtn, .editMini, .saveBtn, .payBtn, .greenCta, .amberCta {
          border: none;
          cursor: pointer;
          transition: .18s ease;
        }
        .closeBtn {
          width: 44px;
          height: 44px;
          border-radius: 14px;
          background: #f8fafc;
          color: #334155;
          border: 1px solid #e2e8f0;
          font-weight: 900;
        }
        .formGrid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 14px;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .field span, .deductBox span {
          color: #64748b;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: .12em;
          font-size: 11px;
        }
        .salaryField {
          background: #f0fdf4;
          border-color: #bbf7d0;
        }
        .warningField {
          background: #fffbeb;
          border-color: #fde68a;
        }
        .dangerField {
          background: #fff1f2;
          border-color: #fecdd3;
        }
        .editActions {
          display: flex;
          justify-content: flex-end;
          margin-top: 16px;
        }
        .saveBtn {
          min-height: 52px;
          padding: 0 18px;
          border-radius: 18px;
          background: #0f172a;
          color: #fff;
          font-weight: 900;
          box-shadow: 0 14px 24px rgba(15,23,42,.12);
        }
        .cardsGrid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }
        .moneyCard {
          border-radius: 28px;
          padding: 22px;
        }
        .moneyTop {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 18px;
        }
        .moneyNameRow {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
        }
        .moneyName {
          font-size: 24px;
          font-weight: 900;
          letter-spacing: -.04em;
          color: #0f172a;
        }
        .moneyMeta {
          color: #64748b;
          margin-top: 8px;
          font-size: 14px;
        }
        .dueBadge {
          background: #fef3c7;
          color: #92400e;
          border: 1px solid #fde68a;
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: .08em;
        }
        .editMini {
          background: #eff6ff;
          color: #1d4ed8;
          border: 1px solid #bfdbfe;
          border-radius: 14px;
          padding: 12px 14px;
          font-weight: 900;
        }
        .cardActions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .deleteMini {
          border: 1px solid rgba(239, 68, 68, 0.24);
          background: rgba(254, 242, 242, 0.96);
          color: #991b1b;
          padding: 10px 12px;
          border-radius: 999px;
          font-weight: 900;
          letter-spacing: 0.08em;
          font-size: 11px;
        }

        .moneyMetrics {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 18px;
        }
        .metric {
          border-radius: 20px;
          padding: 16px;
          border: 1px solid transparent;
        }
        .metric span {
          display: block;
          font-size: 12px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: .12em;
          margin-bottom: 10px;
        }
        .metric strong {
          font-size: 20px;
          line-height: 1;
          letter-spacing: -.04em;
          font-weight: 900;
        }
        .metric.salary {
          background: #ecfdf5;
          border-color: #bbf7d0;
          color: #166534;
        }
        .metric.debt {
          background: #fffbeb;
          border-color: #fde68a;
          color: #92400e;
        }
        .metric.longdebt {
          background: #fff1f2;
          border-color: #fecdd3;
          color: #be123c;
        }
        .moneyBottom {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          align-items: center;
          flex-wrap: wrap;
        }
        .payablePreview {
          display: flex;
          flex-direction: column;
          gap: 6px;
          color: #64748b;
          font-size: 13px;
          font-weight: 700;
        }
        .payablePreview strong {
          color: #0f172a;
          font-size: 26px;
          line-height: 1;
          font-weight: 900;
          letter-spacing: -.04em;
        }
        .payBtn {
          min-height: 54px;
          border-radius: 18px;
          background: linear-gradient(180deg, #22c55e 0%, #16a34a 100%);
          color: #fff;
          font-weight: 900;
          padding: 0 20px;
          box-shadow: 0 16px 28px rgba(34,197,94,.18);
        }
        .fullOverlay {
          position: fixed;
          inset: 0;
          background: rgba(15,23,42,.58);
          backdrop-filter: blur(8px);
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px;
        }
        .fullModal {
          width: min(1220px, 100%);
          max-height: min(94vh, 980px);
          overflow: auto;
          border-radius: 32px;
          padding: 24px;
        }
        .modalTop {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 18px;
        }
        .modalTitle {
          margin-top: 8px;
          font-size: 34px;
          line-height: 1;
          font-weight: 900;
          color: #0f172a;
          letter-spacing: -.05em;
        }
        .modalWorker {
          margin-top: 10px;
          color: #475569;
          font-size: 16px;
          font-weight: 700;
        }
        .payMainGrid {
          display: grid;
          grid-template-columns: .95fr 1.05fr;
          gap: 18px;
        }
        .paySummary, .historyPane {
          background: #fff;
          border: 1px solid #eef2f7;
          border-radius: 26px;
          padding: 20px;
        }
        .bigNumberCard {
          border-radius: 24px;
          padding: 22px;
          background: linear-gradient(180deg, #eff6ff 0%, #ffffff 100%);
          border: 1px solid #dbeafe;
          margin-bottom: 16px;
        }
        .bigNumberCard span {
          display: block;
          color: #64748b;
          font-size: 12px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: .14em;
        }
        .bigNumberCard strong {
          display: block;
          margin-top: 12px;
          font-size: clamp(42px, 4vw, 58px);
          line-height: .95;
          font-weight: 900;
          letter-spacing: -.06em;
          color: #0f172a;
        }
        .bigNumberCard small {
          display: block;
          margin-top: 12px;
          color: #64748b;
          font-size: 13px;
        }
        .summaryList {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .salaryPayoutCard {
          background: linear-gradient(180deg, #ecfdf5 0%, #ffffff 100%);
          border-color: #bbf7d0;
        }
        .salaryFormulaBox {
          border-radius: 20px;
          padding: 16px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          margin-bottom: 14px;
        }
        .salaryFormulaBox .formulaTitle {
          margin: 0 0 8px;
          color: #0f172a;
          font-weight: 1000;
        }
        .salaryFormulaBox .formulaLine {
          color: #334155;
          line-height: 1.55;
          font-weight: 900;
        }
        .summaryRow.salaryRow {
          background: #eff6ff;
          border-color: #bfdbfe;
        }
        .summaryRow.deductRow {
          background: #fff7ed;
          border-color: #fed7aa;
        }
        .summaryRow.mutedRow {
          background: #f8fafc;
          border-color: #e2e8f0;
        }
        .summaryRow {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-radius: 18px;
          padding: 16px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          color: #334155;
          font-weight: 800;
        }
        .checkRow {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 14px;
          border-radius: 18px;
          padding: 16px;
          background: #fff;
          border: 1px solid #e2e8f0;
          cursor: pointer;
        }
        .checkRow strong {
          display: block;
          color: #0f172a;
          font-size: 15px;
        }
        .checkRow small {
          display: block;
          margin-top: 4px;
          color: #64748b;
        }
        .checkRow input {
          width: 22px;
          height: 22px;
          flex: 0 0 auto;
        }
        .deductBox {
          display: flex;
          flex-direction: column;
          gap: 10px;
          border-radius: 18px;
          padding: 16px;
          background: #fff;
          border: 1px solid #e2e8f0;
        }
        .deductBox small {
          color: #64748b;
        }
        .warningBox {
          margin-top: 14px;
          border-radius: 18px;
          padding: 14px 16px;
          background: #fffbeb;
          color: #92400e;
          border: 1px solid #fde68a;
          font-size: 13px;
          line-height: 1.45;
        }
        .actionStack {
          display: flex;
          gap: 12px;
          flex-direction: column;
          margin-top: 16px;
        }
        .greenCta, .amberCta {
          min-height: 56px;
          border-radius: 18px;
          font-weight: 900;
          font-size: 15px;
        }
        .greenCta {
          background: linear-gradient(180deg, #22c55e 0%, #16a34a 100%);
          color: #fff;
          box-shadow: 0 16px 28px rgba(34,197,94,.18);
        }
        .amberCta {
          background: #fff7ed;
          color: #c2410c;
          border: 1px solid #fed7aa;
        }
        .historyTop {
          margin-bottom: 14px;
        }
        .historyTitle {
          font-size: 24px;
          font-weight: 900;
          letter-spacing: -.03em;
          color: #0f172a;
        }
        .historySub {
          margin-top: 6px;
          color: #64748b;
          font-size: 14px;
        }
        .historyList {
          display: flex;
          flex-direction: column;
          gap: 10px;
          max-height: 64vh;
          overflow: auto;
          padding-right: 4px;
        }
        .historyCard {
          border-radius: 18px;
          padding: 16px;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
        }
        .historyCardTop {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
        }
        .historyBadge {
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: .08em;
        }
        .historyBadge.green { background: #dcfce7; color: #166534; }
        .historyBadge.orange { background: #ffedd5; color: #c2410c; }
        .historyBadge.red { background: #fee2e2; color: #b91c1c; }
        .historyBadge.blue { background: #dbeafe; color: #1d4ed8; }
        .historyBadge.slate { background: #e2e8f0; color: #334155; }
        .historyDate {
          color: #64748b;
          font-size: 12px;
          font-weight: 700;
        }
        .historyAmount {
          margin-top: 10px;
          font-size: 26px;
          line-height: 1;
          font-weight: 900;
          letter-spacing: -.04em;
          color: #0f172a;
        }
        .historyNote {
          margin-top: 8px;
          color: #475569;
          font-size: 14px;
          line-height: 1.4;
        }
        .historyEmpty, .empty {
          border-radius: 24px;
          padding: 34px 18px;
          background: rgba(255,255,255,.82);
          border: 1px dashed #dbe4ef;
          color: #64748b;
          text-align: center;
          font-weight: 700;
        }
        .proPayrollPanel {
          background: linear-gradient(180deg, #0f172a 0%, #020617 100%);
          color: #f8fafc;
          border: 1px solid rgba(148, 163, 184, .24);
          border-radius: 30px;
          padding: 22px;
          margin-bottom: 18px;
          box-shadow: 0 24px 70px rgba(15, 23, 42, .18);
        }
        .proTop {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          flex-wrap: wrap;
          margin-bottom: 16px;
        }
        .proEyebrow {
          color: #93c5fd;
          font-size: 12px;
          letter-spacing: .16em;
          font-weight: 1000;
          text-transform: uppercase;
        }
        .proTitle {
          margin-top: 8px;
          font-size: clamp(28px, 3vw, 42px);
          line-height: .96;
          font-weight: 1000;
          letter-spacing: -.055em;
        }
        .proSub {
          margin-top: 10px;
          color: #cbd5e1;
          max-width: 760px;
          line-height: 1.45;
          font-weight: 650;
        }
        .payrollRules {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-top: 14px;
        }
        .payrollRules div {
          display: flex;
          align-items: center;
          gap: 10px;
          border-radius: 16px;
          padding: 12px 14px;
          background: rgba(255,255,255,.06);
          border: 1px solid rgba(147,197,253,.22);
          color: #dbeafe;
        }
        .payrollRules span {
          width: 26px;
          height: 26px;
          border-radius: 999px;
          background: #2563eb;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: #fff;
          font-weight: 1000;
          flex: 0 0 auto;
        }
        .payrollRules strong {
          font-size: 11px;
          line-height: 1.25;
          letter-spacing: .06em;
        }
        .proControls {
          display: flex;
          align-items: flex-end;
          gap: 10px;
          flex-wrap: wrap;
        }
        .proControls label {
          display: flex;
          flex-direction: column;
          gap: 7px;
          color: #cbd5e1;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: .12em;
          text-transform: uppercase;
        }
        .proControls input {
          border: 1px solid rgba(148,163,184,.32);
          background: #020617;
          color: #fff;
          border-radius: 15px;
          padding: 13px 14px;
          font-weight: 900;
          outline: none;
        }
        .proReload, .detailsBtn {
          border: none;
          cursor: pointer;
          font-weight: 1000;
        }
        .proReload {
          min-height: 46px;
          border-radius: 15px;
          padding: 0 16px;
          background: #2563eb;
          color: #fff;
        }
        .proError {
          background: rgba(239,68,68,.12);
          border: 1px solid rgba(248,113,113,.35);
          color: #fecaca;
          border-radius: 16px;
          padding: 12px 14px;
          margin-bottom: 12px;
          font-weight: 800;
        }
        .proScoreboard, .proTotals {
          display: grid;
          gap: 10px;
          margin-bottom: 14px;
        }
        .proScoreboard {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
        .proTotals {
          grid-template-columns: repeat(6, minmax(0, 1fr));
        }
        .score, .proTotals div {
          background: rgba(255,255,255,.06);
          border: 1px solid rgba(148,163,184,.18);
          border-radius: 18px;
          padding: 14px;
        }
        .score.ok { border-color: rgba(34,197,94,.35); }
        .score.blocked { border-color: rgba(239,68,68,.35); }
        .score.review { border-color: rgba(245,158,11,.35); }
        .score.paid { border-color: rgba(59,130,246,.35); }
        .score span, .proTotals span {
          display: block;
          color: #94a3b8;
          text-transform: uppercase;
          letter-spacing: .12em;
          font-size: 10px;
          font-weight: 1000;
          margin-bottom: 8px;
        }
        .score strong, .proTotals strong {
          font-size: 24px;
          line-height: 1;
          font-weight: 1000;
        }
        .proTableWrap {
          overflow: auto;
          border-radius: 20px;
          border: 1px solid rgba(148,163,184,.22);
          background: #020617;
        }
        .proTable {
          width: 100%;
          border-collapse: collapse;
          min-width: 1060px;
        }
        .proTable th, .proTable td {
          border-bottom: 1px solid rgba(148,163,184,.14);
          padding: 12px 14px;
          text-align: left;
          vertical-align: top;
          font-size: 13px;
        }
        .proTable th {
          color: #93c5fd;
          text-transform: uppercase;
          letter-spacing: .11em;
          font-size: 10px;
          font-weight: 1000;
          background: rgba(15,23,42,.9);
        }
        .proTable td small {
          display: block;
          margin-top: 4px;
          color: #94a3b8;
          font-weight: 800;
        }
        .proStatus {
          display: inline-flex;
          border-radius: 999px;
          padding: 7px 10px;
          font-size: 10px;
          font-weight: 1000;
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        .proStatus.ok { background: #dcfce7; color: #166534; }
        .proStatus.blocked { background: #fee2e2; color: #991b1b; }
        .proStatus.review { background: #fef3c7; color: #92400e; }
        .proStatus.paid { background: #dbeafe; color: #1d4ed8; }
        .proWarnings {
          margin: 8px 0 0;
          padding-left: 16px;
          color: #cbd5e1;
          line-height: 1.35;
        }
        .detailsBtn {
          min-height: 38px;
          border-radius: 12px;
          padding: 0 12px;
          background: #eff6ff;
          color: #1d4ed8;
        }
        .detailsBtn.amber {
          background: #fff7ed;
          color: #b45309;
        }
        .detailsBtn.slate {
          background: #f1f5f9;
          color: #334155;
        }
        .detailsBtn.pay {
          background: #dcfce7;
          color: #166534;
        }
        .detailsBtn:disabled,
        .payBtn:disabled {
          opacity: .45;
          cursor: not-allowed;
          filter: grayscale(.2);
        }
        .detailPayBtn {
          min-height: 46px;
        }
        .detailPayGuard {
          margin-top: 12px;
          border-radius: 16px;
          background: #fffbeb;
          border: 1px solid #fde68a;
          color: #92400e;
          padding: 12px 14px;
          font-weight: 850;
          line-height: 1.45;
        }
        .detailsBtn.amber {
          background: #fff7ed;
          color: #b45309;
        }
        .detailsBtn.slate {
          background: #f8fafc;
          color: #334155;
        }
        .proActionStack {
          display: flex;
          gap: 7px;
          flex-wrap: wrap;
        }
        .detailActions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
          margin-top: 16px;
        }
        .detailActions .advanceBtn,
        .detailActions .editMini {
          min-height: 48px;
        }
        .workerSection.paidpay {
          border-color: rgba(34, 197, 94, .18);
          background: rgba(5, 46, 22, .18);
        }
        .miniBadge.paid,
        .workerRow.paid .miniBadge {
          background: rgba(34, 197, 94, .14);
          color: #86efac;
          border-color: rgba(34, 197, 94, .26);
        }
        .workerRow.paid {
          border-color: rgba(34, 197, 94, .18);
        }
        .proMobileList { display: none; }
        .proMobileCard {
          width: 100%;
          border: 1px solid rgba(148,163,184,.22);
          background: rgba(255,255,255,.06);
          color: #fff;
          border-radius: 18px;
          padding: 14px;
          display: flex;
          justify-content: space-between;
          gap: 12px;
          text-align: left;
        }
        .proMobileCard strong, .proMobileCard b { display: block; font-size: 17px; }
        .proMobileCard small, .proMobileCard span { display: block; margin-top: 4px; color: #cbd5e1; font-size: 12px; font-weight: 800; }
        .proMobileCard.ok { border-color: rgba(34,197,94,.35); }
        .proMobileCard.blocked { border-color: rgba(239,68,68,.35); }
        .proMobileCard.review { border-color: rgba(245,158,11,.35); }
        .proMobileCard.paid { border-color: rgba(59,130,246,.35); }
        .payrollDetailModal { max-width: 1100px; }
        .detailGrid, .breakdownGrid {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 12px;
          margin-bottom: 14px;
        }
        .breakdownGrid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .detailBox, .breakdownCard, .detailFormula, .detailWarnings, .detailOk {
          border-radius: 20px;
          padding: 16px;
          border: 1px solid #e2e8f0;
          background: #fff;
        }
        .detailBox span {
          display: block;
          color: #64748b;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: .12em;
          font-weight: 1000;
          margin-bottom: 10px;
        }
        .detailBox strong {
          font-size: 28px;
          line-height: 1;
          font-weight: 1000;
          color: #0f172a;
        }
        .detailBox.good { background: #ecfdf5; border-color: #bbf7d0; }
        .detailBox.warn { background: #fffbeb; border-color: #fde68a; }
        .detailBox.main { background: #eff6ff; border-color: #bfdbfe; }
        .detailBox.danger { background: #fff1f2; border-color: #fecdd3; }
        .detailBox.paidBox { background: #eff6ff; border-color: #bfdbfe; }
        .formulaTitle, .breakdownCard h3 {
          margin: 0 0 10px;
          color: #0f172a;
          font-weight: 1000;
          letter-spacing: -.02em;
        }
        .formulaLine {
          color: #334155;
          line-height: 1.6;
          font-weight: 800;
        }
        .formulaNote {
          margin-top: 10px;
          color: #64748b;
          line-height: 1.45;
          font-size: 13px;
          font-weight: 800;
        }
        .breakdownCard p {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          margin: 10px 0 0;
          color: #475569;
          font-weight: 800;
        }
        .breakdownCard p strong { color: #0f172a; }
        .breakdownCard.deductOnly {
          background: #fff7ed;
          border-color: #fed7aa;
        }
        .breakdownCard.infoOnly {
          background: #f8fafc;
          border-color: #e2e8f0;
        }
        .breakdownCard.blockOnly {
          background: #fffbeb;
          border-color: #fde68a;
        }
        .detailWarnings {
          background: #fffbeb;
          border-color: #fde68a;
          color: #92400e;
        }
        .detailWarnings ul { margin: 10px 0 0; padding-left: 18px; }
        .detailOk {
          background: #ecfdf5;
          border-color: #bbf7d0;
          color: #166534;
          font-weight: 900;
        }

        .moneyActionStack {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          width: 100%;
          justify-content: flex-end;
        }
        .advanceBtn {
          border: 1px solid rgba(245, 158, 11, 0.24);
          background: rgba(255, 247, 237, 0.96);
          color: #b45309;
          padding: 14px 18px;
          border-radius: 16px;
          font-weight: 900;
          letter-spacing: .06em;
          font-size: 12px;
        }
        .compactModal {
          max-width: 860px;
        }
        .advanceIntro {
          margin: 14px 0 18px;
          border-radius: 18px;
          padding: 14px 16px;
          background: #fff7ed;
          border: 1px solid #fed7aa;
          color: #9a3412;
          font-weight: 700;
          line-height: 1.45;
        }
        .advanceGrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
        }
        .advanceWide {
          grid-column: 1 / -1;
        }
        .advanceHintRow {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
          margin-top: 14px;
        }
        .advanceHintCard {
          border-radius: 18px;
          padding: 16px;
          background: #eff6ff;
          border: 1px solid #bfdbfe;
          color: #1e3a8a;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .advanceHintCard span {
          font-size: 12px;
          font-weight: 900;
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        .advanceHintCard strong {
          font-size: 24px;
          line-height: 1;
          letter-spacing: -.03em;
        }
        .advanceHintCard.muted {
          background: #f8fafc;
          border-color: #e2e8f0;
          color: #334155;
        }
        .compactActions {
          margin-top: 16px;
        }
        .slimHistory {
          margin-top: 18px;
          padding: 18px;
        }
        .smallHistoryList {
          max-height: 36vh;
        }
        .monthClosePanel {
          margin: 18px 0;
          border: 1px solid rgba(148, 163, 184, 0.24);
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(2, 6, 23, 0.98));
          border-radius: 24px;
          padding: 16px;
          box-shadow: 0 18px 50px rgba(0,0,0,.28);
        }
        .monthCloseHead {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          margin-bottom: 14px;
        }
        .monthCloseTitle {
          color: #f8fafc;
          font-size: 22px;
          font-weight: 1000;
          letter-spacing: -.03em;
        }
        .monthCloseSub {
          margin-top: 5px;
          color: #94a3b8;
          font-size: 13px;
          font-weight: 800;
          line-height: 1.4;
        }
        .monthCloseStatus {
          flex: 0 0 auto;
          border-radius: 999px;
          padding: 10px 12px;
          font-size: 12px;
          font-weight: 1000;
          letter-spacing: .08em;
          text-transform: uppercase;
          border: 1px solid transparent;
        }
        .monthCloseStatus.safe {
          background: rgba(22, 163, 74, .16);
          color: #86efac;
          border-color: rgba(34, 197, 94, .32);
        }
        .monthCloseStatus.blocked {
          background: rgba(239, 68, 68, .16);
          color: #fecaca;
          border-color: rgba(248, 113, 113, .32);
        }
        .monthCloseGrid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
        }
        .monthCloseCard {
          min-height: 116px;
          border-radius: 18px;
          padding: 14px;
          border: 1px solid rgba(148, 163, 184, .18);
          background: rgba(15, 23, 42, .72);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .monthCloseCard span {
          color: #94a3b8;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: .09em;
          text-transform: uppercase;
        }
        .monthCloseCard strong {
          color: #f8fafc;
          font-size: 25px;
          line-height: 1;
          font-weight: 1000;
          letter-spacing: -.04em;
        }
        .monthCloseCard small {
          color: #cbd5e1;
          font-size: 12px;
          font-weight: 750;
          line-height: 1.35;
        }
        .monthCloseCard.good { border-color: rgba(34, 197, 94, .34); background: rgba(20, 83, 45, .42); }
        .monthCloseCard.info { border-color: rgba(59, 130, 246, .32); background: rgba(30, 58, 138, .34); }
        .monthCloseCard.warn { border-color: rgba(245, 158, 11, .38); background: rgba(120, 53, 15, .38); }
        .monthCloseCard.danger { border-color: rgba(248, 113, 113, .34); background: rgba(127, 29, 29, .34); }
        .monthCloseCard.main { border-color: rgba(14, 165, 233, .38); background: rgba(12, 74, 110, .36); }
        .monthCloseReasons, .monthCloseWarn, .monthCloseOk {
          margin-top: 12px;
          border-radius: 18px;
          padding: 13px 14px;
          font-weight: 850;
          line-height: 1.45;
        }
        .monthCloseReasons, .monthCloseWarn {
          background: rgba(127, 29, 29, .30);
          border: 1px solid rgba(248, 113, 113, .32);
          color: #fecaca;
        }
        .monthCloseOk {
          background: rgba(20, 83, 45, .34);
          border: 1px solid rgba(34, 197, 94, .32);
          color: #bbf7d0;
        }
        .monthCloseReasons ul { margin: 8px 0 0; padding-left: 18px; }
        @media (max-width: 1100px) {
          .hero, .payMainGrid, .cardsGrid, .formGrid {
            grid-template-columns: 1fr;
          }
          .cardActions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .deleteMini {
          border: 1px solid rgba(239, 68, 68, 0.24);
          background: rgba(254, 242, 242, 0.96);
          color: #991b1b;
          padding: 10px 12px;
          border-radius: 999px;
          font-weight: 900;
          letter-spacing: 0.08em;
          font-size: 11px;
        }

        .moneyMetrics {
            grid-template-columns: 1fr;
          }
        }
        @media (max-width: 640px) {
          .payrollPage { padding: 18px 12px 28px; }
          .heroLeft, .heroRight, .moneyCard, .editPanel, .fullModal {
            border-radius: 22px;
          }
          .topActions { width: 100%; }
          .navBtn { flex: 1; text-align: center; }
          .moneyBottom {
            flex-direction: column;
            align-items: stretch;
          }
          .moneyActionStack {
            flex-direction: column;
          }
          .payBtn, .advanceBtn, .saveBtn, .greenCta, .amberCta {
            width: 100%;
          }
          .advanceGrid, .advanceHintRow {
            grid-template-columns: 1fr;
          }
          .proScoreboard, .proTotals, .detailGrid, .breakdownGrid, .monthCloseGrid {
            grid-template-columns: 1fr;
          }
          .payrollRules {
            grid-template-columns: 1fr;
          }
          .proControls, .proControls label, .proControls input, .proReload {
            width: 100%;
          }
          .proTableWrap {
            display: none;
          }
          .proMobileList {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .fullOverlay {
            padding: 8px;
          }
        }


        /* UI-ONLY REDESIGN: ARKA / PAYROLL financial dashboard */
        .payrollPage {
          background:
            radial-gradient(circle at top left, rgba(37, 99, 235, .20), transparent 32%),
            radial-gradient(circle at top right, rgba(16, 185, 129, .14), transparent 28%),
            linear-gradient(180deg, #05070d 0%, #07111f 46%, #05070d 100%);
          color: #e5e7eb;
          padding: 14px 12px calc(120px + env(safe-area-inset-bottom));
        }
        .shell { max-width: 1180px; }
        .payrollHeader {
          align-items: center;
          margin-bottom: 10px;
          padding: 6px 2px 2px;
        }
        .eyebrow {
          color: #60a5fa;
          font-size: 11px;
          letter-spacing: .18em;
        }
        .title {
          color: #f8fafc;
          font-size: clamp(26px, 5vw, 38px);
          margin-top: 6px;
        }
        .subtitle {
          color: #94a3b8;
          margin-top: 4px;
          font-size: 13px;
        }
        .topActions { align-items: center; }
        .adminTools {
          margin: 0 0 12px;
          border: 1px solid rgba(59, 130, 246, .18);
          background: rgba(15, 23, 42, .58);
          border-radius: 18px;
          overflow: hidden;
        }
        .adminTools summary {
          list-style: none;
          cursor: pointer;
          padding: 12px 14px;
          color: #93c5fd;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: .16em;
          text-transform: uppercase;
        }
        .adminTools summary::-webkit-details-marker { display: none; }
        .adminToolsBody {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: end;
          padding: 0 12px 12px;
        }
        .adminPinBox {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .adminPinBox span {
          color: #94a3b8;
          font-size: 10px;
          font-weight: 1000;
          letter-spacing: .14em;
          text-transform: uppercase;
        }
        .adminPinBox input {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid rgba(148, 163, 184, .22);
          background: rgba(2, 6, 23, .72);
          color: #f8fafc;
          border-radius: 14px;
          min-height: 42px;
          padding: 0 12px;
          font-weight: 1000;
          outline: none;
        }
        .staffManageLink {
          min-height: 42px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          text-decoration: none;
          border-radius: 14px;
          padding: 0 12px;
          background: rgba(37, 99, 235, .18);
          border: 1px solid rgba(96, 165, 250, .28);
          color: #bfdbfe;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: .08em;
          white-space: nowrap;
        }
        .navBtn, .refreshBtn {
          border: 1px solid rgba(148, 163, 184, .22);
          background: rgba(15, 23, 42, .86);
          color: #f8fafc;
          box-shadow: none;
          border-radius: 14px;
          padding: 11px 14px;
          font-size: 12px;
          letter-spacing: .07em;
          text-transform: uppercase;
        }
        .refreshBtn {
          cursor: pointer;
          color: #bfdbfe;
          border-color: rgba(59, 130, 246, .36);
        }
        .financeDashboard {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .heroStatus {
          position: relative;
          overflow: hidden;
          border-radius: 22px;
          padding: 15px;
          border: 1px solid rgba(148, 163, 184, .20);
          background: linear-gradient(135deg, rgba(15, 23, 42, .97), rgba(2, 6, 23, .96));
          box-shadow: 0 22px 70px rgba(0,0,0,.36);
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 9px 12px;
          align-items: start;
        }
        .heroStatus.safe { border-color: rgba(34, 197, 94, .42); }
        .heroStatus.blocked { border-color: rgba(248, 113, 113, .44); }
        .heroStatus span {
          display: block;
          color: #93c5fd;
          font-weight: 950;
          font-size: 11px;
          letter-spacing: .16em;
          text-transform: uppercase;
        }
        .heroStatus h2 {
          margin: 8px 0 0;
          color: #f8fafc;
          font-size: clamp(25px, 6.2vw, 42px);
          line-height: .95;
          letter-spacing: -.06em;
          font-weight: 1000;
        }
        .heroStatus p {
          margin: 8px 0 0;
          color: #cbd5e1;
          font-size: 14px;
          font-weight: 850;
        }
        .statusPill, .miniBadge {
          border-radius: 999px;
          padding: 6px 9px;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: .08em;
          text-transform: uppercase;
          border: 1px solid transparent;
          white-space: nowrap;
        }
        .statusPill.safe, .miniBadge.ok, .miniBadge.paid {
          background: rgba(22, 163, 74, .18);
          color: #86efac;
          border-color: rgba(34, 197, 94, .34);
        }
        .statusPill.blocked, .miniBadge.blocked {
          background: rgba(239, 68, 68, .18);
          color: #fecaca;
          border-color: rgba(248, 113, 113, .34);
        }
        .miniBadge.review {
          background: rgba(245, 158, 11, .18);
          color: #fde68a;
          border-color: rgba(245, 158, 11, .36);
        }
        .heroReasons {
          grid-column: 1 / -1;
          display: grid;
          gap: 5px;
          margin-top: 0;
        }
        .heroReasons small {
          color: #cbd5e1;
          background: rgba(15, 23, 42, .76);
          border: 1px solid rgba(148, 163, 184, .16);
          border-radius: 14px;
          padding: 7px 10px;
          font-weight: 800;
          line-height: 1.35;
        }
        .monthControlStrip {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          align-items: center;
          border: 1px solid rgba(148, 163, 184, .18);
          background: rgba(15, 23, 42, .70);
          border-radius: 16px;
          padding: 8px 10px;
        }
        .monthControlStrip label, .monthControlStrip > div {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .monthControlStrip span {
          color: #94a3b8;
          font-size: 10px;
          font-weight: 1000;
          letter-spacing: .12em;
          text-transform: uppercase;
        }
        .monthControlStrip strong { color: #bfdbfe; font-size: 13px; }
        .monthControlStrip input {
          border: 1px solid rgba(148, 163, 184, .24);
          background: #020617;
          color: #f8fafc;
          border-radius: 12px;
          padding: 9px 10px;
          font-weight: 850;
        }
        .primaryMoneyGrid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
        }
        .secondaryMoneyGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .moneyTile, .smallTile {
          border-radius: 18px;
          padding: 12px;
          border: 1px solid rgba(148, 163, 184, .18);
          background: rgba(15, 23, 42, .78);
          min-height: 86px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 6px;
        }
        .smallTile { min-height: 70px; padding: 10px 11px; border-radius: 16px; }
        .moneyTile span, .smallTile span {
          color: #94a3b8;
          font-size: 10px;
          font-weight: 1000;
          letter-spacing: .11em;
          text-transform: uppercase;
        }
        .moneyTile strong {
          color: #f8fafc;
          font-size: clamp(23px, 4.4vw, 32px);
          line-height: 1;
          letter-spacing: -.05em;
          font-weight: 1000;
        }
        .smallTile strong {
          color: #f8fafc;
          font-size: 20px;
          line-height: 1;
          font-weight: 1000;
          letter-spacing: -.04em;
        }
        .moneyTile small, .smallTile small { color: #cbd5e1; font-size: 11px; font-weight: 760; line-height: 1.25; }
        .moneyTile.good, .smallTile.good { border-color: rgba(34,197,94,.32); background: linear-gradient(180deg, rgba(20,83,45,.40), rgba(15,23,42,.78)); }
        .moneyTile.info, .smallTile.info { border-color: rgba(59,130,246,.32); background: linear-gradient(180deg, rgba(30,64,175,.36), rgba(15,23,42,.78)); }
        .moneyTile.warn, .smallTile.warn { border-color: rgba(245,158,11,.34); background: linear-gradient(180deg, rgba(120,53,15,.38), rgba(15,23,42,.78)); }
        .moneyTile.danger, .smallTile.danger { border-color: rgba(248,113,113,.32); background: linear-gradient(180deg, rgba(127,29,29,.34), rgba(15,23,42,.78)); }
        .workerSection {
          border: 1px solid rgba(148, 163, 184, .18);
          background: rgba(15, 23, 42, .62);
          border-radius: 18px;
          padding: 10px;
        }
        .workerSection.blockers { border-color: rgba(248,113,113,.28); }
        .workerSection.okpay { border-color: rgba(34,197,94,.22); }
        .workerSection.reviewpay { border-color: rgba(245,158,11,.22); }
        .workerSection.paidpay { border-color: rgba(34,197,94,.22); background: rgba(5,46,22,.16); }
        .sectionHead {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 7px;
        }
        .sectionHead h3 {
          margin: 0;
          color: #f8fafc;
          font-size: 13px;
          letter-spacing: .12em;
          text-transform: uppercase;
          font-weight: 1000;
        }
        .sectionHead span {
          min-width: 32px;
          text-align: center;
          border-radius: 999px;
          padding: 5px 8px;
          background: rgba(15,23,42,.90);
          border: 1px solid rgba(148,163,184,.18);
          color: #cbd5e1;
          font-weight: 1000;
          font-size: 12px;
        }
        .workerList { display: grid; gap: 8px; }
        .workerRow {
          width: 100%;
          border: 1px solid rgba(148, 163, 184, .16);
          background: rgba(2, 6, 23, .64);
          color: #f8fafc;
          border-radius: 16px;
          padding: 12px 14px;
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 4px 12px;
          text-align: left;
          cursor: pointer;
        }
        .workerRow.blocked { border-color: rgba(248,113,113,.28); }
        .workerRow.ok { border-color: rgba(34,197,94,.22); }
        .workerRow.review { border-color: rgba(245,158,11,.25); }
        .workerLeft, .workerRight { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .workerLeft strong { font-size: 17px; line-height: 1.15; overflow-wrap: anywhere; }
        .workerLeft small { color: #94a3b8; font-size: 12px; font-weight: 850; line-height: 1.2; }
        .workerRight { align-items: flex-end; text-align: right; }
        .workerRight b { font-size: 19px; line-height: 1.05; letter-spacing: -.03em; white-space: nowrap; }
        .workerRow em {
          grid-column: 1 / -1;
          color: #cbd5e1;
          font-style: normal;
          font-size: 12px;
          line-height: 1.3;
          background: rgba(15,23,42,.74);
          border-radius: 11px;
          padding: 6px 8px;
        }
        .emptyCompact {
          color: #94a3b8;
          border: 1px dashed rgba(148,163,184,.22);
          border-radius: 14px;
          padding: 12px;
          font-weight: 800;
          font-size: 13px;
        }
        .calcDetails {
          border: 1px solid rgba(59,130,246,.24);
          background: rgba(15,23,42,.58);
          color: #dbeafe;
          border-radius: 18px;
          padding: 12px;
        }
        .calcDetails summary {
          cursor: pointer;
          font-size: 12px;
          font-weight: 1000;
          letter-spacing: .11em;
          text-transform: uppercase;
        }
        .calcGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
          margin-top: 12px;
        }
        .calcGrid div {
          border: 1px solid rgba(148,163,184,.16);
          background: rgba(2,6,23,.54);
          border-radius: 14px;
          padding: 10px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .calcGrid span { color: #94a3b8; font-size: 11px; font-weight: 900; }
        .calcGrid strong { color: #f8fafc; font-size: 16px; }
        .calcDetails p { color: #94a3b8; font-size: 13px; line-height: 1.42; margin: 10px 0 0; }
        .fullOverlay {
          background: rgba(2,6,23,.82);
          backdrop-filter: blur(10px);
        }
        .fullModal, .editPanel, .historyPane, .paySummary {
          background: linear-gradient(180deg, rgba(15,23,42,.98), rgba(2,6,23,.98)) !important;
          color: #f8fafc !important;
          border: 1px solid rgba(148,163,184,.20) !important;
          box-shadow: 0 24px 90px rgba(0,0,0,.55) !important;
        }
        .modalTitle, .editTitle, .historyTitle, .formulaTitle, .breakdownCard h3 { color: #f8fafc !important; }
        .modalWorker, .modalEyebrow, .historySub, .formulaNote { color: #94a3b8 !important; }
        .detailBox, .breakdownCard, .salaryFormulaBox, .summaryRow, .warningBox, .advanceIntro, .advanceHintCard, .historyCard {
          background: rgba(15,23,42,.76) !important;
          border-color: rgba(148,163,184,.18) !important;
          color: #e5e7eb !important;
        }
        .detailBox strong, .breakdownCard strong, .summaryRow strong, .historyAmount { color: #f8fafc !important; }
        .detailBox span, .breakdownCard span, .summaryRow span, .historyNote, .formulaLine { color: #cbd5e1 !important; }
        .closeBtn {
          background: rgba(15,23,42,.95) !important;
          color: #f8fafc !important;
          border: 1px solid rgba(148,163,184,.24) !important;
        }
        .proError {
          border-radius: 16px;
          border: 1px solid rgba(248,113,113,.30);
          background: rgba(127,29,29,.28);
          color: #fecaca;
          padding: 11px 12px;
          font-weight: 850;
        }
        @media (max-width: 860px) {
          .primaryMoneyGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .secondaryMoneyGrid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          .calcGrid { grid-template-columns: 1fr; }
          .heroStatus { grid-template-columns: 1fr auto; }
          .statusPill { width: fit-content; }
          .primaryMoneyGrid .moneyTile:nth-child(4) { grid-column: 1 / -1; }
        }
        @media (max-width: 640px) {
          .payrollPage { padding: 10px 9px calc(120px + env(safe-area-inset-bottom)); }
          .payrollHeader { gap: 10px; }
          .topActions { width: 100%; display: grid; grid-template-columns: 1fr 1fr; }
          .adminToolsBody { grid-template-columns: 1fr; }
          .staffManageLink { width: 100%; box-sizing: border-box; }
          .navBtn, .refreshBtn { width: 100%; text-align: center; padding: 11px 10px; }
          .heroStatus { border-radius: 20px; padding: 13px; }
          .heroStatus h2 { font-size: 28px; }
          .primaryMoneyGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .secondaryMoneyGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .secondaryMoneyGrid .smallTile:nth-child(3) { grid-column: 1 / -1; }
          .moneyTile { min-height: 78px; padding: 11px; }
          .smallTile { min-height: 62px; }
          .moneyTile strong { font-size: 25px; }
          .smallTile strong { font-size: 19px; }
          .workerRow { grid-template-columns: minmax(0, 1fr) auto; padding: 11px 12px; }
          .workerLeft strong { font-size: 16px; }
          .workerRight b { font-size: 18px; }
        }
      `}</style>

      <style jsx global>{`
        .payrollPage .workerList {
          display: grid;
          gap: 8px;
        }

        .payrollPage .workerRow {
          all: unset;
          box-sizing: border-box;
          width: 100%;
          border: 1px solid rgba(148, 163, 184, .18);
          background: rgba(15, 23, 42, .72);
          color: #f8fafc;
          border-radius: 16px;
          padding: 12px 14px;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 4px 12px;
          align-items: center;
          cursor: pointer;
        }

        .payrollPage .workerRow.blocked {
          border-color: rgba(248,113,113,.35);
        }

        .payrollPage .workerRow.ok {
          border-color: rgba(34,197,94,.30);
        }

        .payrollPage .workerRow.review {
          border-color: rgba(245,158,11,.32);
        }

        .payrollPage .workerRow.paid {
          border-color: rgba(34, 197, 94, .30);
        }

        .payrollPage .workerLeft {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
          text-align: left;
        }

        .payrollPage .workerLeft strong {
          display: block;
          font-size: 17px;
          line-height: 1.15;
          font-weight: 950;
          overflow-wrap: anywhere;
        }

        .payrollPage .workerLeft small {
          display: block;
          color: #94a3b8;
          font-size: 12px;
          line-height: 1.2;
          font-weight: 850;
        }

        .payrollPage .workerRight {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
          text-align: right;
        }

        .payrollPage .workerRight b {
          display: block;
          font-size: 19px;
          line-height: 1.05;
          font-weight: 1000;
          letter-spacing: -.03em;
          white-space: nowrap;
        }

        .payrollPage .miniBadge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          padding: 5px 8px;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: .08em;
          text-transform: uppercase;
          white-space: nowrap;
          border: 1px solid transparent;
        }

        .payrollPage .miniBadge.blocked {
          background: rgba(239, 68, 68, .18);
          color: #fecaca;
          border-color: rgba(248, 113, 113, .34);
        }

        .payrollPage .miniBadge.ok,
        .payrollPage .miniBadge.paid {
          background: rgba(22, 163, 74, .18);
          color: #86efac;
          border-color: rgba(34, 197, 94, .34);
        }

        .payrollPage .miniBadge.review {
          background: rgba(245, 158, 11, .18);
          color: #fde68a;
          border-color: rgba(245, 158, 11, .36);
        }

        .payrollPage .workerRow em {
          grid-column: 1 / -1;
          display: block;
          margin-top: 2px;
          color: #cbd5e1;
          font-style: normal;
          font-size: 12px;
          line-height: 1.3;
          background: rgba(2, 6, 23, .40);
          border-radius: 10px;
          padding: 6px 8px;
          text-align: left;
        }



        .payrollPage .payrollDetailModal {
          width: min(760px, calc(100vw - 18px));
          max-height: min(92vh, 900px);
          overflow: auto;
          border-radius: 24px;
          padding: 16px;
          background: linear-gradient(180deg, rgba(15, 23, 42, .98), rgba(2, 6, 23, .98)) !important;
          border: 1px solid rgba(148, 163, 184, .22) !important;
          box-shadow: 0 24px 80px rgba(0,0,0,.58) !important;
        }

        .payrollPage .payrollDetailModal .modalTop {
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 12px;
          padding-bottom: 12px;
          border-bottom: 1px solid rgba(148, 163, 184, .14);
        }

        .payrollPage .payrollDetailModal .modalEyebrow {
          color: #93c5fd !important;
          font-size: 10px;
          line-height: 1.1;
          font-weight: 1000;
          letter-spacing: .16em;
          text-transform: uppercase;
        }

        .payrollPage .payrollDetailModal .modalTitle {
          margin-top: 6px;
          color: #f8fafc !important;
          font-size: clamp(23px, 5vw, 32px);
          line-height: 1.05;
          font-weight: 1000;
          letter-spacing: -.045em;
        }

        .payrollPage .payrollDetailModal .modalWorker {
          margin-top: 6px;
          color: #94a3b8 !important;
          font-size: 13px;
          line-height: 1.2;
          font-weight: 850;
        }

        .payrollPage .payrollDetailModal .closeBtn {
          width: 38px;
          height: 38px;
          min-width: 38px;
          border-radius: 14px;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(15, 23, 42, .96) !important;
          color: #f8fafc !important;
          border: 1px solid rgba(148, 163, 184, .24) !important;
          font-size: 15px;
          font-weight: 1000;
        }

        .payrollPage .payrollDetailModal .detailGrid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 10px;
        }

        .payrollPage .payrollDetailModal .detailBox {
          min-height: auto;
          border-radius: 18px;
          padding: 14px 15px;
          background: rgba(15, 23, 42, .72) !important;
          border: 1px solid rgba(148, 163, 184, .18) !important;
          color: #e5e7eb !important;
        }

        .payrollPage .payrollDetailModal .detailBox span {
          display: block;
          color: #94a3b8 !important;
          font-size: 11px;
          line-height: 1.15;
          font-weight: 1000;
          letter-spacing: .11em;
          text-transform: uppercase;
          margin: 0 0 8px;
        }

        .payrollPage .payrollDetailModal .detailBox strong {
          display: block;
          color: #f8fafc !important;
          font-size: clamp(27px, 7vw, 34px);
          line-height: .98;
          font-weight: 1000;
          letter-spacing: -.055em;
          white-space: nowrap;
        }

        .payrollPage .payrollDetailModal .detailBox.good { border-color: rgba(34, 197, 94, .30) !important; }
        .payrollPage .payrollDetailModal .detailBox.warn { border-color: rgba(245, 158, 11, .34) !important; }
        .payrollPage .payrollDetailModal .detailBox.main { border-color: rgba(59, 130, 246, .34) !important; }
        .payrollPage .payrollDetailModal .detailBox.paidBox { border-color: rgba(148, 163, 184, .22) !important; }

        .payrollPage .payrollDetailModal .detailFormula {
          border-radius: 18px;
          padding: 14px 15px;
          margin-bottom: 10px;
          background: rgba(2, 6, 23, .46) !important;
          border: 1px solid rgba(148, 163, 184, .18) !important;
          color: #e5e7eb !important;
        }

        .payrollPage .payrollDetailModal .formulaTitle {
          margin: 0 0 7px;
          color: #93c5fd !important;
          font-size: 11px;
          line-height: 1.2;
          font-weight: 1000;
          letter-spacing: .14em;
          text-transform: uppercase;
        }

        .payrollPage .payrollDetailModal .formulaLine {
          color: #e5e7eb !important;
          font-size: 14px;
          line-height: 1.35;
          font-weight: 900;
        }

        .payrollPage .payrollDetailModal .formulaNote {
          margin-top: 8px;
          color: #cbd5e1 !important;
          font-size: 13px;
          line-height: 1.35;
          font-weight: 750;
        }

        .payrollPage .payrollDetailModal .breakdownGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-bottom: 10px;
        }

        .payrollPage .payrollDetailModal .breakdownCard {
          border-radius: 18px;
          padding: 13px 14px;
          background: rgba(15, 23, 42, .64) !important;
          border: 1px solid rgba(148, 163, 184, .18) !important;
          color: #e5e7eb !important;
        }

        .payrollPage .payrollDetailModal .breakdownCard.infoOnly { border-color: rgba(59, 130, 246, .25) !important; }
        .payrollPage .payrollDetailModal .breakdownCard.deductOnly { border-color: rgba(245, 158, 11, .30) !important; }
        .payrollPage .payrollDetailModal .breakdownCard.blockOnly { border-color: rgba(248, 113, 113, .28) !important; }

        .payrollPage .payrollDetailModal .breakdownCard h3 {
          margin: 0 0 8px;
          color: #f8fafc !important;
          font-size: 11px;
          line-height: 1.2;
          font-weight: 1000;
          letter-spacing: .1em;
          text-transform: uppercase;
        }

        .payrollPage .payrollDetailModal .breakdownCard p {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          margin: 7px 0 0;
          color: #cbd5e1 !important;
          font-size: 12px;
          line-height: 1.25;
          font-weight: 800;
        }

        .payrollPage .payrollDetailModal .breakdownCard p strong {
          color: #f8fafc !important;
          font-size: 13px;
          font-weight: 1000;
          text-align: right;
          white-space: nowrap;
        }

        .payrollPage .payrollDetailModal .workerCashDeliverySection {
          border-radius: 18px;
          padding: 13px 14px;
          margin: 10px 0 0;
          background: rgba(2, 6, 23, .46) !important;
          border: 1px solid rgba(248, 113, 113, .24) !important;
          color: #e5e7eb !important;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryHead {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 10px;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryHead h3 {
          margin: 0;
          color: #f8fafc !important;
          font-size: 11px;
          line-height: 1.2;
          font-weight: 1000;
          letter-spacing: .1em;
          text-transform: uppercase;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryHead p {
          margin: 5px 0 0;
          color: #94a3b8;
          font-size: 12px;
          line-height: 1.3;
          font-weight: 800;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryHead strong {
          color: #fecaca;
          font-size: 22px;
          line-height: 1;
          font-weight: 1000;
          white-space: nowrap;
        }

        .payrollPage .payrollDetailModal .hybridCashSummary {
          display: grid;
          gap: 7px;
          margin: 0 0 10px;
          padding: 10px 11px;
          border-radius: 14px;
          background: rgba(20, 83, 45, .18);
          border: 1px solid rgba(34, 197, 94, .24);
        }

        .payrollPage .payrollDetailModal .hybridCashSummary h3 {
          margin: 0 0 2px;
          color: #bbf7d0;
          font-size: 11px;
          line-height: 1.2;
          font-weight: 1000;
          letter-spacing: .08em;
          text-transform: uppercase;
        }

        .payrollPage .payrollDetailModal .hybridCashSummary p {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          margin: 0;
          color: #cbd5e1;
          font-size: 12px;
          line-height: 1.25;
          font-weight: 850;
        }

        .payrollPage .payrollDetailModal .hybridCashSummary p strong {
          color: #f8fafc;
          font-size: 13px;
          font-weight: 1000;
          text-align: right;
          white-space: nowrap;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryList {
          display: grid;
          gap: 8px;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryRow {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 10px;
          align-items: center;
          padding: 10px 11px;
          border-radius: 14px;
          background: rgba(15, 23, 42, .72);
          border: 1px solid rgba(148, 163, 184, .16);
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMain {
          min-width: 0;
          display: grid;
          gap: 3px;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMain strong {
          color: #f8fafc;
          font-size: 14px;
          line-height: 1.15;
          font-weight: 1000;
          overflow-wrap: anywhere;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMain span {
          color: #cbd5e1;
          font-size: 12px;
          line-height: 1.25;
          font-weight: 800;
          overflow-wrap: anywhere;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMeta {
          display: grid;
          gap: 3px;
          justify-items: end;
          text-align: right;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryRow.hybrid {
          align-items: flex-start;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMeta b {
          color: #f8fafc;
          font-size: 15px;
          line-height: 1;
          font-weight: 1000;
          white-space: nowrap;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMeta.hybridMeta {
          min-width: 205px;
          gap: 5px;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMeta.hybridMeta p {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          width: 100%;
          margin: 0;
          color: #cbd5e1;
          font-size: 11px;
          line-height: 1.15;
          font-weight: 850;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMeta.hybridMeta p span {
          color: #94a3b8;
          font-size: 11px;
          line-height: 1.15;
          font-weight: 850;
          text-align: left;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMeta.hybridMeta p b {
          color: #f8fafc;
          font-size: 12px;
          line-height: 1.15;
          font-weight: 1000;
          white-space: nowrap;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryMeta span,
        .payrollPage .payrollDetailModal .workerCashDeliveryMeta small {
          color: #94a3b8;
          font-size: 11px;
          line-height: 1.15;
          font-weight: 850;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryEmpty {
          border-radius: 14px;
          padding: 11px;
          border: 1px dashed rgba(148, 163, 184, .24);
          color: #94a3b8;
          font-size: 13px;
          line-height: 1.3;
          font-weight: 850;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryTotal {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid rgba(148, 163, 184, .14);
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryTotal span {
          color: #fecaca;
          font-size: 11px;
          line-height: 1.2;
          font-weight: 1000;
          letter-spacing: .08em;
          text-transform: uppercase;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryTotal strong {
          color: #f8fafc;
          font-size: 18px;
          line-height: 1;
          font-weight: 1000;
          white-space: nowrap;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryTotal.hybridTotals {
          display: grid;
          gap: 7px;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryTotal.hybridTotals p {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          margin: 0;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryTotal.hybridTotals p span {
          color: #fecaca;
          font-size: 11px;
          line-height: 1.2;
          font-weight: 1000;
          letter-spacing: .08em;
          text-transform: uppercase;
        }

        .payrollPage .payrollDetailModal .workerCashDeliveryTotal.hybridTotals p strong {
          color: #f8fafc;
          font-size: 16px;
          line-height: 1;
          font-weight: 1000;
          white-space: nowrap;
        }

        .payrollPage .payrollDetailModal .detailWarnings,
        .payrollPage .payrollDetailModal .detailOk,
        .payrollPage .payrollDetailModal .detailPayGuard {
          border-radius: 16px;
          padding: 12px 13px;
          margin-top: 10px;
          font-size: 13px;
          line-height: 1.35;
          font-weight: 850;
        }

        .payrollPage .payrollDetailModal .detailWarnings {
          background: rgba(127, 29, 29, .22) !important;
          border: 1px solid rgba(248, 113, 113, .30) !important;
          color: #fecaca !important;
        }

        .payrollPage .payrollDetailModal .detailWarnings strong {
          display: block;
          color: #fee2e2;
          font-size: 13px;
          font-weight: 1000;
        }

        .payrollPage .payrollDetailModal .detailWarnings ul {
          margin: 7px 0 0;
          padding-left: 16px;
        }

        .payrollPage .payrollDetailModal .detailWarnings li { margin: 3px 0; }

        .payrollPage .payrollDetailModal .detailOk {
          background: rgba(5, 46, 22, .26) !important;
          border: 1px solid rgba(34, 197, 94, .28) !important;
          color: #bbf7d0 !important;
        }

        .payrollPage .payrollDetailModal .detailPayGuard {
          background: rgba(245, 158, 11, .12) !important;
          border: 1px solid rgba(245, 158, 11, .28) !important;
          color: #fde68a !important;
        }

        .payrollPage .payrollDetailModal .detailActions {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 9px;
          margin-top: 12px;
        }

        .payrollPage .payrollDetailModal .detailActions button {
          width: 100%;
          min-height: 42px;
          border-radius: 14px;
          padding: 10px 12px;
          font-size: 12px;
          line-height: 1.15;
          font-weight: 1000;
          letter-spacing: .02em;
          text-align: center;
        }

        .payrollPage .payrollDetailModal .detailActions .detailPayBtn {
          grid-column: 1 / -1;
          min-height: 44px;
          background: rgba(22, 163, 74, .18);
          color: #bbf7d0;
          border: 1px solid rgba(34, 197, 94, .28);
        }

        .payrollPage .payrollDetailModal .detailActions .detailPayBtn:disabled {
          opacity: .46;
          cursor: not-allowed;
          filter: grayscale(.25);
        }

        @media (max-width: 680px) {
          .payrollPage .payrollDetailModal {
            width: min(100%, calc(100vw - 14px));
            max-height: 91vh;
            padding: 13px;
            border-radius: 22px;
          }

          .payrollPage .payrollDetailModal .modalTop {
            margin-bottom: 10px;
            padding-bottom: 10px;
          }

          .payrollPage .payrollDetailModal .detailGrid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 8px;
          }

          .payrollPage .payrollDetailModal .detailBox {
            padding: 12px;
            border-radius: 16px;
          }

          .payrollPage .payrollDetailModal .detailBox span {
            font-size: 10px;
            margin-bottom: 7px;
          }

          .payrollPage .payrollDetailModal .detailBox strong {
            font-size: clamp(24px, 8vw, 30px);
          }

          .payrollPage .payrollDetailModal .breakdownGrid {
            grid-template-columns: 1fr;
            gap: 8px;
          }

          .payrollPage .payrollDetailModal .workerCashDeliveryHead,
          .payrollPage .payrollDetailModal .workerCashDeliveryRow,
          .payrollPage .payrollDetailModal .workerCashDeliveryTotal {
            grid-template-columns: 1fr;
            align-items: stretch;
          }

          .payrollPage .payrollDetailModal .workerCashDeliveryMeta {
            justify-items: start;
            text-align: left;
          }

          .payrollPage .payrollDetailModal .workerCashDeliveryTotal {
            display: grid;
          }

          .payrollPage .payrollDetailModal .detailActions {
            grid-template-columns: 1fr;
          }

          .payrollPage .payrollDetailModal .detailActions .detailPayBtn {
            grid-column: auto;
          }
        }


        .payrollPage .adminCashSection {
          overflow: visible;
        }

        .payrollPage .adminCashSummaryCard {
          width: 100%;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin: 10px 0;
          padding: 14px;
          border-radius: 18px;
          border: 1px solid rgba(245, 158, 11, .30);
          background: linear-gradient(135deg, rgba(245, 158, 11, .16), rgba(15, 23, 42, .92));
          color: #f8fafc;
          text-align: left;
          cursor: pointer;
        }

        .payrollPage .adminCashSummaryCard span {
          display: block;
          font-size: 11px;
          color: #fde68a;
          font-weight: 1000;
          letter-spacing: .08em;
        }

        .payrollPage .adminCashSummaryCard strong {
          display: block;
          margin-top: 5px;
          font-size: 26px;
          line-height: 1;
          font-weight: 1000;
        }

        .payrollPage .adminCashSummaryCard small {
          display: block;
          margin-top: 6px;
          color: #cbd5e1;
          font-size: 12px;
          font-weight: 850;
        }

        .payrollPage .adminCashSummaryCard b {
          flex: 0 0 auto;
          border-radius: 999px;
          padding: 11px 13px;
          background: rgba(15, 23, 42, .78);
          border: 1px solid rgba(255, 255, 255, .14);
          color: #fff7ed;
          font-size: 12px;
          font-weight: 1000;
          white-space: nowrap;
        }

        .payrollPage .adminCashDetailsPanel {
          margin-top: 12px;
          border-radius: 18px;
          border: 1px solid rgba(148, 163, 184, .20);
          background: rgba(2, 6, 23, .54);
          padding: 12px;
        }

        .payrollPage .adminCashDetailsHead {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 10px;
          margin-bottom: 10px;
          color: #e2e8f0;
        }

        .payrollPage .adminCashDetailsHead strong {
          font-size: 14px;
          font-weight: 1000;
          text-transform: uppercase;
        }

        .payrollPage .adminCashDetailsHead small {
          color: #94a3b8;
          font-size: 11px;
          font-weight: 800;
          text-align: right;
        }


        .payrollPage .adminCashClassSummaryGrid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 10px;
        }

        .payrollPage .adminCashClassSummary {
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, .18);
          background: rgba(15, 23, 42, .70);
          padding: 10px;
        }

        .payrollPage .adminCashClassSummary span {
          display: block;
          color: #94a3b8;
          font-size: 10px;
          font-weight: 1000;
          letter-spacing: .06em;
          text-transform: uppercase;
        }

        .payrollPage .adminCashClassSummary strong {
          display: block;
          margin-top: 5px;
          color: #f8fafc;
          font-size: 17px;
          font-weight: 1000;
        }

        .payrollPage .adminCashClassSummary small {
          display: block;
          margin-top: 4px;
          color: #cbd5e1;
          font-size: 11px;
          font-weight: 850;
        }

        .payrollPage .adminCashClassSummary.real_candidate { border-color: rgba(34, 197, 94, .30); }
        .payrollPage .adminCashClassSummary.test { border-color: rgba(239, 68, 68, .38); }
        .payrollPage .adminCashClassSummary.suspicious { border-color: rgba(245, 158, 11, .40); }
        .payrollPage .adminCashClassSummary.excluded { border-color: rgba(59, 130, 246, .35); }

        .payrollPage .adminCashFilterChips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin: 0 0 10px;
        }

        .payrollPage .adminCashFilterChips button {
          border: 1px solid rgba(148, 163, 184, .24);
          background: rgba(15, 23, 42, .76);
          color: #cbd5e1;
          border-radius: 999px;
          padding: 9px 11px;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: .04em;
        }

        .payrollPage .adminCashFilterChips button.active {
          border-color: rgba(252, 211, 77, .70);
          background: rgba(245, 158, 11, .20);
          color: #fef3c7;
        }

        .payrollPage .adminCashClassBadge {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 6px 8px;
          font-size: 10px;
          font-weight: 1000;
          letter-spacing: .04em;
          border: 1px solid rgba(148, 163, 184, .22);
          background: rgba(15, 23, 42, .80);
          color: #e2e8f0;
          white-space: nowrap;
        }

        .payrollPage .adminCashClassBadge.real {
          border-color: rgba(34, 197, 94, .35);
          color: #bbf7d0;
        }

        .payrollPage .adminCashClassBadge.test {
          border-color: rgba(239, 68, 68, .45);
          color: #fecaca;
        }

        .payrollPage .adminCashClassBadge.suspicious {
          border-color: rgba(245, 158, 11, .45);
          color: #fde68a;
        }

        .payrollPage .adminCashClassBadge.excluded {
          border-color: rgba(59, 130, 246, .45);
          color: #bfdbfe;
        }


        .payrollPage .adminCashMarkMessage {
          border: 1px solid rgba(59, 130, 246, .30);
          background: rgba(15, 23, 42, .72);
          color: #dbeafe;
          border-radius: 14px;
          padding: 10px 12px;
          font-size: 12px;
          font-weight: 900;
          margin-bottom: 10px;
        }

        .payrollPage .adminCashMarkBtn {
          border: 1px solid rgba(239, 68, 68, .45);
          background: rgba(127, 29, 29, .50);
          color: #fee2e2;
          border-radius: 12px;
          padding: 9px 10px;
          font-size: 11px;
          font-weight: 1000;
          cursor: pointer;
          white-space: nowrap;
        }

        .payrollPage .adminCashMarkBtn:disabled {
          opacity: .55;
          cursor: wait;
        }

        .payrollPage .adminCashExcludedNote {
          display: inline-flex;
          border: 1px solid rgba(59, 130, 246, .35);
          background: rgba(59, 130, 246, .14);
          color: #bfdbfe;
          border-radius: 999px;
          padding: 6px 9px;
          font-size: 10px;
          font-weight: 1000;
          white-space: nowrap;
        }

        @media (max-width: 760px) {
          .payrollPage .adminCashClassSummaryGrid {
            grid-template-columns: 1fr 1fr;
          }
        }

        .payrollPage .adminCashTableWrap {
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, .16);
        }

        .payrollPage .adminCashTable {
          width: 100%;
          min-width: 1080px;
          border-collapse: collapse;
          background: rgba(15, 23, 42, .72);
          color: #e5e7eb;
          font-size: 12px;
        }

        .payrollPage .adminCashTable th,
        .payrollPage .adminCashTable td {
          padding: 10px 9px;
          border-bottom: 1px solid rgba(148, 163, 184, .12);
          text-align: left;
          vertical-align: top;
          white-space: nowrap;
        }

        .payrollPage .adminCashTable th {
          color: #fcd34d;
          font-size: 10px;
          letter-spacing: .07em;
          text-transform: uppercase;
          background: rgba(2, 6, 23, .70);
        }

        .payrollPage .adminCashTable td:nth-child(10) {
          white-space: normal;
          min-width: 180px;
          color: #cbd5e1;
        }

        .payrollPage .shell {
          padding-bottom: max(140px, calc(140px + env(safe-area-inset-bottom)));
        }

        @media (max-width: 520px) {
          .payrollPage .workerRow {
            padding: 11px 12px;
            border-radius: 15px;
          }

          .payrollPage .workerLeft strong {
            font-size: 16px;
          }

          .payrollPage .workerRight b {
            font-size: 18px;
          }
        }
      `}</style>
    </div>
  );
}
