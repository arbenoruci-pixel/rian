"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listApprovers, createExpenseRequest, listMyRequests } from "@/lib/arkaRequestsDb";

const euro = (n) =>
  `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

function parseEuroInput(v) {
  const s = String(v ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

export default function ShpenzimePage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [approvers, setApprovers] = useState([]);
  const [my, setMy] = useState([]);

  const [form, setForm] = useState({
    amount: "",
    req_type: "SHPENZIM", // SHPENZIM | AVANS
    source: "ARKA", // ARKA | BUXHETI
    approver_pin: "",
    reason: "",
  });

  const canSubmit = useMemo(() => {
    const amt = parseEuroInput(form.amount);
    return Number.isFinite(amt) && amt > 0 && !!String(form.approver_pin || "").trim();
  }, [form.amount, form.approver_pin]);

  useEffect(() => {
    const u = (() => {
      try {
        return JSON.parse(localStorage.getItem("CURRENT_USER_DATA")) || null;
      } catch {
        return null;
      }
    })();
    if (!u) {
      router.push("/login");
      return;
    }
    setUser(u);

    (async () => {
      try {
        const aps = await listApprovers();
        setApprovers(aps || []);
      } catch (e) {
        setErr(e?.message || String(e));
      }
    })();
  }, [router]);

  async function reloadMine(u = user) {
    if (!u?.pin) return;
    try {
      const rows = await listMyRequests(u.pin, 50);
      setMy(rows || []);
    } catch (e) {
      // non-blocking
    }
  }

  useEffect(() => {
    if (!user) return;
    reloadMine(user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function submit() {
    if (!user?.pin) {
      setErr("DUHET ME HY NË SISTEM PËRME PIN");
      return;
    }

    setErr("");
    setBusy(true);
    try {
      const amt = parseEuroInput(form.amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("SHUMA DUHET > 0");

      const ap = approvers.find((a) => String(a.pin) === String(form.approver_pin));
      if (!ap) throw new Error("ZGJIDH KUSH PO E APROVON");

      await createExpenseRequest({
        amount: amt,
        req_type: form.req_type,
        source: form.source,
        reason: form.reason,
        requested_by_pin: user.pin,
        requested_by_name: user.name,
        target_approver_pin: ap.pin,
        target_approver_name: ap.name,
      });

      setForm((f) => ({ ...f, amount: "", reason: "" }));
      await reloadMine(user);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;

  return (
    <div className="pageWrap">
      <div className="topRow">
        <div>
          <div className="title">ARKA • SHPENZIME</div>
          <div className="sub">{user.name} • {user.role}</div>
        </div>
        <Link className="ghostBtn" href="/arka">KTHEHU</Link>
      </div>

      {err ? <div className="err">{err}</div> : null}

      <div className="card">
        <div className="cardTitle">KËRKO APROVIM</div>

        <div className="row">
          <select
            value={form.req_type}
            onChange={(e) => setForm((f) => ({ ...f, req_type: e.target.value }))}
            className="input"
          >
            <option value="SHPENZIM">SHPENZIM (KOMPANI)</option>
            <option value="AVANS">AVANS (PERSONAL)</option>
          </select>
          <select
            value={form.source}
            onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
            className="input"
          >
            <option value="ARKA">BURIMI: ARKA</option>
            <option value="BUXHETI">BURIMI: BUXHETI</option>
          </select>
        </div>

        <input
          value={form.amount}
          onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
          inputMode="decimal"
          placeholder="SHUMA (€)"
          className="input"
        />

        <select
          value={form.approver_pin}
          onChange={(e) => setForm((f) => ({ ...f, approver_pin: e.target.value }))}
          className="input"
        >
          <option value="">KUSH PO E APROVON?</option>
          {approvers.map((a) => (
            <option key={a.id} value={a.pin}>
              {String(a.name || "").toUpperCase()} • {String(a.role || "").toUpperCase()}
            </option>
          ))}
        </select>

        <textarea
          value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          placeholder="ARSYE (opsional)"
          className="input"
          rows={3}
        />

        <button
          disabled={busy || !canSubmit}
          onClick={submit}
          className="primary"
        >
          {busy ? "DUKE DËRGUAR…" : "DËRGO KËRKESË"}
        </button>
      </div>

      <div className="card">
        <div className="cardTitle">KËRKESAT E MIA</div>
        {my.length === 0 ? (
          <div className="muted">S’KA KËRKESA.</div>
        ) : (
          <div className="list">
            {my.map((r) => (
              <div key={r.id} className="item">
                <div className="itemTop">
                  <div className="strong">{euro(r.amount)} • {String(r.req_type).toUpperCase()} • {String(r.source).toUpperCase()}</div>
                  <div className={`badge ${String(r.status).toUpperCase()}`}>{String(r.status).toUpperCase()}</div>
                </div>
                <div className="muted">APROVON: {String(r.target_approver_name || "").toUpperCase()} • PIN {r.target_approver_pin}</div>
                {r.reason ? <div className="muted">ARSYE: {r.reason}</div> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <style jsx>{`
        .pageWrap{max-width:980px;margin:0 auto;padding:18px 14px 40px;text-transform:uppercase;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:14px;}
        .title{font-size:34px;letter-spacing:1px;font-weight:900;}
        .sub{opacity:.75;margin-top:4px;font-size:13px;letter-spacing:.8px;}
        .ghostBtn{height:40px;padding:0 12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);display:inline-flex;align-items:center;justify-content:center;font-weight:800;letter-spacing:.6px;text-decoration:none;}

        .err{border:2px solid rgba(255,80,80,.35);background:rgba(255,0,0,.08);color:#ffd1d1;padding:12px;border-radius:14px;margin-bottom:12px;font-weight:900;letter-spacing:.08em;}

        .card{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);border-radius:16px;padding:14px 14px 12px;margin:12px 0;}
        .cardTitle{font-weight:950;letter-spacing:.18em;opacity:.85;font-size:10px;margin-bottom:10px;}
        .row{display:flex;gap:10px;}
        .input{width:100%;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.16);padding:12px;border-radius:12px;font-size:12px;color:#fff;margin-top:10px;outline:none;letter-spacing:.08em;font-weight:900;}
        textarea.input{resize:none;}

        .primary{width:100%;margin-top:10px;padding:12px;border-radius:12px;border:1px solid rgba(0,150,255,.35);background:rgba(0,150,255,.12);color:rgba(190,230,255,.95);font-size:10px;font-weight:950;letter-spacing:.16em;opacity:1;}
        .primary:disabled{opacity:.55;}

        .muted{opacity:.7;padding:6px 0;font-size:10px;letter-spacing:.16em;}
        .list{display:grid;gap:10px;}
        .item{border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.35);border-radius:14px;padding:12px;}
        .itemTop{display:flex;justify-content:space-between;gap:10px;align-items:center;}
        .strong{font-weight:950;letter-spacing:.12em;font-size:11px;}
        .badge{font-size:9px;font-weight:950;letter-spacing:.14em;padding:4px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);}
        .badge.PENDING{border-color:rgba(255,180,80,.35);background:rgba(255,180,80,.10)}
        .badge.APPROVED{border-color:rgba(0,255,170,.30);background:rgba(0,255,170,.10)}
        .badge.REJECTED{border-color:rgba(255,80,80,.35);background:rgba(255,80,80,.10)}
      `}</style>
    </div>
  );
}
