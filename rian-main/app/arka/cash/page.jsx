"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { dbAddMove, dbCanWork, dbGetOpenDay, dbListMoves } from "@/lib/arkaDb";

function fmtEUR(n) {
  const v = Number(n || 0);
  return v.toFixed(2);
}

function todayISO() {
  // Kosovo/Europe usage is fine; keep consistent with server by using local date.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function calcTotals(moves) {
  let fillimi = 0;
  let hyrje = 0;
  let dalje = 0;

  for (const m of moves || []) {
    const amt = Number(m.amount || 0);
    if (m.type === "OPEN") fillimi += amt;
    else if (m.type === "IN") hyrje += amt;
    else if (m.type === "OUT") dalje += amt;
  }
  const totali = fillimi + hyrje - dalje;
  return { fillimi, hyrje, dalje, totali };
}

export default function ArkaCash() {
  const [me, setMe] = useState({ name: "", role: "", mode: "LOCAL" });
  const [canWork, setCanWork] = useState(false);

  const [day, setDay] = useState(null);
  const [moves, setMoves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [tab, setTab] = useState("IN"); // IN | OUT
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const totals = useMemo(() => calcTotals(moves), [moves]);

  async function loadAll() {
    setLoading(true);
    setError("");

    try {
      const ok = await dbCanWork();
      setCanWork(!!ok);

      // Read current user (if you already store it elsewhere, we keep local fallback)
      try {
        const s = localStorage.getItem("tepiha_user");
        if (s) {
          const u = JSON.parse(s);
          setMe({
            name: (u?.name || u?.full_name || u?.username || "").toLowerCase(),
            role: (u?.role || "").toUpperCase(),
            mode: u?.mode ? String(u.mode).toUpperCase() : "LOCAL",
          });
        }
      } catch {}

      const open = await dbGetOpenDay();
      setDay(open || null);

      if (open?.id) {
        const list = await dbListMoves(open.id);
        // Sort newest first
        const sorted = (list || []).slice().sort((a, b) => {
          const ta = new Date(a.created_at || 0).getTime();
          const tb = new Date(b.created_at || 0).getTime();
          return tb - ta;
        });
        setMoves(sorted);
      } else {
        setMoves([]);
      }
    } catch (e) {
      setError(String(e?.message || e || "Gabim"));
    } finally {
      setLoading(false);
    }
  }

  async function addMove() {
    setError("");
    const amt = Number(String(amount).replace(",", "."));
    if (!amt || amt <= 0) {
      setError("Shkruje shumën.");
      return;
    }
    if (!day?.id) {
      setError("Nuk ka ditë të hapur. HAPE DITËN te BUXHETI.");
      return;
    }

    const payload = {
      day_id: day.id,
      type: tab === "OUT" ? "OUT" : "IN",
      amount: amt,
      note: note?.trim() || "",
      source: tab === "OUT" ? "MANUAL_OUT" : "MANUAL_IN",
      created_by: me?.name || "",
      created_at: new Date().toISOString(),
      // no order_id here; payments from PRANIMI/PASTRIMI/GATI use source=PAYMENT and include order_id.
    };

    try {
      await dbAddMove(payload);
      setAmount("");
      setNote("");
      await loadAll();
    } catch (e) {
      setError(String(e?.message || e || "Gabim"));
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dayLabel = day?.date || todayISO();

  return (
    <div className="pageWrap">
      <div className="topBar">
        <div>
          <div className="title">ARKA • CASH</div>
          <div className="subtitle">
            {me?.name || ""}
            {me?.role ? ` • ${me.role}` : ""}
            {me?.mode ? ` • ${me.mode}` : ""}
          </div>
        </div>
        <Link className="back" href="/arka">
          KTHEHU
        </Link>
      </div>

      <div className="panel">
        <div className="panelHead">
          <div className="panelTitle">SHTO LËVIZJE</div>
          <div className="panelRight">
            <span className="chip">DITA: {dayLabel}</span>
            {!canWork ? <span className="chip warn">DB OFF</span> : <span className="chip ok">DB ON</span>}
          </div>
        </div>

        {!day?.id ? (
          <div className="empty">
            NUK KA DITË TË HAPUR. Shko te <b>BUXHETI</b> dhe kliko <b>HAPE DITËN</b>.
          </div>
        ) : (
          <>
            <div className="tabs">
              <button className={tab === "IN" ? "tab active" : "tab"} onClick={() => setTab("IN")}>
                PAGESË
              </button>
              <button className={tab === "OUT" ? "tab active" : "tab"} onClick={() => setTab("OUT")}>
                SHPENZIM
              </button>
            </div>

            <div className="row">
              <input
                className="inp"
                placeholder="SHUMA (€)"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
              />
              <input
                className="inp"
                placeholder={tab === "OUT" ? "ARSYE / SHËNIM" : "SHËNIM (opsional)"}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button className="btn primary" onClick={addMove}>
                RUAJ
              </button>
              <Link className="btn ghost" href="/arka/buxheti">
                MBYLLE DITËN
              </Link>
            </div>

            {error ? <div className="err">{error}</div> : null}

            <div className="stats">
              <div className="stat">
                <div className="k">FILLIMI</div>
                <div className="v">€{fmtEUR(totals.fillimi)}</div>
              </div>
              <div className="stat">
                <div className="k">HYRJE</div>
                <div className="v">€{fmtEUR(totals.hyrje)}</div>
              </div>
              <div className="stat">
                <div className="k">DALJE</div>
                <div className="v">€{fmtEUR(totals.dalje)}</div>
              </div>
              <div className="stat total">
                <div className="k">TOTALI</div>
                <div className="v">€{fmtEUR(totals.totali)}</div>
              </div>
            </div>

            <div className="listHead">
              <div className="panelTitle">LËVIZJET</div>
              <div className="muted">{moves.length} RRESHTA</div>
            </div>

            {loading ? (
              <div className="empty">DUKE NGARKU…</div>
            ) : moves.length === 0 ? (
              <div className="empty">NUK KA LËVIZJE</div>
            ) : (
              <div className="cards">
                {moves.map((m) => (
                  <div key={m.id} className="card">
                    <div className="cardTop">
                      <div className="left">
                        <span className={m.type === "OUT" ? "badge out" : m.type === "IN" ? "badge in" : "badge"}>
                          {m.type}
                        </span>
                        {m.source ? <span className="badge soft">{String(m.source).toUpperCase()}</span> : null}
                        {m.order_id ? <span className="badge soft">ORD: {m.order_id}</span> : null}
                      </div>
                      <div className={m.type === "OUT" ? "amt out" : "amt in"}>€{fmtEUR(m.amount)}</div>
                    </div>
                    {m.note ? <div className="note">{m.note}</div> : null}
                    <div className="meta">
                      <span>{m.created_by ? String(m.created_by) : ""}</span>
                      <span>•</span>
                      <span>{m.created_at ? new Date(m.created_at).toLocaleString() : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="userBadge">
        <div className="uName">{me?.name || ""}</div>
        <div className="uRole">{me?.role || ""}</div>
        <Link className="logout" href="/logout">
          LOG OUT
        </Link>
      </div>

      <style jsx>{`
        .pageWrap {
          min-height: 100vh;
          background: #05070a;
          color: #fff;
          padding: 22px 16px 80px;
        }
        .topBar {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          margin-bottom: 14px;
        }
        .title {
          font-size: 42px;
          letter-spacing: 2px;
          font-weight: 900;
          text-transform: uppercase;
          line-height: 1;
        }
        .subtitle {
          margin-top: 10px;
          opacity: 0.7;
          text-transform: lowercase;
        }
        .back {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 10px 14px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          color: #fff;
          text-decoration: none;
          text-transform: uppercase;
          font-weight: 800;
          opacity: 0.9;
        }
        .panel {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 20px;
          background: rgba(255, 255, 255, 0.03);
          padding: 16px;
          max-width: 820px;
        }
        .panelHead {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .panelTitle {
          font-size: 18px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .panelRight {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .chip {
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          font-size: 12px;
          text-transform: uppercase;
          opacity: 0.9;
        }
        .chip.ok {
          border-color: rgba(48, 209, 88, 0.4);
        }
        .chip.warn {
          border-color: rgba(255, 159, 10, 0.4);
        }
        .tabs {
          display: flex;
          gap: 8px;
          margin: 10px 0 12px;
        }
        .tab {
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: transparent;
          color: #fff;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 1px;
          opacity: 0.9;
        }
        .tab.active {
          background: rgba(10, 132, 255, 0.18);
          border-color: rgba(10, 132, 255, 0.35);
        }
        .row {
          display: grid;
          grid-template-columns: 1.2fr 1.8fr auto auto;
          gap: 10px;
          align-items: center;
          margin-bottom: 12px;
        }
        .inp {
          width: 100%;
          padding: 11px 12px;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(0, 0, 0, 0.3);
          color: #fff;
          outline: none;
          text-transform: uppercase;
          font-weight: 800;
        }
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 10px 14px;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: transparent;
          color: #fff;
          text-decoration: none;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 1px;
          min-width: 92px;
        }
        .btn.primary {
          background: rgba(10, 132, 255, 0.18);
          border-color: rgba(10, 132, 255, 0.35);
        }
        .btn.ghost {
          opacity: 0.85;
        }
        .err {
          margin: 10px 0 0;
          padding: 10px 12px;
          border-radius: 14px;
          background: rgba(255, 59, 48, 0.12);
          border: 1px solid rgba(255, 59, 48, 0.28);
          font-weight: 800;
          text-transform: uppercase;
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
          margin: 14px 0;
        }
        .stat {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.03);
          padding: 12px;
        }
        .stat.total {
          border-color: rgba(10, 132, 255, 0.35);
          background: rgba(10, 132, 255, 0.09);
        }
        .k {
          opacity: 0.7;
          text-transform: uppercase;
          font-weight: 900;
          letter-spacing: 1px;
          font-size: 12px;
        }
        .v {
          margin-top: 6px;
          font-size: 20px;
          font-weight: 900;
        }
        .listHead {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 10px;
          margin-bottom: 10px;
        }
        .muted {
          opacity: 0.6;
          text-transform: uppercase;
          font-weight: 900;
          letter-spacing: 1px;
          font-size: 12px;
        }
        .cards {
          display: grid;
          gap: 10px;
        }
        .card {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 18px;
          background: rgba(0, 0, 0, 0.25);
          padding: 12px;
        }
        .cardTop {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .left {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }
        .badge {
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          font-size: 12px;
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        .badge.in {
          border-color: rgba(48, 209, 88, 0.35);
          background: rgba(48, 209, 88, 0.08);
        }
        .badge.out {
          border-color: rgba(255, 59, 48, 0.35);
          background: rgba(255, 59, 48, 0.08);
        }
        .badge.soft {
          opacity: 0.75;
        }
        .amt {
          font-size: 18px;
          font-weight: 900;
        }
        .amt.in {
          color: rgba(48, 209, 88, 0.95);
        }
        .amt.out {
          color: rgba(255, 59, 48, 0.95);
        }
        .note {
          margin-top: 8px;
          opacity: 0.9;
          font-weight: 800;
          text-transform: uppercase;
        }
        .meta {
          margin-top: 8px;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          opacity: 0.6;
          font-size: 12px;
          text-transform: uppercase;
          font-weight: 900;
          letter-spacing: 1px;
        }
        .empty {
          padding: 14px 10px;
          opacity: 0.75;
          text-transform: uppercase;
          font-weight: 900;
          letter-spacing: 1px;
        }
        .userBadge {
          position: fixed;
          right: 14px;
          bottom: 16px;
          padding: 10px 12px;
          border-radius: 16px;
          background: rgba(0, 0, 0, 0.55);
          border: 1px solid rgba(255, 255, 255, 0.12);
          text-transform: uppercase;
          font-weight: 900;
          letter-spacing: 1px;
          font-size: 12px;
        }
        .uName {
          opacity: 0.95;
        }
        .uRole {
          opacity: 0.7;
          margin-top: 2px;
        }
        .logout {
          margin-top: 6px;
          display: inline-block;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          text-decoration: none;
          color: #fff;
          opacity: 0.9;
        }
        @media (max-width: 760px) {
          .title {
            font-size: 40px;
          }
          .row {
            grid-template-columns: 1fr 1fr;
          }
          .stats {
            grid-template-columns: 1fr 1fr;
          }
        }
      `}</style>
    </div>
  );
}
