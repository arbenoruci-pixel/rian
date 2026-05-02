"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { useRouter } from "@/lib/routerCompat.jsx";
import { supabase } from "@/lib/supabaseClient";
import { listPendingPaymentRecords } from "@/lib/arkaService";
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
  const [selectedPayrollRow, setSelectedPayrollRow] = useState(null);

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
        in: { status: ["ADVANCE"] },
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
      const { data, error } = await supabase
        .from("arka_pending_payments")
        .select("*")
        .gte("created_at", startIso)
        .lt("created_at", endIso)
        .order("created_at", { ascending: false })
        .limit(3000);

      if (error) throw error;
      setPayrollMonthRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn("PRO PAYROLL PREVIEW LOAD ERROR", err);
      setPayrollMonthRows([]);
      setPayrollMonthError(normalizeDbError(err));
    } finally {
      setPayrollMonthLoading(false);
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

  function openSalaryModal(u, payrollRow = null) {
    const baseSalary = Number(u?.salary ?? u?.baseSalary ?? payrollRow?.baseSalary ?? 0);
    const manualAdvance = Number(u?.avans_manual ?? u?.manualAdvance ?? 0);
    const monthlyAdvanceTotal = Number(payrollRow?.advancesTotal ?? 0);
    const autoDebt = Math.max(0, monthlyAdvanceTotal > 0 ? monthlyAdvanceTotal - manualAdvance : Number(debtsMap[String(u?.name || "").trim().toUpperCase()] || 0));
    const longTermDebt = Number(u?.borxh_afatgjat ?? u?.longTermDebt ?? payrollRow?.debtTotal ?? 0);

    setSalaryModal({
      ...u,
      baseSalary,
      autoDebt,
      manualAdvance,
      totalAdvance: autoDebt + manualAdvance,
      longTermDebt,
      payrollMonthRow: payrollRow || null,
    });
    setDeductAutoAdvance(true);
    setDeductManualAdvance(true);
    setDeductLongTermAmount("");
    fetchWorkerHistory(u?.name || payrollRow?.name || "");
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

    const now = new Date().toISOString();
    const basePayload = {
      amount: amt,
      status: 'ADVANCE',
      type: 'ADVANCE',
      note: String(advanceNote || 'AVANS').trim() || 'AVANS',
      order_id: null,
      order_code: null,
      client_name: null,
      client_phone: null,
      created_by_pin: advanceModal?.pin || null,
      created_by_name: advanceModal?.name || null,
      approved_by_pin: actor?.pin || null,
      approved_by_name: actor?.name || null,
      handed_by_pin: actor?.pin || null,
      handed_by_name: actor?.name || null,
      handed_by_role: actor?.role || null,
      created_at: now,
      updated_at: now,
      handed_at: now,
    };

    setAdvanceBusy(true);
    try {
      let { error } = await supabase.from('arka_pending_payments').insert(basePayload);
      if (error) {
        const fallbackPayload = {
          amount: amt,
          status: 'ADVANCE',
          note: String(advanceNote || 'AVANS').trim() || 'AVANS',
          created_by_pin: advanceModal?.pin || null,
          created_by_name: advanceModal?.name || null,
          approved_by_pin: actor?.pin || null,
          approved_by_name: actor?.name || null,
          updated_at: now,
        };
        const retry = await supabase.from('arka_pending_payments').insert(fallbackPayload);
        if (retry.error) throw retry.error;
      }
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
      alert("Kërkohet Master PIN për këtë veprim.");
      return;
    }

    const longTermReduction = Math.max(0, Number(deductLongTermAmount || 0));
    if (longTermReduction > Number(salaryModal.longTermDebt || 0)) {
      alert("Nuk mund të zbrisni më shumë se borxhi afatgjatë aktual.");
      return;
    }

    const conf = confirm(
      `A jeni i sigurt që dëshironi ta përfundoni pagesën për ${salaryModal.name}?`
    );
    if (!conf) return;

    setActionBusy(true);
    try {
      {
        const nowIso = new Date().toISOString();
        const workerPin = String(salaryModal?.pin || '').trim();
        const workerName = String(salaryModal?.name || '').trim();

        const clearPayload = {
          status: "CLEARED_PAID",
          updated_at: nowIso,
        };

        const runClearQuery = async (field, value) => {
          if (!value) return null;

          let { error } = await supabase
            .from("arka_pending_payments")
            .update(clearPayload)
            .in("status", ["ADVANCE"])
            .eq(field, value);

          if (error && String(error?.message || '').toLowerCase().includes('updated_at')) {
            const retry = await supabase
              .from("arka_pending_payments")
              .update({ status: "CLEARED_PAID" })
              .in("status", ["ADVANCE"])
              .eq(field, value);
            error = retry.error;
          }

          if (error) throw error;
          return true;
        };

        await runClearQuery("created_by_pin", workerPin);
        await runClearQuery("created_by_name", workerName);
      }

      const nextManualAdvance = 0;
      const nextLongTerm = Math.max(
        0,
        Number(salaryModal.longTermDebt || 0) - longTermReduction
      );

      const { error: err2 } = await supabase
        .from("users")
        .update({
          avans_manual: nextManualAdvance,
          borxh_afatgjat: nextLongTerm,
        })
        .eq("id", salaryModal.id);

      if (err2) throw err2;

      alert(`✅ Rroga u përpunua me sukses për ${salaryModal.name}.`);
      setSalaryModal(null);
      await reloadAll(false);
    } catch (e) {
      alert("GABIM: " + normalizeDbError(e));
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

      const clearPayload = {
        status: "CLEARED_PAID",
        updated_at: nowIso,
      };

      const runClearQuery = async (field, value) => {
        if (!value) return null;

        let { error } = await supabase
          .from("arka_pending_payments")
          .update(clearPayload)
          .in("status", ["ADVANCE"])
          .eq(field, value);

        if (error && String(error?.message || '').toLowerCase().includes('updated_at')) {
          const retry = await supabase
            .from("arka_pending_payments")
            .update({ status: "CLEARED_PAID" })
            .in("status", ["ADVANCE"])
            .eq(field, value);
          error = retry.error;
        }

        if (error) throw error;
        return true;
      };

      await runClearQuery("created_by_pin", workerPin);
      await runClearQuery("created_by_name", workerName);

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
      return acc;
    }, { gross: 0, deductions: 0, net: 0, carryOver: 0, openCash: 0, pendingHandoff: 0, okCount: 0, blockedCount: 0, reviewCount: 0 });
  }, [monthlyPayrollPreview]);

  const selectedPayrollDetails = useMemo(() => {
    if (!selectedPayrollRow) return null;
    return (monthlyPayrollPreview || []).find((row) => row.key === selectedPayrollRow.key) || null;
  }, [monthlyPayrollPreview, selectedPayrollRow]);

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
    openSalaryModal(worker, row);
  }

  if (actor && !isAdminUser) return <AccessDeniedPanel />;

  return (
    <div className="payrollPage">
      <div className="shell">
        <div className="topbar">
          <div>
            <div className="eyebrow">Arka / Payroll</div>
            <h1 className="title">Payroll Mujor</h1>
            <p className="subtitle">
              Një sistem i vetëm kompakt për rrogë, avans, status dhe kontroll para pagesës.
            </p>
          </div>

          <div className="topActions">
            <Link prefetch={false} href="/arka" className="navBtn">← KTHEHU NË ARKË</Link>
            <Link prefetch={false} href="/arka/stafi" className="navBtn primaryGhost">MENAXHIMI I STAFIT</Link>
          </div>
        </div>

        <div className="hero">
          <div className="heroLeft">
            <div className="heroLabel">Payroll Center</div>
            <div className="heroValue">{financeCards.length}</div>
            <div className="heroCaption">Punëtorë në menaxhim financiar</div>
          </div>

          <div className="heroRight">
            <label className="pinBox">
              <span>Master PIN</span>
              <input
                type="password"
                value={masterPin}
                placeholder="****"
                onChange={(e) => {
                  const val = onlyDigits(e.target.value);
                  setMasterPin(val);
                }}
                autoComplete="off"
              />
            </label>
          </div>
        </div>

        <section className="proPayrollPanel">
          <div className="proTop">
            <div>
              <div className="proEyebrow">MBYLLJA MUJORE</div>
              <div className="proTitle">Payroll i qartë — rroga mujore</div>
              <div className="proSub">
                Rregulli kryesor: nga rroga mujore zbritet vetëm avansi personal. Komisioni, ushqimi, shpenzimet dhe cash-i shfaqen vetëm për kontroll.
              </div>

              <div className="payrollRules">
                <div>
                  <span>1</span>
                  <strong>RROGA = RROGA BAZË − AVANSI PERSONAL</strong>
                </div>
                <div>
                  <span>2</span>
                  <strong>KOMISIONI / USHQIMI NUK ZBRITEN NGA RROGA</strong>
                </div>
                <div>
                  <span>3</span>
                  <strong>CASH-I I HAPUR VETËM E BLLOKON PAGESËN</strong>
                </div>
              </div>
            </div>

            <div className="proControls">
              <label>
                <span>Muaji</span>
                <input
                  type="month"
                  value={payrollMonth}
                  onChange={(e) => setPayrollMonth(e.target.value || getCurrentPayrollMonth())}
                />
              </label>
              <button
                type="button"
                className="proReload"
                onClick={() => reloadMonthlyPayrollPreview(payrollMonth)}
                disabled={payrollMonthLoading}
              >
                {payrollMonthLoading ? "PO LEXOHET..." : "RIFRESKO"}
              </button>
            </div>
          </div>

          {payrollMonthError ? (
            <div className="proError">Gabim në preview: {payrollMonthError}</div>
          ) : null}

          <div className="proScoreboard">
            <div className="score ok"><span>OK për pagesë</span><strong>{monthlyPayrollTotals.okCount}</strong></div>
            <div className="score blocked"><span>Bllokuar</span><strong>{monthlyPayrollTotals.blockedCount}</strong></div>
            <div className="score review"><span>Kontrollo</span><strong>{monthlyPayrollTotals.reviewCount}</strong></div>
            <div className="score"><span>Për pagesë total</span><strong>{euro(monthlyPayrollTotals.net)}</strong></div>
          </div>

          <div className="proTotals">
            <div><span>Rroga bazë total</span><strong>{euro(monthlyPayrollTotals.gross)}</strong></div>
            <div><span>Zbritet nga rroga</span><strong>{euro(monthlyPayrollTotals.deductions)}</strong></div>
            <div><span>Për me ia dhënë</span><strong>{euro(monthlyPayrollTotals.net)}</strong></div>
            <div><span>Avans bartet</span><strong>{euro(monthlyPayrollTotals.carryOver)}</strong></div>
            <div><span>Cash hapur</span><strong>{euro(monthlyPayrollTotals.openCash)}</strong></div>
            <div><span>Dorëzim në pritje</span><strong>{euro(monthlyPayrollTotals.pendingHandoff)}</strong></div>
          </div>

          <div className="proTableWrap">
            <table className="proTable">
              <thead>
                <tr>
                  <th>Puntori</th>
                  <th>Rroga bazë</th>
                  <th>Komision ditor<br/>nuk futet</th>
                  <th>Avans<br/>zbritet</th>
                  <th>Ushqim<br/>nuk zbritet</th>
                  <th>Borxh<br/>info</th>
                  <th>Për pagesë</th>
                  <th>Status</th>
                  <th>Veprim</th>
                </tr>
              </thead>
              <tbody>
                {monthlyPayrollPreview.length === 0 ? (
                  <tr><td colSpan={9}>Nuk ka punëtorë aktivë për payroll.</td></tr>
                ) : monthlyPayrollPreview.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <strong>{row.name}</strong>
                      <small>PIN {row.pin || "—"} · {row.role || "PUNTOR"}</small>
                    </td>
                    <td>{euro(row.baseSalary)}</td>
                    <td>{euro(row.transportCommission)}</td>
                    <td>{euro(row.advancesTotal)}</td>
                    <td>{euro(row.mealTotal)}</td>
                    <td>{euro(row.debtTotal)}</td>
                    <td><strong>{euro(row.net)}</strong></td>
                    <td>
                      <div className={`proStatus ${row.statusKind}`}>
                        {row.statusLabel}
                      </div>
                      {row.warnings.length ? (
                        <ul className="proWarnings">
                          {row.warnings.slice(0, 3).map((w) => <li key={w}>{w}</li>)}
                        </ul>
                      ) : null}
                    </td>
                    <td>
                      <div className="proActionStack">
                        <button type="button" className="detailsBtn" onClick={() => setSelectedPayrollRow(row)}>
                          SHIKO
                        </button>
                        <button type="button" className="detailsBtn amber" onClick={() => openAdvanceModal(getFinanceWorkerForPayrollRow(row))}>
                          AVANS
                        </button>
                        <button type="button" className="detailsBtn slate" onClick={() => startFinanceEdit(getFinanceWorkerForPayrollRow(row))}>
                          EDITO
                        </button>
                        <button
                          type="button"
                          className="detailsBtn pay"
                          disabled={row.statusKind !== 'ok'}
                          title={row.statusKind !== 'ok' ? 'Rroga hapet vetëm kur statusi është OK PËR PAGESË.' : 'Hap modalin ekzistues të pagesës së rrogës.'}
                          onClick={() => openPayrollPayModal(row)}
                        >
                          PAGUAJ
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="proMobileList">
            {monthlyPayrollPreview.map((row) => (
              <button type="button" className={`proMobileCard ${row.statusKind}`} key={row.key} onClick={() => setSelectedPayrollRow(row)}>
                <div>
                  <strong>{row.name}</strong>
                  <small>PIN {row.pin || "—"}</small>
                </div>
                <div>
                  <span>{row.statusLabel}</span>
                  <b>{euro(row.net)}</b>
                </div>
              </button>
            ))}
          </div>
        </section>

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
                <div className="modalEyebrow">Detaje të rrogës mujore</div>
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
              <div className="detailBox danger">
                <span>Avans bartet muajin tjetër</span>
                <strong>{euro(selectedPayrollDetails.carryOver)}</strong>
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
              <div className="breakdownCard">
                <h3>PAGA QË LLOGARITET</h3>
                <p><span>Rroga bazë</span><strong>{euro(selectedPayrollDetails.baseSalary)}</strong></p>
                <p><span>Komision ditor informativ</span><strong>{euro(selectedPayrollDetails.transportCommission)}</strong></p>
                <p><span>Transport m²</span><strong>{Number(selectedPayrollDetails.transportM2 || 0).toFixed(2)} m²</strong></p>
              </div>

              <div className="breakdownCard">
                <h3>ZBRITET NGA RROGA</h3>
                <p><span>Avans personal</span><strong>{euro(selectedPayrollDetails.advancesTotal)}</strong></p>
                
                
              </div>

              <div className="breakdownCard">
                <h3>BLLOKON PAGESËN, POR NUK ZBRITET</h3>
                <p><span>Cash hapur</span><strong>{euro(selectedPayrollDetails.openCash)}</strong></p>
                <p><span>Dorëzim në pritje</span><strong>{euro(selectedPayrollDetails.pendingHandoff)}</strong></p>
                <p><span>Status</span><strong>{selectedPayrollDetails.statusLabel}</strong></p>
              </div>
            </div>

            {selectedPayrollDetails.warnings.length ? (
              <div className="detailWarnings">
                <strong>Çka duhet kontrolluar para pagesës</strong>
                <ul>
                  {selectedPayrollDetails.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              </div>
            ) : (
              <div className="detailOk">Ky puntor është OK për pagesë. Nuk ka cash/dorëzim që e bllokon rrogën.</div>
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
                Butoni hapet vetëm kur nuk ka cash të hapur ose dorëzim në pritje.
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
                  <small>Formula fikse: Rroga bazë − avansi personal. Nuk përfshin borxh/duplikat/rejected.</small>
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
                    <span>Avans personal që zbritet (vetëm ADVANCE)</span>
                    <strong>{euro(Number(salaryModal.autoDebt || 0) + Number(salaryModal.manualAdvance || 0))}</strong>
                  </div>
                  <div className="summaryRow mutedRow">
                    <span>Borxh afatgjatë informativ</span>
                    <strong>{euro(salaryModal.longTermDebt)}</strong>
                  </div>
                </div>

                <div className="warningBox">
                  ✅ Në këtë ekran nga rroga zbritet vetëm avansi personal me status ADVANCE. Ushqimi, komisioni, shpenzimet dhe borxhi informativ nuk zbriten nga rroga mujore.
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
          font-size: 22px;
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
          gap: 10px;
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
        .payrollDetailModal { max-width: 1100px; }
        .detailGrid, .breakdownGrid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
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
          .proScoreboard, .proTotals, .detailGrid, .breakdownGrid {
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
      `}</style>
    </div>
  );
}
