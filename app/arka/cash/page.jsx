"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { dbGetOpenDay, dbOpenDay, dbCloseDay, dbListMoves, dbAddMove } from "../../../lib/arkaDb";
import { findUserByPin } from "../../../lib/usersDb";

const fmtEur = (n) => {
  const x = Number(n || 0);
  return x.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

export default function ArkaCashPage() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);

  const [day, setDay] = useState(null);
  const [moves, setMoves] = useState([]);

  const [mode, setMode] = useState("IN"); // IN | OUT
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const [opening, setOpening] = useState("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Close-day flow (modal)
  const [showClose, setShowClose] = useState(false);
  const [closeCash, setCloseCash] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [closePin, setClosePin] = useState("");
  const [pinErr, setPinErr] = useState("");

  const dayLabel = useMemo(() => (day ? day.day_key || todayKey() : todayKey()), [day]);

  const totals = useMemo(() => {
    const initial = Number(day?.initial_cash || 0);
    let inSum = 0;
    let outSum = 0;
    for (const m of moves || []) {
      const a = Number(m.amount || 0);
      if (m.type === "IN") inSum += a;
      if (m.type === "OUT") outSum += a;
    }
    return {
      initial,
      inSum,
      outSum,
      total: initial + inSum - outSum,
    };
  }, [day, moves]);

  async function loadMe() {
    try {
      const raw = localStorage.getItem("arka_user");
      if (raw) setMe(JSON.parse(raw));
    } catch {}
  }

  async function refresh() {
    setErr("");
    setLoading(true);
    try {
      // 1) current open day
      const d = await dbGetOpenDay();
      setDay(d || null);

      // 2) list moves (if day open)
      if (d?.id) {
        const list = await dbListMoves(d.id);
        setMoves(Array.isArray(list) ? list : []);
      } else {
        setMoves([]);
      }
    } catch (e) {
      setErr(e?.message || "Gabim gjatë ngarkimit.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMe().then(refresh);
  }, []);

  async function onOpenDay() {
    setBusy(true);
    setErr("");
    try {
      const init = Number(String(opening || "0").replace(",", "."));
      const opened_by = me?.name || "LOCAL";
      const d = await dbOpenDay({ initial_cash: isFinite(init) ? init : 0, opened_by });
      setDay(d);
      const list = await dbListMoves(d.id);
      setMoves(Array.isArray(list) ? list : []);
    } catch (e) {
      setErr(e?.message || "S’u hap dita.");
    } finally {
      setBusy(false);
    }
  }

  async function onCloseDay() {
    if (!day?.id) return;
    // Open close modal instead of closing immediately
    setErr("");
    setPinErr("");
    setShowClose(true);
    // Default counted cash to expected total (easy for user)
    setCloseCash(String(totals.total || 0));
  }

  const closeExpected = useMemo(() => Number(totals.total || 0), [totals.total]);
  const closeCounted = useMemo(() => {
    const n = Number(String(closeCash || "").replace(",", "."));
    return isFinite(n) ? n : 0;
  }, [closeCash]);
  const closeDiscrepancy = useMemo(() => closeCounted - closeExpected, [closeCounted, closeExpected]);

  function discStyle() {
    if (!showClose) return {};
    // green when 0, red otherwise
    return Math.abs(closeDiscrepancy) < 0.00001 ? { borderColor: "#2ecc71" } : { borderColor: "#ff4d4f" };
  }

  async function confirmCloseDay() {
    if (!day?.id) return;
    setBusy(true);
    setErr("");
    setPinErr("");

    try {
      const pin = String(closePin || "").trim();
      if (!pin) {
        setPinErr("Shkruaj PIN-in.");
        return;
      }

      // Verify PIN in DB (same as login behavior)
      const res = await findUserByPin(pin);
      if (!res?.ok) {
        throw res?.error || new Error("Gabim gjatë verifikimit të PIN.");
      }
      if (!res?.item) {
        setPinErr("PIN I GABUAR");
        return;
      }

      const closed_by = me?.name || res.item?.name || "LOCAL";
      await dbCloseDay({
        day_id: day.id,
        closed_by,
        expected_cash: closeExpected,
        cash_counted: closeCounted,
        discrepancy: closeDiscrepancy,
        close_note: (closeNote || "").trim(),
      });

      // reset UI
      setShowClose(false);
      setCloseCash("");
      setCloseNote("");
      setClosePin("");
      setDay(null);
      setMoves([]);
      setOpening("0");
    } catch (e) {
      setErr(e?.message || "S’u mbyll dita.");
    } finally {
      setBusy(false);
    }
  }

  async function onAddMove() {
    if (!day?.id) {
      setErr("HAPE DITËN fillimisht.");
      return;
    }
    const n = Number(String(amount || "").replace(",", "."));
    if (!isFinite(n) || n <= 0) {
      setErr("Shuma duhet me qenë > 0.");
      return;
    }

    setBusy(true);
    setErr("");
    try {
      const created_by = me?.name || "LOCAL";
      const payload = {
        day_id: day.id,
        type: mode,
        amount: n,
        note: (note || "").trim(),
        source: "MANUAL",
        created_by,
        external_id: null,
      };

      // Write to DB via helper (also writes local cache)
      const inserted = await dbAddMove(payload);

      // Optimistic UI
      setMoves((prev) => [inserted, ...(prev || [])]);
      setAmount("");
      setNote("");
    } catch (e) {
      setErr(e?.message || "S’u ruajt lëvizja.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pageWrap">
      <div className="topRow">
        <div>
          <div className="title">ARKA • CASH</div>
          <div className="sub">
            {(me?.name || "LOCAL").toLowerCase()} • {(me?.role || "ADMIN")} • LOCAL
          </div>
        </div>
        <div className="topActions">
          <Link className="ghostBtn" href="/arka/buxheti">
            COMPANY BUDGET
          </Link>
          <Link className="ghostBtn" href="/arka">
            KTHEHU
          </Link>
        </div>
      </div>

      {!!err && <div className="errBox">{err}</div>}

      {/* CLOSE DAY MODAL */}
      {showClose && (
        <div className="modalBack">
          <div className="modalCard">
            <div className="modalTitle">MBYLLJA E DITËS</div>

            <div className="grid4" style={{ marginTop: 10 }}>
              <div className="kpi">
                <div className="k">FILLIMI</div>
                <div className="v">€{fmtEur(totals.initial)}</div>
              </div>
              <div className="kpi">
                <div className="k">PAGESA</div>
                <div className="v">€{fmtEur(totals.inSum)}</div>
              </div>
              <div className="kpi">
                <div className="k">SHPENZIME</div>
                <div className="v">€{fmtEur(totals.outSum)}</div>
              </div>
              <div className="kpi">
                <div className="k">CASH PRITET</div>
                <div className="v">€{fmtEur(closeExpected)}</div>
              </div>
            </div>

            <div className="field" style={{ marginTop: 12 }}>
              <div className="label">CASH REAL (NUMËRUAR)</div>
              <input
                className="input"
                value={closeCash}
                onChange={(e) => setCloseCash(e.target.value)}
                inputMode="decimal"
                placeholder={fmtEur(closeExpected)}
                style={discStyle()}
              />
              <div className="hint" style={{ marginTop: 6 }}>
                DISKREPANCA: <b>{closeDiscrepancy >= 0 ? "+" : ""}€{fmtEur(closeDiscrepancy)}</b>
              </div>
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="label">SHËNIM (OPSIONAL)</div>
              <textarea
                className="input"
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                rows={2}
                placeholder="p.sh. mungesë 5€ / shënim për dorëzim"
                style={{ minHeight: 56 }}
              />
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="label">PIN (KUSH PO E MBYLL)</div>
              <input
                className="input"
                value={closePin}
                onChange={(e) => {
                  // keep only digits, max 4
                  const v = String(e.target.value || "").replace(/\D/g, "").slice(0, 4);
                  setClosePin(v);
                }}
                inputMode="numeric"
                placeholder="0000"
              />
              {!!pinErr && <div className="errBox" style={{ marginTop: 8 }}>{pinErr}</div>}
            </div>

            <div className="rowActions" style={{ marginTop: 14 }}>
              <button
                className="ghostBtn"
                onClick={() => {
                  if (busy) return;
                  setShowClose(false);
                  setClosePin("");
                  setPinErr("");
                }}
                disabled={busy}
              >
                ANULO
              </button>
              <button className="dangerBtn" onClick={confirmCloseDay} disabled={busy}>
                KONFIRMO MBYLLJEN
              </button>
            </div>

            <div className="hint" style={{ marginTop: 10 }}>
              Pas mbylljes, pagesat bllokohen derisa dita të hapet përsëri.
            </div>
          </div>
        </div>
      )}

      {/* DAY CARD */}
      <div className="card">
        <div className="cardHead">
          <div className="cardTitle">DITA</div>
          <div className="pill">{day ? "E HAPUR" : "E MBYLLUR"}</div>
        </div>

        {!day ? (
          <div className="grid2">
            <div className="field">
              <div className="label">FILLIMI (€)</div>
              <input
                className="input"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                inputMode="decimal"
                placeholder="0"
              />
            </div>
            <div className="field">
              <div className="label">DATA</div>
              <input className="input" value={todayKey()} readOnly />
            </div>

            <button className="btn" onClick={onOpenDay} disabled={busy}>
              HAPE DITËN
            </button>
            <div className="hint">Hap ditën para se me i regjistru pagesat/shpenzimet.</div>
          </div>
        ) : (
          <div className="grid4">
            <div className="kpi">
              <div className="k">FILLIMI</div>
              <div className="v">€{fmtEur(totals.initial)}</div>
            </div>
            <div className="kpi">
              <div className="k">HYRJE</div>
              <div className="v">€{fmtEur(totals.inSum)}</div>
            </div>
            <div className="kpi">
              <div className="k">DALJE</div>
              <div className="v">€{fmtEur(totals.outSum)}</div>
            </div>
            <div className="kpi">
              <div className="k">TOTALI</div>
              <div className="v">€{fmtEur(totals.total)}</div>
            </div>

            <div className="rowActions">
              <button className="ghostBtn" onClick={refresh} disabled={busy}>
                RIFRESKO
              </button>
              <button className="dangerBtn" onClick={onCloseDay} disabled={busy}>
                MBYLL DITËN
              </button>
              <div className="dayKey">DITA: {dayLabel}</div>
            </div>
          </div>
        )}
      </div>

      {/* ADD MOVE */}
      <div className="card">
        <div className="cardHead">
          <div className="cardTitle">SHTO LËVIZJE</div>
          <div className="seg">
            <button
              className={mode === "IN" ? "segBtn segOn" : "segBtn"}
              onClick={() => setMode("IN")}
              type="button"
            >
              PAGESË
            </button>
            <button
              className={mode === "OUT" ? "segBtn segOn" : "segBtn"}
              onClick={() => setMode("OUT")}
              type="button"
            >
              SHPENZIM
            </button>
          </div>
        </div>

        <div className="grid2">
          <div className="field">
            <div className="label">SHUMA (€)</div>
            <input
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0"
            />
          </div>
          <div className="field">
            <div className="label">SHËNIM (opsional)</div>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="p.sh. detergjent, klienti #12" />
          </div>

          <button className="btn" onClick={onAddMove} disabled={busy || !day?.id}>
            RUAJ
          </button>
          <div className="hint">
            Pagesat nga PRANIMI/PASTRIMI/GATI regjistrohen si <b>source=ORDER</b>. Këtu ke edhe hyrje/dalje manuale.
          </div>
        </div>
      </div>

      {/* MOVES */}
      <div className="card">
        <div className="cardHead">
          <div className="cardTitle">LËVIZJET</div>
          <div className="pill">{moves?.length || 0} RRESHTA</div>
        </div>

        {loading ? (
          <div className="muted">DUKE NGARKU…</div>
        ) : moves?.length ? (
          <div className="list">
            {moves.map((m) => (
              <div className="moveRow" key={m.id || `${m.created_at}_${m.amount}`}>
                <div className="moveLeft">
                  <div className="moveType">
                    <span className={m.type === "IN" ? "tag tagIn" : "tag tagOut"}>{m.type === "IN" ? "HYRJE" : "DALJE"}</span>
                    <span className="src">{(m.source || "—").toUpperCase()}</span>
                  </div>
                  <div className="note">{m.note || "—"}</div>
                  <div className="meta">
                    {(m.created_by || "—").toLowerCase()} • {String(m.created_at || "").replace("T", " ").slice(0, 16)}
                    {m.external_id ? ` • #${m.external_id}` : ""}
                  </div>
                </div>
                <div className="moveAmt">
                  <div className={m.type === "IN" ? "amt amtIn" : "amt amtOut"}>€{fmtEur(m.amount)}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted">NUK KA LËVIZJE</div>
        )}
      </div>

      <div className="bottomSpace" />

      <style jsx>{`        .pageWrap{max-width:980px;margin:0 auto;padding:18px 14px 56px;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:12px;}
        .title{font-size:34px;letter-spacing:1px;font-weight:950;line-height:1;}
        .sub{opacity:.75;margin-top:6px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;}
        .topActions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end;}
        .card{
          border:1px solid rgba(255,255,255,.12);
          background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(0,0,0,.22));
          border-radius:18px;
          padding:14px 14px 12px;
          margin:12px 0;
          box-shadow:0 10px 30px rgba(0,0,0,.35);
        }
        .cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;}
        .cardTitle{font-weight:950;letter-spacing:.9px;text-transform:uppercase;}
        .pill{
          font-size:12px;
          border:1px solid rgba(255,255,255,.14);
          padding:6px 10px;
          border-radius:999px;
          opacity:.92;
          white-space:nowrap;
        }
        .errBox{
          border:1px solid rgba(255,80,80,.45);
          background:rgba(255,80,80,.08);
          padding:10px 12px;
          border-radius:14px;
          margin:10px 0 0;
        }

        .modalBack{
          position:fixed;
          inset:0;
          background:rgba(0,0,0,.72);
          display:flex;
          align-items:flex-end;
          justify-content:center;
          padding:14px;
          z-index:9999;
        }
        .modalCard{
          width:100%;
          max-width:640px;
          border:1px solid rgba(255,255,255,.12);
          background:linear-gradient(180deg, rgba(255,255,255,.07), rgba(0,0,0,.52));
          border-radius:18px;
          padding:14px;
          box-shadow:0 20px 70px rgba(0,0,0,.55);
        }
        .modalTitle{
          font-weight:950;
          letter-spacing:1px;
          text-transform:uppercase;
          font-size:18px;
        }

        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:end;}
        .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;align-items:stretch;}

        .kpi{
          border:1px solid rgba(255,255,255,.10);
          background:rgba(0,0,0,.28);
          border-radius:14px;
          padding:10px 10px;
          min-height:64px;
          display:flex;
          flex-direction:column;
          justify-content:space-between;
        }
        .kpi .k{font-size:11px;opacity:.75;letter-spacing:.9px;text-transform:uppercase}
        .kpi .v{font-size:18px;font-weight:950;letter-spacing:.4px}

        .rowActions{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
        .dayKey{
          margin-left:auto;
          font-size:12px;
          opacity:.75;
          letter-spacing:.8px;
          text-transform:uppercase;
          padding:8px 10px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.10);
          background:rgba(0,0,0,.22);
        }

        .field .label{font-size:12px;opacity:.8;margin-bottom:6px;letter-spacing:.8px;text-transform:uppercase;}
        .input{
          width:100%;
          height:44px;
          border-radius:14px;
          border:1px solid rgba(255,255,255,.12);
          background:rgba(0,0,0,.35);
          color:#fff;
          padding:0 12px;
          font-size:16px;
          outline:none;
        }
        textarea.input{
          height:auto;
          padding:10px 12px;
          line-height:1.25;
        }
        textarea.input{height:auto;padding:10px 12px;}
        .input:focus{border-color:rgba(99,165,255,.55);box-shadow:0 0 0 3px rgba(99,165,255,.12);}

        .btn{
          height:44px;
          border-radius:14px;
          border:1px solid rgba(99,165,255,.35);
          background:rgba(99,165,255,.18);
          color:#fff;
          font-weight:950;
          letter-spacing:.9px;
          text-transform:uppercase;
        }
        .btn:disabled{opacity:.55;cursor:not-allowed;}

        .ghostBtn{
          height:40px;
          padding:0 12px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.12);
          background:rgba(255,255,255,.06);
          display:inline-flex;
          align-items:center;
          justify-content:center;
          font-weight:900;
          letter-spacing:.9px;
          text-transform:uppercase;
        }
        .dangerBtn{
          height:40px;
          padding:0 12px;
          border-radius:999px;
          border:1px solid rgba(255,90,90,.35);
          background:rgba(255,90,90,.12);
          color:#fff;
          font-weight:950;
          letter-spacing:.9px;
          text-transform:uppercase;
        }

        .seg{display:flex;gap:8px;align-items:center;}
        .segBtn{
          height:34px;
          padding:0 12px;
          border-radius:999px;
          border:1px solid rgba(255,255,255,.12);
          background:rgba(255,255,255,.06);
          color:#fff;
          font-weight:900;
          letter-spacing:.8px;
          text-transform:uppercase;
        }
        .segOn{border-color:rgba(99,165,255,.5);background:rgba(99,165,255,.18);}

        .muted{opacity:.7;font-size:13px;letter-spacing:.3px;}

        .list{display:flex;flex-direction:column;gap:10px;margin-top:10px;}
        .moveRow{
          display:flex;
          justify-content:space-between;
          gap:10px;
          padding:12px 12px;
          border-radius:14px;
          border:1px solid rgba(255,255,255,.10);
          background:rgba(0,0,0,.25);
        }
        .moveType{display:flex;gap:10px;align-items:center;margin-bottom:6px;}
        .tag{font-size:11px;font-weight:950;letter-spacing:.9px;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.12);}
        .tagIn{border-color:rgba(80,220,160,.35);background:rgba(80,220,160,.10);}
        .tagOut{border-color:rgba(255,160,80,.35);background:rgba(255,160,80,.10);}
        .src{font-size:11px;opacity:.8;letter-spacing:.9px;text-transform:uppercase;}
        .note{font-size:14px;font-weight:800;letter-spacing:.2px;}
        .meta{opacity:.7;font-size:12px;margin-top:4px;}
        .moveAmt{display:flex;align-items:center;}
        .amt{font-size:18px;font-weight:950;letter-spacing:.3px;}
        .amtIn{color:#7ef0b6;}
        .amtOut{color:#ffb47e;}

        .bottomSpace{height:26px;}

        @media (max-width: 520px){
          .title{font-size:28px;}
          .grid4{grid-template-columns:repeat(2,1fr);}
          .kpi .v{font-size:17px;}
          .dayKey{margin-left:0;width:100%;text-align:center;}
          .topRow{align-items:flex-start}
        }`}</style>
    </div>
  );
}
