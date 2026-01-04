"use client";
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { dbAddExpense, dbGetTodayDay, dbGetActiveCycle } from "@/lib/arkaDb";
import { findUserByPin } from "@/lib/usersDb";

const euro = (n) =>
  `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeParseMoney(v) {
  const s = String(v ?? "")
    .trim()
    .replace("€", "")
    .replace(/\s/g, "")
    .replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export default function Page() {
  const [busy, setBusy] = useState(false);

  // context
  const [dayKey, setDayKey] = useState(dayKeyLocal(new Date()));
  const [cycleOpen, setCycleOpen] = useState(false);

  // form
  const [amount, setAmount] = useState("");
  const [paidFrom, setPaidFrom] = useState("CASH_TODAY"); // CASH_TODAY | COMPANY_BUDGET | PERSONAL
  const [pin, setPin] = useState("");
  const [pinUser, setPinUser] = useState(null);

  const [category, setCategory] = useState("TË TJERA");
  const [note, setNote] = useState("");

  // list
  const [rows, setRows] = useState([]);

  const personalRequired = useMemo(() => paidFrom === "PERSONAL", [paidFrom]);
  const cashRequired = useMemo(() => paidFrom === "CASH_TODAY", [paidFrom]);

  async function loadExpensesForDay(dk) {
    // disa DB s’kanë kolonë "at". provojmë me radhë.
    const tryOrder = async (col) => {
      const q = await supabase
        .from("arka_expenses")
        .select("*")
        .eq("day_key", dk)
        .order(col, { ascending: false });
      return q;
    };

    let q = await tryOrder("at");
    if (q.error) q = await tryOrder("created_at");
    if (q.error) {
      q = await supabase.from("arka_expenses").select("*").eq("day_key", dk);
    }

    const data = q.data || [];

    const ts = (r) => {
      const v = r?.at || r?.created_at || r?.inserted_at || r?.createdAt;
      const t = v ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : 0;
    };

    return data.slice().sort((a, b) => ts(b) - ts(a));
  }

  async function refresh() {
    try {
      const day = await dbGetTodayDay();
      const dk = day?.day_key || dayKeyLocal(new Date());
      setDayKey(dk);

      const c = await dbGetActiveCycle().catch(() => null);
      setCycleOpen(!!c?.id);

      const exp = await loadExpensesForDay(dk);
      setRows(exp);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // resolve PIN -> user
  useEffect(() => {
    (async () => {
      if (!personalRequired) {
        setPinUser(null);
        return;
      }
      const p = String(pin || "").trim();
      if (p.length < 3) {
        setPinUser(null);
        return;
      }
      try {
        // usersDb.findUserByPin kthen {ok,item}
        const res = await findUserByPin(p);
        setPinUser(res?.ok ? res.item : null);
      } catch {
        setPinUser(null);
      }
    })();
  }, [pin, personalRequired]);

  async function submitExpense() {
    const amt = safeParseMoney(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return alert("SHKRUJ NJË SHUMË VALIDE (> 0).");
    }

    if (cashRequired && !cycleOpen) {
      return alert(
        "S’KA CIKËL OPEN. SHKO TE ARKA • CASH DHE HAPE CIKLIN PARA SHPENZIMEVE CASH."
      );
    }

    if (personalRequired) {
      if (!String(pin || "").trim()) {
        return alert("PIN ËSHTË I DETYRUESHËM PËR PERSONAL.");
      }
      if (!pinUser?.pin) return alert("PIN NUK U GJET TE PUNTORËT.");
    }

    setBusy(true);
    try {
      const createdBy =
        personalRequired && pinUser?.pin
          ? `${pinUser?.name || "PERSONAL"} (${pinUser.pin})`
          : "LOCAL";

      await dbAddExpense({
        amount: amt,
        paid_from: paidFrom,
        category,
        note,
        personal_pin: personalRequired ? String(pin).trim() : "",
        created_by: createdBy,
      });

      // reset inputs
      setAmount("");
      setNote("");
      if (personalRequired) setPin("");

      await refresh();
    } catch (e) {
      alert(e?.message || "GABIM TE SHPENZIMI.");
    } finally {
      setBusy(false);
    }
  }

  const paidFromLabel =
    paidFrom === "CASH_TODAY"
      ? "ARKA (CASH SOT)"
      : paidFrom === "COMPANY_BUDGET"
      ? "BUXHETI I KOMPANISË"
      : "PERSONAL";

  return (
    <div className="pageWrap">
      <div className="topRow">
        <div className="hLeft">
          <div className="title">ARKA</div>
          <div className="subnav">
            <span className="subItem">CASH</span>
            <span className="dot">•</span>
            <span className="subItem">HISTORI</span>
            <span className="dot">•</span>
            <span className="subItem">PUNTORË</span>
            <span className="dot">•</span>
            <span className="subItem active">SHPENZIME</span>
          </div>
        </div>
        <div className="hRight">
          <Link className="homeBtn" href="/arka">
            KTHEHU
          </Link>
        </div>
      </div>

      <div className="meta">
        <div className="metaRow">
          <span className="metaK">DITA</span>
          <span className="metaV">{dayKey}</span>
        </div>
        <div className="metaRow">
          <span className="metaK">CIKLI</span>
          <span className={`metaV ${cycleOpen ? "ok" : "warn"}`}>
            {cycleOpen ? "OPEN" : "JO OPEN"}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="cardTitle">SHTO SHPENZIM</div>

        <div className="row2">
          <div className="field">
            <div className="lbl">SHUMA (€)</div>
            <input
              className="inp"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="p.sh. 10"
            />
          </div>

          <div className="field">
            <div className="lbl">BURIMI I PARAVE</div>
            <div className="seg">
              <button
                className={`segBtn ${paidFrom === "CASH_TODAY" ? "on" : ""}`}
                onClick={() => setPaidFrom("CASH_TODAY")}
                type="button"
              >
                ARKA
              </button>
              <button
                className={`segBtn ${paidFrom === "COMPANY_BUDGET" ? "on" : ""}`}
                onClick={() => setPaidFrom("COMPANY_BUDGET")}
                type="button"
              >
                BUXHET
              </button>
              <button
                className={`segBtn ${paidFrom === "PERSONAL" ? "on" : ""}`}
                onClick={() => setPaidFrom("PERSONAL")}
                type="button"
              >
                PERSONAL
              </button>
            </div>
            <div className="mini">{paidFromLabel}</div>
          </div>
        </div>

        {personalRequired && (
          <div className="field" style={{ marginTop: 10 }}>
            <div className="lbl">PIN (KUSH I DHA)</div>
            <input
              className="inp"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="PIN"
            />
            <div className="hint">
              {pinUser?.name ? (
                <>
                  ✅ {pinUser.name.toUpperCase()} {pinUser.role ? `• ${String(pinUser.role).toUpperCase()}` : ""}
                </>
              ) : (
                <>* PIN DUHET ME EKZISTU TE PUNTORËT</>
              )}
            </div>
          </div>
        )}

        <div className="row2" style={{ marginTop: 10 }}>
          <div className="field">
            <div className="lbl">KATEGORIA</div>
            <div className="chips">
              {["KARBURANT", "MATERIALE", "PUNËTORË", "TRANSPORT", "SERVIS", "TË TJERA"].map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip ${category === c ? "on" : ""}`}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="lbl">SHËNIM</div>
            <input
              className="inp"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="p.sh. bleva detergjent"
            />
          </div>
        </div>

        <div className="noteBox">
          {paidFrom === "CASH_TODAY" && (
            <div>
              • DEL SI <b>OUT</b> NË ARKË DHE E UL <b>EXPECTED CASH</b>.
            </div>
          )}
          {paidFrom === "COMPANY_BUDGET" && <div>• JO CASH (S’PREK ARKËN).</div>}
          {paidFrom === "PERSONAL" && <div>• PERSONAL (S’PREK ARKËN) + RUHET “KUSH E DHA”.</div>}
        </div>

        <button className="primaryBtn" onClick={submitExpense} disabled={busy}>
          {busy ? "DUKE RUYT..." : "RUJ SHPENZIMIN"}
        </button>
      </div>

      <div className="card">
        <div className="cardTitle">SHPENZIMET SOT</div>

        {rows.length === 0 ? (
          <div className="muted">S’KA SHPENZIME PËR SOT.</div>
        ) : (
          <div className="list">
            {rows.map((r) => {
              const pf = String(r.paid_from || "").toUpperCase();
              const badge = pf === "CASH_TODAY" ? "ARKA" : pf === "COMPANY_BUDGET" ? "BUXHET" : "PERSONAL";
              return (
                <div className="row" key={r.id}>
                  <div className="left">
                    <div className="top">
                      <span className={`pill ${pf}`}>{badge}</span>
                      <span className="cat">{String(r.category || "—").toUpperCase()}</span>
                      {r.personal_pin ? <span className="pin">PIN: {r.personal_pin}</span> : null}
                    </div>
                    <div className="note">{r.note ? String(r.note) : "—"}</div>
                  </div>
                  <div className="amt">{euro(r.amount)}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <style jsx>{`
        .pageWrap{max-width:980px;margin:0 auto;padding:18px 14px 40px;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:10px;}
        .title{font-size:28px;letter-spacing:1px;font-weight:900;}
        .subnav{margin-top:6px;opacity:.75;font-size:12px;letter-spacing:1px;text-transform:uppercase;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
        .subItem{opacity:.75}
        .subItem.active{opacity:1;font-weight:900}
        .dot{opacity:.45}
        .homeBtn{height:40px;padding:0 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);display:inline-flex;align-items:center;justify-content:center;font-weight:900;letter-spacing:.8px;text-transform:uppercase;}

        .meta{border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);border-radius:16px;padding:10px 12px;margin:12px 0;}
        .metaRow{display:flex;justify-content:space-between;gap:10px;padding:6px 0;}
        .metaK{opacity:.7;font-weight:900;letter-spacing:1px;text-transform:uppercase;font-size:12px;}
        .metaV{font-weight:900;letter-spacing:1px;text-transform:uppercase;font-size:12px;}
        .metaV.ok{color:#22c55e;}
        .metaV.warn{color:#f59e0b;}

        .card{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);border-radius:16px;padding:14px 14px 12px;margin:12px 0;}
        .cardTitle{font-weight:900;letter-spacing:1px;text-transform:uppercase;margin-bottom:12px;opacity:.92;}

        .row2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;}
        @media (max-width:720px){.row2{grid-template-columns:1fr;}}
        .field{display:flex;flex-direction:column;gap:6px;}
        .lbl{font-size:12px;letter-spacing:1px;font-weight:900;opacity:.8;text-transform:uppercase;}

        .inp{height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);padding:0 12px;color:#fff;font-weight:900;letter-spacing:.6px;outline:none;text-transform:uppercase;}
        .inp::placeholder{opacity:.55;text-transform:none;}
        .hint{font-size:12px;opacity:.75;margin-top:2px;letter-spacing:.6px;text-transform:uppercase;}

        .seg{display:flex;gap:8px;}
        .segBtn{flex:1;height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);font-weight:900;letter-spacing:1px;text-transform:uppercase;}
        .segBtn.on{outline:2px solid rgba(59,130,246,.25);background:rgba(59,130,246,.10);}
        .mini{opacity:.7;font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-top:2px;}

        .chips{display:flex;flex-wrap:wrap;gap:8px;}
        .chip{height:38px;padding:0 10px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);font-weight:900;letter-spacing:1px;text-transform:uppercase;font-size:12px;}
        .chip.on{outline:2px solid rgba(34,197,94,.22);background:rgba(34,197,94,.10);}

        .noteBox{margin-top:10px;border:1px dashed rgba(255,255,255,.12);border-radius:12px;padding:10px;opacity:.9;font-size:12px;line-height:1.35;letter-spacing:.5px;text-transform:uppercase;}
        .primaryBtn{margin-top:12px;width:100%;height:46px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.10);font-weight:900;letter-spacing:1px;text-transform:uppercase;}
        .primaryBtn:disabled{opacity:.55;}

        .muted{opacity:.7;padding:8px 0;letter-spacing:.8px;text-transform:uppercase;}

        .list{display:flex;flex-direction:column;gap:10px;margin-top:10px;}
        .row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.22);border-radius:14px;padding:12px;}
        .left{flex:1;min-width:0;}
        .top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
        .pill{display:inline-flex;align-items:center;justify-content:center;padding:4px 10px;border-radius:999px;font-weight:900;letter-spacing:1px;font-size:11px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);text-transform:uppercase;}
        .pill.CASH_TODAY{outline:2px solid rgba(34,197,94,.25);}
        .pill.COMPANY_BUDGET{outline:2px solid rgba(59,130,246,.22);}
        .pill.PERSONAL{outline:2px solid rgba(245,158,11,.22);}
        .cat{font-weight:900;letter-spacing:1px;font-size:12px;opacity:.9;text-transform:uppercase;}
        .pin{font-weight:900;letter-spacing:1px;font-size:12px;opacity:.75;text-transform:uppercase;}
        .note{margin-top:6px;opacity:.85;word-break:break-word;line-height:1.25;}
        .amt{font-weight:900;letter-spacing:1px;font-size:16px;white-space:nowrap;}
      `}</style>
    </div>
  );
}
