"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import {
  dbGetOpenDay,
  dbOpenDay,
  dbCloseDay,
  dbListMoves,
  dbAddMove,
  dbHandoffToDispatch,
} from "../../../lib/arkaDb";
import { findUserByPin as findUserByPinDb } from "../../../lib/usersDb";

const fmtEur = (n) => {
  const x = Number(n || 0);
  return x.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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

  const dayKey = todayKey();

  const [day, setDay] = useState(null); // OPEN day only
  const [moves, setMoves] = useState([]);

  const [opening, setOpening] = useState("0");

  const [mode, setMode] = useState("IN"); // IN | OUT
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // PIN modal
  const [showPin, setShowPin] = useState(false);
  const [pinTitle, setPinTitle] = useState("");
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinAction, setPinAction] = useState(null); // async (user)=>void

  // Close modal
  const [showClose, setShowClose] = useState(false);
  const [counted, setCounted] = useState("");
  const [closeNote, setCloseNote] = useState("");

  // After closing, allow handoff + show status
  const [lastClosed, setLastClosed] = useState(null);

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
      expected: initial + inSum - outSum,
    };
  }, [day, moves]);

  async function loadMe() {
    try {
      const raw =
        localStorage.getItem("CURRENT_USER_DATA") ||
        localStorage.getItem("arka_user");
      if (raw) setMe(JSON.parse(raw));
    } catch {}
  }

  async function refresh() {
    setErr("");
    try {
      const d = await dbGetOpenDay(dayKey);
      setDay(d || null);
      if (d?.id) {
        const list = await dbListMoves(d.id);
        setMoves(Array.isArray(list) ? list : []);
      } else {
        setMoves([]);
      }
    } catch (e) {
      setErr(e?.message || "Gabim gjatë ngarkimit.");
    }
  }

  useEffect(() => {
    loadMe().then(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requirePin(title, action) {
    setPinTitle(title);
    setPinAction(() => action);
    setPinValue("");
    setPinError("");
    setShowPin(true);
  }

  async function submitPin() {
    const clean = String(pinValue || "")
      .replace(/\D+/g, "")
      .slice(0, 4);
    if (!clean || clean.length !== 4) {
      setPinError("SHKRUAJ PIN");
      return;
    }
    setPinError("");
    try {
      // Cloud-first lookup (same as /login). Expected payload: { ok: true, user: {...} }
      let match = null;
      try {
        const res = await findUserByPinDb(clean);
        if (res?.ok && res?.user) match = res.user;
      } catch {
        // ignore
      }

      // Local fallback (same key used by /login local mode)
      if (!match) {
        try {
          const raw = localStorage.getItem("arka_workers_v1");
          const arr = raw ? JSON.parse(raw) : [];
          const users = Array.isArray(arr) ? arr : [];
          match = users.find((x) => String(x?.pin) === clean && x?.active !== false);
        } catch {
          // ignore
        }
      }

      if (!match) {
        setPinError("PIN I GABUAR");
        return;
      }

      const u = {
        id: match.id || match.user_id || match.uid || "user",
        name: match.name || "PUNTOR",
        role: match.role || "PUNTOR",
      };
      setShowPin(false);
      if (typeof pinAction === "function") await pinAction(u);
    } catch (e) {
      setPinError(e?.message || "GABIM PIN");
    }
  }

  async function onOpenDay() {
    await requirePin("HAP DITËN (PIN)", async (u) => {
      setBusy(true);
      setErr("");
      try {
        const opened_by = u?.name || me?.name || "LOCAL";
        const init = Number(String(opening || "0").replace(",", "."));
        const d = await dbOpenDay({
          day_key: dayKey,
          initial_cash: Number.isFinite(init) ? init : 0,
          opened_by,
        });
        setDay(d || null);
        if (d?.id) {
          const list = await dbListMoves(d.id);
          setMoves(Array.isArray(list) ? list : []);
        } else {
          setMoves([]);
        }
      } catch (e) {
        setErr(e?.message || "S’u hap dita.");
      } finally {
        setBusy(false);
      }
    });
  }

  function onCloseDay() {
    if (!day?.id) return;
    setCounted("");
    setCloseNote("");
    setShowClose(true);
  }

  async function confirmCloseDay() {
    if (!day?.id) return;

    const expected = Number(totals.expected || 0);
    const countedNum = Number(String(counted || "").replace(",", "."));
    if (!Number.isFinite(countedNum)) {
      setErr("Shkruaj CASH REAL (numëruar).");
      return;
    }

    await requirePin("MBYLL DITËN (PIN)", async (u) => {
      setBusy(true);
      setErr("");
      try {
        const closed_by = u?.name || me?.name || "LOCAL";
        const res = await dbCloseDay({
          day_id: day.id,
          closed_by,
          expected_cash: expected,
          cash_counted: countedNum,
          discrepancy: countedNum - expected,
          close_note: (closeNote || "").trim() || null,
        });

        setLastClosed(res || { ...day, closed_by });
        setShowClose(false);

        // CASH screen should show ONLY OPEN day. After close, hide everything.
        setDay(null);
        setMoves([]);
        setOpening("0");
      } catch (e) {
        setErr(e?.message || "S’u mbyll dita.");
      } finally {
        setBusy(false);
      }
    });
  }

  async function onHandoff() {
    if (!lastClosed?.id) return;

    await requirePin("DORËZO TE DISPATCH (PIN)", async (u) => {
      setBusy(true);
      setErr("");
      try {
        const handed_by = u?.name || me?.name || "LOCAL";
        const updated = await dbHandoffToDispatch({
          day_id: lastClosed.id,
          handed_by,
        });
        setLastClosed(updated || { ...lastClosed, handoff_status: "HANDED" });
      } catch (e) {
        setErr(e?.message || "S’u dorëzua.");
      } finally {
        setBusy(false);
      }
    });
  }

  async function onAddMove() {
    if (!day?.id) {
      setErr("HAPE DITËN fillimisht.");
      return;
    }

    const n = Number(String(amount || "").replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) {
      setErr("Shuma duhet me qenë > 0.");
      return;
    }

    setBusy(true);
    setErr("");
    try {
      const payload = {
        day_id: day.id,
        type: mode,
        amount: n,
        note: (note || "").trim() || null,
        source: "MANUAL",
        created_by: me?.name || "LOCAL",
        external_id: null,
      };

      const inserted = await dbAddMove(payload);
      setMoves((prev) => [inserted, ...(prev || [])]);
      setAmount("");
      setNote("");
    } catch (e) {
      setErr(e?.message || "S’u ruajt lëvizja.");
    } finally {
      setBusy(false);
    }
  }

  const canHandoff = useMemo(() => {
    if (!lastClosed) return false;
    const status = String(lastClosed.handoff_status || "PENDING");
    if (status === "RECEIVED") return false;
    // Prefer: only the closer can handoff. Allow ADMIN too.
    const closer = String(lastClosed.closed_by || "");
    const myName = String(me?.name || "");
    if (!myName) return true; // if no user loaded, still show (LOCAL)
    if (me?.role === "ADMIN") return true;
    return closer && closer === myName;
  }, [lastClosed, me]);

  return (
    <div className="pageWrap">
      <div className="topRow">
        <div>
          <div className="title">ARKA • CASH</div>
          <div className="sub">
            {(me?.name || "LOCAL").toLowerCase()} • {(me?.role || "ADMIN")} • {dayKey}
          </div>
        </div>
        <div className="topActions">
          <Link href="/arka/buxheti" className="btn ghost">
            COMPANY BUDGET
          </Link>
          <Link href="/arka" className="btn ghost">
            KTHEHU
          </Link>
        </div>
      </div>

      {err ? <div className="errorBox">{err}</div> : null}

      {/* OPEN DAY PANEL */}
      {!day ? (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <div className="h2">DITA ËSHTË E MBYLLUR</div>
              <div className="muted">Për me pranu pagesa, hape ditën me PIN.</div>
            </div>
            <button className="btn" disabled={busy} onClick={refresh}>
              RIFRESKO
            </button>
          </div>

          <div className="grid2" style={{ marginTop: 12 }}>
            <div>
              <div className="label">FILLIMI (€)</div>
              <input
                className="input"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                inputMode="decimal"
                placeholder="0"
              />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button className="btn primary" disabled={busy} onClick={onOpenDay}>
                HAP DITËN
              </button>
            </div>
          </div>

          {lastClosed ? (
            <div className="sep" style={{ marginTop: 14 }}>
              <div className="muted">DITA E FUNDIT E MBYLLUR</div>
              <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
                <div>
                  <div className="strong">{lastClosed.day_key || "(pa datë)"}</div>
                  <div className="muted">
                    Closed by: {lastClosed.closed_by || "?"} • Status: {lastClosed.handoff_status || "PENDING"}
                  </div>
                </div>
                {canHandoff ? (
                  <button className="btn" disabled={busy} onClick={onHandoff}>
                    DORËZO TE DISPATCH
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* OPEN DAY SUMMARY */}
          <div className="statsRow">
            <div className="statCard">
              <div className="muted">FILLIMI</div>
              <div className="big">€{fmtEur(totals.initial)}</div>
            </div>
            <div className="statCard">
              <div className="muted">HYRJE</div>
              <div className="big">€{fmtEur(totals.inSum)}</div>
            </div>
            <div className="statCard">
              <div className="muted">DALJE</div>
              <div className="big">€{fmtEur(totals.outSum)}</div>
            </div>
            <div className="statCard">
              <div className="muted">CASH PRITET</div>
              <div className="big">€{fmtEur(totals.expected)}</div>
            </div>
          </div>

          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div className="h2">DITA ËSHTË OPEN</div>
                <div className="muted">{day.day_key} • opened by: {day.opened_by || "?"}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" disabled={busy} onClick={refresh}>
                  RIFRESKO
                </button>
                <button className="btn danger" disabled={busy} onClick={onCloseDay}>
                  MBYLL DITËN
                </button>
              </div>
            </div>

            {/* ADD MOVE */}
            <div className="grid3" style={{ marginTop: 12 }}>
              <div>
                <div className="label">LLOJI</div>
                <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="IN">HYRJE</option>
                  <option value="OUT">DALJE</option>
                </select>
              </div>
              <div>
                <div className="label">SHUMA (€)</div>
                <input
                  className="input"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                />
              </div>
              <div>
                <div className="label">SHËNIM</div>
                <input
                  className="input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="opsionale"
                />
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="btn primary" disabled={busy} onClick={onAddMove}>
                SHTO LËVIZJE
              </button>
            </div>

            {/* MOVES */}
            <div className="sep" style={{ marginTop: 14 }}>
              <div className="muted">LËVIZJET ({moves.length})</div>
              <div className="list">
                {(moves || []).map((m) => (
                  <div key={m.id || `${m.type}-${m.created_at}-${m.amount}`} className="rowline">
                    <div className="left">
                      <div className="strong">{m.type === "IN" ? "HYRJE" : "DALJE"}</div>
                      <div className="muted">{m.note || m.source || ""}</div>
                    </div>
                    <div className="right strong">€{fmtEur(m.amount)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* PIN MODAL */}
      {showPin ? (
        <div className="modalBack">
          <div className="modalCard">
            <div className="modalTitle">{pinTitle}</div>
            <div className="label">PIN</div>
            <input
              className="input"
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value)}
              inputMode="numeric"
              placeholder="****"
            />
            {pinError ? <div className="errorBox" style={{ marginTop: 8 }}>{pinError}</div> : null}
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button className="btn ghost" onClick={() => setShowPin(false)}>
                ANULO
              </button>
              <button className="btn primary" onClick={submitPin}>
                VAZHDO
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* CLOSE MODAL */}
      {showClose ? (
        <div className="modalBack">
          <div className="modalCard">
            <div className="modalTitle">MBYLLJA E DITËS</div>

            <div className="grid2">
              <div>
                <div className="muted">FILLIMI</div>
                <div className="strong">€{fmtEur(totals.initial)}</div>
              </div>
              <div>
                <div className="muted">CASH PRITET</div>
                <div className="strong">€{fmtEur(totals.expected)}</div>
              </div>
              <div>
                <div className="muted">HYRJE</div>
                <div className="strong">€{fmtEur(totals.inSum)}</div>
              </div>
              <div>
                <div className="muted">DALJE</div>
                <div className="strong">€{fmtEur(totals.outSum)}</div>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div className="label">CASH REAL (NUMËRUAR)</div>
              <input
                className="input"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
                inputMode="decimal"
                placeholder="0"
              />
            </div>

            <div style={{ marginTop: 10 }}>
              <div className="label">SHËNIM (opsionale)</div>
              <input
                className="input"
                value={closeNote}
                onChange={(e) => setCloseNote(e.target.value)}
                placeholder="p.sh. dorëzim te dispatch"
              />
            </div>

            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button className="btn ghost" onClick={() => setShowClose(false)}>
                ANULO
              </button>
              <button className="btn danger" disabled={busy} onClick={confirmCloseDay}>
                KONFIRMO MBYLLJEN
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
