"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { useRouter } from "@/lib/routerCompat.jsx";
import { supabase } from "@/lib/supabaseClient";
import { listPendingPaymentRecords } from "@/lib/arkaService";
import { deleteUserRecord, listUserRecords, updateUserRecord } from "@/lib/usersService";

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
    const autoPart = deductAutoAdvance ? Number(salaryModal.autoDebt || 0) : 0;
    const manualPart = deductManualAdvance ? Number(salaryModal.manualAdvance || 0) : 0;
    const longTermPart = Math.max(0, Number(deductLongTermAmount || 0));
    return Number(salaryModal.baseSalary || 0) - autoPart - manualPart - longTermPart;
  }, [salaryModal, deductAutoAdvance, deductManualAdvance, deductLongTermAmount]);

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
      if (deductAutoAdvance) {
        const { error: err1 } = await supabase
          .from("arka_pending_payments")
          .update({
            status: "CLEARED_PAID",
            applied_at: new Date().toISOString(),
          })
          .in("status", ["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"])
          .eq("created_by_name", salaryModal.name);
        if (err1) throw err1;
      }

      const nextManualAdvance = deductManualAdvance ? 0 : Number(salaryModal.manualAdvance || 0);
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
      const { error: err1 } = await supabase
        .from("arka_pending_payments")
        .update({
          status: "CLEARED_PAID",
          applied_at: new Date().toISOString(),
        })
        .in("status", ["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"])
        .eq("created_by_name", salaryModal.name);
      if (err1) throw err1;

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
    return (staff || []).map((u) => {
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

  if (actor && !isAdminUser) return <AccessDeniedPanel />;

  return (
    <div className="payrollPage">
      <div className="shell">
        <div className="topbar">
          <div>
            <div className="eyebrow">Arka / Payroll</div>
            <h1 className="title">Financat & Rrogat</h1>
            <p className="subtitle">
              Një pamje e pastër, moderne dhe bankare për rrogat, avanset dhe borxhet.
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
        ) : financeCards.length === 0 ? (
          <div className="empty">Nuk ka asnjë punëtor për payroll.</div>
        ) : (
          <div className="cardsGrid">
            {financeCards.map((u) => (
              <div className="moneyCard" key={u.id} style={{ opacity: u.is_active === false ? 0.6 : 1 }}>
                <div className="moneyTop">
                  <div>
                    <div className="moneyNameRow">
                      <div className="moneyName">{u.name || "Pa emër"}</div>
                      {paydayDue(u.salary_day) && (
                        <span className="dueBadge">⚠️ KOHA PËR RROGË</span>
                      )}
                    </div>
                    <div className="moneyMeta">
                      {u.role || "—"} · PIN {u.pin || "—"} · Dita e rrogës: {u.salary_day || "—"}
                    </div>
                  </div>
                  <div className="cardActions">
                    <button className="editMini" onClick={() => startFinanceEdit(u)}>EDITO</button>
                    {isAdminUser ? (
                      <button className="deleteMini" onClick={() => handleDeleteWorker(u)}>🗑️ FSHI</button>
                    ) : null}
                  </div>
                </div>

                <div className="moneyMetrics">
                  <div className="metric salary">
                    <span>Rroga bazë</span>
                    <strong>{euro(u.baseSalary)}</strong>
                  </div>
                  <div className="metric debt">
                    <span>Avanset</span>
                    <strong>{euro(u.totalAdvance)}</strong>
                  </div>
                  <div className="metric longdebt">
                    <span>Borxh afatgjatë</span>
                    <strong>{euro(u.longTermDebt)}</strong>
                  </div>
                </div>

                <div className="moneyBottom">
                  <div className="payablePreview">
                    Për t'u paguar sot
                    <strong>{euro(u.baseSalary - u.totalAdvance)}</strong>
                  </div>

                  <div className="moneyActionStack">
                    <button className="advanceBtn" onClick={() => openAdvanceModal(u)}>
                      💸 SHTO AVANS
                    </button>
                    <button className="payBtn" onClick={() => openSalaryModal(u)}>
                      💳 PAGUAJ RROGËN
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
                <div className="bigNumberCard">
                  <span>Për t'u paguar</span>
                  <strong>{euro(payableAmount)}</strong>
                  <small>Rillogaritet live sipas zgjedhjeve më poshtë</small>
                </div>

                <div className="summaryList">
                  <div className="summaryRow">
                    <span>Rroga bazë</span>
                    <strong>{euro(salaryModal.baseSalary)}</strong>
                  </div>
                  <label className="checkRow">
                    <div>
                      <strong>Zbrit avansin nga porositë</strong>
                      <small>{euro(salaryModal.autoDebt)}</small>
                    </div>
                    <input
                      type="checkbox"
                      checked={deductAutoAdvance}
                      onChange={(e) => setDeductAutoAdvance(e.target.checked)}
                    />
                  </label>
                  <label className="checkRow">
                    <div>
                      <strong>Zbrit avansin manual</strong>
                      <small>{euro(salaryModal.manualAdvance)}</small>
                    </div>
                    <input
                      type="checkbox"
                      checked={deductManualAdvance}
                      onChange={(e) => setDeductManualAdvance(e.target.checked)}
                    />
                  </label>

                  <label className="deductBox">
                    <span>Zbrit nga borxhi afatgjatë (opsionale)</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={deductLongTermAmount}
                      onChange={(e) => setDeductLongTermAmount(onlyDigits(e.target.value))}
                      placeholder="P.sh. 50"
                    />
                    <small>Borxhi aktual: {euro(salaryModal.longTermDebt)}</small>
                  </label>
                </div>

                <div className="warningBox">
                  ⚠️ Borxhi afatgjatë nuk zbritet automatikisht. Vendos një shumë vetëm nëse dëshiron ta ulësh këtë muaj.
                </div>

                <div className="actionStack">
                  <button className="greenCta" disabled={actionBusy} onClick={handlePaySalary}>
                    PAGUAJ RROGËN
                  </button>
                  <button className="amberCta" disabled={actionBusy} onClick={handleMoveAdvancesToLongTerm}>
                    KALO AVANSET NË BORXH AFATGJATË
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
          .fullOverlay {
            padding: 8px;
          }
        }
      `}</style>
    </div>
  );
}
