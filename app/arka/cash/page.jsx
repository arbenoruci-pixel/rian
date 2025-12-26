"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../../lib/supabaseClient";
import { dbGetOpenDay, dbOpenDay, dbCloseDay, dbListMoves, dbAddMove } from "../../../lib/arkaDb";

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
    setBusy(true);
    setErr("");
    try {
      const closed_by = me?.name || "LOCAL";
      await dbCloseDay({ day_id: day.id, closed_by });
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
          <Link className="ghostBtn" href="/arka">
            KTHEHU
          </Link>
        </div>
      </div>

      {!!err && <div className="errBox">{err}</div>}

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

      <style jsx>{`
        .pageWrap{max-width:980px;margin:0 auto;padding:18px 14px 40px;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:14px;}
        .title{font-size:34px;letter-spacing:1px;font-weight:900;}
        .sub{opacity:.75;margin-top:4px;font-size:13px;letter-spacing:.8px;text-transform:uppercase;}
        .topActions{display:flex;gap:10px;align-items:center;}
        .card{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);border-radius:16px;padding:14px 14px 12px;margin:12px 0;}
        .cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}
        .cardTitle{font-weight:900;letter-spacing:.8px;}
        .pill{font-size:12px;border:1px solid rgba(255,255,255,.14);padding:6px 10px;border-radius:999px;opacity:.9;}
        .errBox{border:1px solid rgba(255,80,80,.35);background:rgba(255,80,80,.08);padding:10px 12px;border-radius:12px;margin:10px 0;}
        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:end;}
        .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;align-items:stretch;}
        .field .label{font-size:12px;opacity:.8;margin-bottom:6px;letter-spacing:.7px;}
        .input{width:100%;height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.35);color:#fff;padding:0 12px;font-size:16px;outline:none;}
        .btn{height:44px;border-radius:12px;border:1px solid rgba(99,165,255,.55);background:rgba(99,165,255,.15);color:#fff;font-weight:900;letter-spacing:.8px;}
        .ghostBtn{height:40px;padding:0 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);display:inline-flex;align-items:center;justify-content:center;font-weight:800;letter-spacing:.6px;}
        .dangerBtn{height:40px;padding:0 12px;border-radius:12px;border:1px solid rgba(255,80,80,.4);background:rgba(255,80,80,.12);font-weight:900;letter-spacing:.6px;}
        .hint{font-size:12px;opacity:.72;align-self:center;}
        .kpi{border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.25);border-radius:14px;padding:10px 12px;}
        .kpi .k{font-size:12px;opacity:.75;letter-spacing:.7px;}
        .kpi .v{font-size:20px;font-weight:900;margin-top:6px;}
        .rowActions{grid-column:1 / -1;display:flex;gap:10px;align-items:center;justify-content:flex-start;margin-top:6px;}
        .dayKey{margin-left:auto;opacity:.75;font-size:12px;letter-spacing:.7px;}
        .seg{display:flex;gap:8px;align-items:center;}
        .segBtn{height:34px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);font-weight:900;letter-spacing:.6px;}
        .segOn{border-color:rgba(99,165,255,.6);background:rgba(99,165,255,.18);}
        .list{display:flex;flex-direction:column;gap:8px;}
        .moveRow{display:flex;justify-content:space-between;gap:12px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.22);border-radius:14px;padding:10px 12px;}
        .moveLeft{min-width:0;flex:1;}
        .moveType{display:flex;gap:8px;align-items:center;}
        .tag{font-size:11px;font-weight:900;letter-spacing:.8px;border-radius:999px;padding:4px 10px;border:1px solid rgba(255,255,255,.14);}
        .tagIn{border-color:rgba(80,220,140,.35);background:rgba(80,220,140,.12);}
        .tagOut{border-color:rgba(255,100,100,.35);background:rgba(255,100,100,.10);}
        .src{font-size:11px;opacity:.75;letter-spacing:.7px;}
        .note{margin-top:6px;font-size:14px;opacity:.95;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .meta{margin-top:6px;font-size:11px;opacity:.65;letter-spacing:.6px;}
        .moveAmt{display:flex;align-items:center;justify-content:flex-end;min-width:120px;}
        .amt{font-size:18px;font-weight:900;}
        .amtIn{color:#63ffa5;}
        .amtOut{color:#ff7b7b;}
        .muted{opacity:.7;padding:8px 0;}
        .bottomSpace{height:10px;}
        @media(max-width:720px){
          .grid2{grid-template-columns:1fr;}
          .grid4{grid-template-columns:1fr 1fr;}
          .title{font-size:30px;}
        }
      `}</style>
    </div>
  );
}
