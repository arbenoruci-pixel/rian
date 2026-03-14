"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getDeviceId } from "@/lib/deviceId";
import { cacheApprovedLogin, canLoginOffline } from "@/lib/deviceApprovalsCache";

const LS_SESSION = "tepiha_session_v1";
const LS_USER = "CURRENT_USER_DATA";

function safeGet(key) {
  try { return typeof window !== "undefined" ? window.localStorage.getItem(key) : null; } catch { return null; }
}

function safeSet(key, val) {
  try { if (typeof window !== "undefined") window.localStorage.setItem(key, val); } catch {}
}

function safeDel(key) {
  try { if (typeof window !== "undefined") window.localStorage.removeItem(key); } catch {}
}

function LoginContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = sp?.get("returnTo") || "/";

  const [pin, setPin] = useState("");
  const [role, setRole] = useState("ADMIN");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }

  const deviceId = useMemo(() => getDeviceId(), []);

  useEffect(() => {
    try {
      const raw = safeGet(LS_USER);
      const u = raw ? JSON.parse(raw) : null;
      if (u?.pin) setPin(String(u.pin));
      if (u?.role) setRole(String(u.role));
    } catch {}
  }, []);

  const canSubmit = useMemo(() => {
    const p = String(pin || "").trim();
    return p.length >= 2;
  }, [pin]);

  async function doLogin() {
    setErr("");
    const p = String(pin || "").trim();
    const r = String(role || "").trim() || "ADMIN";

    if (!p) {
      setErr("SHKRU PIN.");
      return;
    }

    const online = typeof navigator !== "undefined" ? navigator.onLine : true;
    if (!online) {
      const ok = canLoginOffline({ pin: p, role: r, deviceId });
      if (!ok.ok) {
        setErr("OFFLINE: PAJISJA S’ËSHTË E APROVUAR PËR KËTË PIN");
        return;
      }

      const actor = ok.actor || { pin: p, role: r, name: r, device_id: deviceId };
      const session = { actor, ts: Date.now() };
      safeSet(LS_SESSION, JSON.stringify(session));
      safeSet(LS_USER, JSON.stringify(actor));
    } else {
      setBusy(true);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: p, role: r, deviceId }),
        });
        const json = await res.json();
        if (!json.ok) {
          if (json.error === "DEVICE_NOT_APPROVED") {
            setErr("PAJISJA NË PRITJE — HAP /ADMIN/DEVICES DHE APROVO");
          } else if (json.error === "ROLE_MISMATCH") {
            setErr("ROLI NUK PËRPUTHET ME KËTË PIN");
          } else {
            setErr(String(json.error || "PIN GABIM"));
          }
          return;
        }

        const actor = json.actor;
        const session = { actor, ts: Date.now() };
        safeSet(LS_SESSION, JSON.stringify(session));
        safeSet(LS_USER, JSON.stringify(actor));
        cacheApprovedLogin({ pin: p, role: r, deviceId, actor });
      } catch (e) {
        setErr("S’PO MUNDËM ME U LIDH. PROVO PRAPË.");
        return;
      } finally {
        setBusy(false);
      }
    }

    try {
      const mod = await import("@/lib/baseCodes");
      if (mod?.ensureBasePool) mod.ensureBasePool(p).catch(() => {});
    } catch {}

    try {
      router.replace(returnTo);
    } catch {
      window.location.href = returnTo;
    }
  }

  function clearLocal() {
    safeDel(LS_SESSION);
    safeDel(LS_USER);
    setPin("");
    setErr("");
  }

  return (
    <div className="wrap">
      <div className="header-row">
        <div>
          <h1 className="title">TEPIHA</h1>
          <p className="subtitle">LOG IN</p>
        </div>
      </div>

      <div className="card">
        <div className="card-title-row">
          <h2 className="card-title">HYRJA</h2>
          <span style={{ opacity: 0.7, fontSize: 12 }}>{role}</span>
        </div>

        <div className="field-group">
          <label className="label">PIN</label>
          <input
            className="input"
            type="password"
            value={pin}
            onChange={(e) => setPin(onlyDigits(e.target.value))}
            placeholder="****"
            inputMode="numeric"
            autoComplete="one-time-code"
          />
        </div>

        <div className="field-group">
          <label className="label">ROLI</label>
          <div className="chip-row">
            {["ADMIN", "PUNTOR", "DISPATCH", "TRANSPORT"].map((x) => (
              <button
                key={x}
                type="button"
                className={"chip " + (role === x ? "" : "chip-outline")}
                onClick={() => setRole(x)}
              >
                {x}
              </button>
            ))}
          </div>
        </div>

        {err ? (
          <div style={{ marginTop: 6, color: "#ff6b6b", fontSize: 12, fontWeight: 800 }}>
            {err}
          </div>
        ) : null}

        <div className="btn-row">
          <button type="button" className="btn" onClick={doLogin} disabled={!canSubmit || busy}>
            {busy ? "DUKE HYRË…" : "LOG IN"}
          </button>
          <button type="button" className="btn" onClick={clearLocal}>
            CLEAR
          </button>
        </div>
      </div>
    </div>
  );
}

function LoginFallback() {
  return (
    <div className="wrap">
      <div className="card" style={{ textAlign: "center" }}>
        <h2 className="card-title">DUKE U NGARKUAR…</h2>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginContent />
    </Suspense>
  );
}
