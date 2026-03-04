"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { listUsers } from "@/lib/usersDb";
import {
  addPayrollMove,
  computeDebt,
  getPayrollProfile,
  listPayrollMoves,
  upsertPayrollProfile,
} from "@/lib/payrollDb";
import { recordCashMove } from "@/lib/arkaCashSync";
import { budgetAddMove } from "@/lib/companyBudgetDb";

function jparse(s, fallback) {
  try {
    return JSON.parse(s) ?? fallback;
  } catch {
    return fallback;
  }
}

function parseAmount(v) {
  const s = String(v ?? "").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const CYCLES = ["WEEKLY", "BIWEEKLY", "MONTHLY"];
const MOVE_KINDS = ["AVANS", "RROGA", "BONUS", "BORXH_SHTO", "BORXH_KTHE"];

export default function WorkerCardPage() {
  const router = useRouter();
  const params = useParams();
  const userId = String(params?.id || "");

  const [actor, setActor] = useState(null);
  const [worker, setWorker] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState("");

  const [profile, setProfile] = useState({
    pay_amount: "",
    pay_cycle: "MONTHLY",
    next_pay_date: "",
    note: "",
  });

  const [moves, setMoves] = useState([]);
  const debt = useMemo(() => computeDebt(moves), [moves]);

  const [moveForm, setMoveForm] = useState({ kind: "AVANS", amount: "", note: "" });
  // BURIMI / DESTINACIONI i parave (STRICT): ARKA | KOMPANI | PERSONAL
  const [moveSource, setMoveSource] = useState("ARKA");
  const [saveBusy, setSaveBusy] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);

  useEffect(() => {
    const u = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
    if (!u) {
      router.push("/login");
      return;
    }
    setActor(u);
  }, [router]);

  useEffect(() => {
    if (!actor || !userId) return;
    (async () => {
      setBusy(true);
      setErr("");
      try {
        const res = await listUsers();
        if (!res.ok) throw res.error || new Error("NUK PO LEXOHET LISTA E USER-AVE");
        const found = (res.items || []).find((x) => String(x.id) === String(userId));
        setWorker(found || null);

        // profile
        try {
          const p = await getPayrollProfile(userId);
          if (p) {
            setProfile({
              pay_amount: p.pay_amount ?? "",
              pay_cycle: p.pay_cycle || "MONTHLY",
              next_pay_date: p.next_pay_date || "",
              note: p.note || "",
            });
          }
        } catch {
          // ignore
        }

        // moves
        try {
          const m = await listPayrollMoves(userId, 50);
          setMoves(m || []);
        } catch {
          setMoves([]);
        }
      } catch (e) {
        setErr(String(e?.message || e || "ERROR"));
      } finally {
        setBusy(false);
      }
    })();
  }, [actor, userId]);

  async function saveProfile() {
    if (!worker) return;
    setSaveBusy(true);
    setErr("");
    try {
      const amt = profile.pay_amount === "" ? null : parseAmount(profile.pay_amount);
      if (profile.pay_amount !== "" && !Number.isFinite(amt)) {
        alert("SHUMA E RROGËS NUK ËSHTË VALIDE");
        return;
      }
      // RREGULLIMI: Sigurohemi qe worker_name dergohet saktë
      await upsertPayrollProfile({
        user_id: worker.id,
        worker_name: worker.name, 
        role: worker.role,
        pay_amount: amt,
        pay_cycle: profile.pay_cycle,
        next_pay_date: profile.next_pay_date || null,
        note: profile.note || null,
      });
      alert("✅ U RUAJT");
    } catch (e) {
      setErr(String(e?.message || e || "ERROR"));
      alert(String(e?.message || e || "ERROR"));
    } finally {
      setSaveBusy(false);
    }
  }

  async function addMove() {
    if (!worker) return;
    const amt = parseAmount(moveForm.amount);
    if (!Number.isFinite(amt) || amt <= 0) return alert("SHKRUJ SHUMËN (NUMËR > 0)");

    setMoveBusy(true);
    setErr("");
    try {
      const kind = String(moveForm.kind || '').toUpperCase();
      const dir = kind === 'BORXH_KTHE' ? 'IN' : 'OUT';
      const src = String(moveSource || 'ARKA').toUpperCase();
      if (!['ARKA','KOMPANI','PERSONAL'].includes(src)) throw new Error('BURIMI DUHET: ARKA / KOMPANI / PERSONAL');

      // PIN i detyruar për PERSONAL (që të mos ketë anomali / pa autor)
      let pin = String(actor?.pin || '').trim();
      if (src === 'PERSONAL') {
        pin = String(window.prompt('SHKRUAJ PIN (PERSONAL)', pin || '') || '').trim();
        if (!pin) throw new Error('PIN MUNGON (PERSONAL).');
      }

      // 1) gjithmonë ruaje në tepiha_payroll_moves (audit + debt)
      await addPayrollMove({
        user_id: worker.id,
        worker_name: worker.name,
        kind,
        amount: amt,
        note: moveForm.note || null,
        source: src,
        created_by: actor?.id || null,
        actor_name: actor?.name || null,
        created_by_pin: pin || null,
        authorized_by_name: actor?.name || null,
      });

      // 2) MIRROR i lëvizjes së parave (vetëm kur ka kuptim si CASH/BUDGET)
      // BORXH_SHTO është vetëm shënim borxhi (pa cash) -> mos e kopjo në ARKË/BUXHET.
      const isPureDebtNote = kind === 'BORXH_SHTO';
      if (!isPureDebtNote) {
        const note = `PUNTOR: ${worker.name} • ${kind}${moveForm.note ? ` • ${moveForm.note}` : ''}`;
        if (src === 'ARKA') {
          // Cash real në ARKË (krijon pending + kërkon konfirmim nëse ARKA është e mbyllur)
          await recordCashMove({
            type: dir,
            amount: amt,
            source: 'PAYROLL',
            note,
            user: actor?.name || 'SYSTEM',
            created_by_name: actor?.name || null,
            created_by_pin: pin || null,
          });
        } else if (src === 'KOMPANI') {
          // Ledger i buxhetit të kompanisë
          await budgetAddMove({
            direction: dir,
            amount: amt,
            reason: kind,
            note,
            source: 'PAYROLL',
            created_by: actor?.id || null,
            created_by_name: actor?.name || null,
            created_by_pin: pin || null,
            external_id: `payroll_${worker.id}_${Date.now()}`,
            ref_type: 'PAYROLL',
          });
        }
        // PERSONAL: nuk e fusim në ledger automatikisht (është jashtë kompanisë), por ruhet audit në payroll_moves.
      }

      const m = await listPayrollMoves(worker.id, 50);
      setMoves(m || []);
      setMoveForm({ kind: moveForm.kind, amount: "", note: "" });
    } catch (e) {
      setErr(String(e?.message || e || "ERROR"));
      alert(String(e?.message || e || "ERROR"));
    } finally {
      setMoveBusy(false);
    }
  }

  return (
    <div className="pageContainer">
      <div className="maxWidth">
        <div className="topHeader">
          <div>
            <h1 className="h1">KARTELA E PUNTORIT</h1>
            <p className="meta">{worker ? `${worker.name} • ${worker.role}` : "..."}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className={`badge ${debt > 0 ? "badgeRed" : "badgeOk"}`}>
              <span style={{opacity:0.6, fontSize:'9px', display:'block'}}>BALANCI:</span>
              {Math.round(debt * 100) / 100}€
            </div>
            <Link href="/arka/staff" className="backBtn">KTHEHU</Link>
          </div>
        </div>

        {busy ? (
          <div className="loadingState">DUKE LEXUAR TË DHËNAT...</div>
        ) : !worker ? (
          <div className="errorState">NUK U GJET PUNTORI</div>
        ) : (
          <div className="mainGrid">
            {/* PROFILE SECTION */}
            <div className="profileCol">
              <div className="panel">
                <div className="panelHead">
                  <div className="panelTitle">KONFIGURIMI RROGËS</div>
                </div>
                <div className="panelBody">
                  <div className="formGroup">
                    <div className="field">
                      <label className="label">RROGA BAZË (€)</label>
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={profile.pay_amount}
                        onChange={(e) => setProfile((p) => ({ ...p, pay_amount: e.target.value }))}
                      />
                    </div>
                    
                    <div className="row2">
                      <div className="field">
                        <label className="label">CIKLI</label>
                        <select
                          className="input"
                          value={profile.pay_cycle}
                          onChange={(e) => setProfile((p) => ({ ...p, pay_cycle: e.target.value }))}
                        >
                          {CYCLES.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label className="label">DATA E ARDHSHME</label>
                        <input
                          className="input"
                          type="date"
                          value={profile.next_pay_date}
                          onChange={(e) => setProfile((p) => ({ ...p, next_pay_date: e.target.value }))}
                        />
                      </div>
                    </div>

                    <div className="field">
                      <label className="label">SHËNIM PËR RROGËN</label>
                      <textarea
                        className="input textarea"
                        rows={2}
                        placeholder="..."
                        value={profile.note}
                        onChange={(e) => setProfile((p) => ({ ...p, note: e.target.value }))}
                      />
                    </div>

                    <button className="btnPrimary" onClick={saveProfile} disabled={saveBusy}>
                      {saveBusy ? "DUKE RUAJT..." : "RUAJ KONFIGURIMIN"}
                    </button>

                    {err ? <div className="warnBox">{err}</div> : null}
                  </div>
                </div>
              </div>
            </div>

            {/* MOVES SECTION */}
            <div className="movesCol">
              <div className="panel">
                <div className="panelHead">
                  <div className="panelTitle">SHTO TRANSAKSION (AVANS/RROGË)</div>
                </div>
                <div className="panelBody">
                  <div className="addMoveGrid">
                    <div className="field kindField">
                      <label className="label">LLOJI</label>
                      <select
                        className="input"
                        value={moveForm.kind}
                        onChange={(e) => setMoveForm((m) => ({ ...m, kind: e.target.value }))}
                      >
                        {MOVE_KINDS.map((k) => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field amtField">
                      <label className="label">SHUMA (€)</label>
                      <input
                        className="input amountInput"
                        inputMode="decimal"
                        placeholder="0"
                        value={moveForm.amount}
                        onChange={(e) => setMoveForm((m) => ({ ...m, amount: e.target.value }))}
                      />
                    </div>
                    <div className="field">
                      <label className="label">
                        {String(moveForm.kind || '').toUpperCase() === 'BORXH_KTHE' ? 'KU SHKON (IN)' : 'PREJ KUJ (OUT)'}
                      </label>
                      <div className="chipRow" style={{display:'flex', gap:'8px', flexWrap:'wrap'}}>
                        {['ARKA','KOMPANI','PERSONAL'].map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setMoveSource(s)}
                            className={`chip ${moveSource === s ? 'chipActive' : ''}`}
                            style={{padding:'10px 12px', borderRadius:'12px'}}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                      <div style={{opacity:0.7, fontSize:'11px', marginTop:'6px'}}>
                        PERSONAL = kërkon PIN dhe ruhet kush e dha.
                      </div>
                    </div>
                    <div className="field noteField">
                      <label className="label">SHËNIM (OPSIONALE)</label>
                      <input
                        className="input"
                        placeholder="Përshkrimi..."
                        value={moveForm.note}
                        onChange={(e) => setMoveForm((m) => ({ ...m, note: e.target.value }))}
                      />
                    </div>
                    <div className="field btnField">
                      <button className="btnAdd" onClick={addMove} disabled={moveBusy}>
                        {moveBusy ? "..." : "SHTO"}
                      </button>
                    </div>
                  </div>

                  <div className="separator" />

                  <div className="listHeader">
                    <span className="label">HISTORIKU I LËVIZJEVE</span>
                    <span className="label">{moves.length} TOTAL</span>
                  </div>

                  <div className="list">
                    {moves.length === 0 ? (
                      <div className="emptyList">NUK KA LËVIZJE ENDE</div>
                    ) : (
                      moves.map((m, idx) => (
                        <div key={m.id || idx} className="moveRow">
                          <div className="moveLeft">
                            <div className="moveKind">{String(m.kind || "").toUpperCase()}</div>
                            <div className="moveMeta">
                              {m.created_at ? String(m.created_at).slice(0, 10) : ""}
                              {m.note ? <span className="moveNote"> • {m.note}</span> : null}
                            </div>
                          </div>
                          <div className={`moveAmt ${m.kind.includes('BORXH') || m.kind === 'AVANS' ? 'amtRed' : 'amtGreen'}`}>
                            {Number(m.amount || 0).toFixed(2)}€
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .pageContainer { min-height:100vh; background:#050505; color:#e5e5e5; padding:20px; font-family:sans-serif; text-transform:uppercase; }
        .maxWidth { max-width:1100px; margin:0 auto; }
        
        /* HEADER */
        .topHeader { display:flex; align-items:flex-end; justify-content:space-between; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:20px; margin-bottom:25px; gap:10px; }
        .h1 { font-size:22px; font-weight:900; letter-spacing:-0.02em; color:#fff; margin:0; }
        .meta { font-size:11px; letter-spacing:0.1em; color:rgba(255,255,255,0.5); margin-top:5px; font-weight:700; }
        
        .backBtn { background:#1a1a1a; border:1px solid #333; color:#fff; font-size:10px; font-weight:800; padding:10px 16px; border-radius:8px; text-decoration:none; transition:0.2s; letter-spacing:0.1em; height:42px; display:flex; align-items:center; }
        .backBtn:hover { background:#252525; border-color:#555; }

        .badge { padding:6px 14px; border-radius:10px; font-weight:900; font-size:13px; text-align:right; border:1px solid transparent; height:42px; display:flex; flex-direction:column; justify-content:center; }
        .badgeOk { background:rgba(16,185,129,0.1); color:#34d399; border-color:rgba(16,185,129,0.2); }
        .badgeRed { background:rgba(239,68,68,0.1); color:#f87171; border-color:rgba(239,68,68,0.2); }

        /* LOADING / ERROR */
        .loadingState { padding:60px; text-align:center; opacity:0.5; font-size:12px; letter-spacing:0.2em; font-style:italic; }
        .errorState { padding:40px; text-align:center; background:rgba(255,0,0,0.1); color:#ff6b6b; border-radius:12px; font-weight:800; }

        /* GRID */
        .mainGrid { display:grid; grid-template-columns:1fr; gap:24px; }
        @media (min-width: 1024px) {
          .mainGrid { grid-template-columns: 350px 1fr; }
        }

        /* PANELS */
        .panel { background:#0f0f0f; border:1px solid #222; border-radius:16px; overflow:hidden; box-shadow:0 10px 30px rgba(0,0,0,0.5); }
        .panelHead { background:rgba(255,255,255,0.03); padding:14px 20px; border-bottom:1px solid #222; }
        .panelTitle { font-size:10px; font-weight:900; letter-spacing:0.15em; color:rgba(255,255,255,0.6); }
        .panelBody { padding:20px; }

        /* FORMS */
        .formGroup { display:flex; flex-direction:column; gap:16px; }
        .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        .field { display:flex; flex-direction:column; gap:6px; }
        
        .label { font-size:9px; font-weight:800; letter-spacing:0.1em; color:rgba(255,255,255,0.4); margin-left:2px; }
        .input { width:100%; background:#050505; border:1px solid #2a2a2a; color:#fff; padding:12px 14px; font-size:13px; border-radius:10px; outline:none; font-weight:700; transition:0.2s; }
        .input:focus { border-color:#0070f3; background:#000; box-shadow:0 0 0 3px rgba(0,112,243,0.1); }
        .textarea { min-height:70px; resize:vertical; }

        /* BUTTONS */
        .btnPrimary { background:#0070f3; color:white; border:none; padding:14px; border-radius:10px; font-weight:900; font-size:11px; letter-spacing:0.1em; cursor:pointer; transition:0.2s; margin-top:4px; }
        .btnPrimary:hover { background:#0060df; transform:translateY(-1px); }
        .btnPrimary:active { transform:translateY(0); }
        .btnPrimary:disabled { opacity:0.6; cursor:not-allowed; }

        .warnBox { margin-top:10px; padding:10px; background:rgba(255,0,0,0.1); color:#ff8888; border-radius:8px; font-size:10px; text-align:center; }

        /* ADD MOVE FORM */
        .addMoveGrid { display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:end; }
        .kindField { grid-column: span 2; }
        .amtField { grid-column: span 1; }
        .noteField { grid-column: span 2; }
        .btnField { grid-column: span 2; }
        @media (min-width: 768px) {
           .addMoveGrid { grid-template-columns: 1.5fr 1fr 2fr 1fr; }
           .kindField { grid-column: span 1; }
           .amtField { grid-column: span 1; }
           .noteField { grid-column: span 1; }
           .btnField { grid-column: span 1; }
        }

        .amountInput { font-size:16px; color:#fff; }
        .btnAdd { width:100%; background:#10b981; color:#000; border:none; padding:12px; height:44px; border-radius:10px; font-weight:900; font-size:12px; cursor:pointer; transition:0.2s; }
        .btnAdd:hover { background:#059669; color:#fff; }

        /* LIST */
        .separator { height:1px; background:#222; margin:24px 0 16px 0; }
        .listHeader { display:flex; justify-content:space-between; margin-bottom:12px; padding:0 4px; }
        .list { display:flex; flex-direction:column; gap:8px; }
        .emptyList { text-align:center; padding:30px; opacity:0.3; font-size:10px; letter-spacing:0.2em; font-style:italic; }
        
        .moveRow { background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.05); padding:12px 16px; border-radius:10px; display:flex; justify-content:space-between; align-items:center; transition:0.2s; }
        .moveRow:hover { background:rgba(255,255,255,0.04); }
        
        .moveKind { font-size:11px; font-weight:900; color:#fff; letter-spacing:0.05em; }
        .moveMeta { font-size:10px; color:rgba(255,255,255,0.5); margin-top:3px; font-weight:600; }
        .moveNote { color:rgba(255,255,255,0.7); font-style:italic; text-transform:none; }
        
        .moveAmt { font-size:13px; font-weight:900; letter-spacing:0.05em; }
        .amtRed { color:#f87171; }
        .amtGreen { color:#34d399; }
      `}</style>
    </div>
  );
}
