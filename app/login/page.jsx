"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// iOS PWA OFFLINE RULE:
// - Do NOT unregister SW on login/logout.
// - Keep auth purely local (localStorage) to avoid network/middleware loops.

const LS_SESSION = "tepiha_session_v1";
const LS_USER = "CURRENT_USER_DATA";

function safeGet(key) {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(key, val) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, val);
  } catch {}
}

function safeDel(key) {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  } catch {}
}

export default function LoginPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = sp?.get("returnTo") || "/";

  const [pin, setPin] = useState("");
  const [role, setRole] = useState("ADMIN");
  const [err, setErr] = useState("");

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
    return p.length >= 2; // ✅ only PIN required
  }, [pin]);

  async function doLogin() {
    setErr("");
    const p = String(pin || "").trim();
    const r = String(role || "").trim() || "ADMIN";

    if (!p) {
      setErr("SHKRU PIN.");
      return;
    }

    // ✅ PIN-only actor (no name field)
    const actor = { pin: p, role: r, name: `PIN-${p}` };
    const session = { actor, ts: Date.now() };

    safeSet(LS_SESSION, JSON.stringify(session));
    safeSet(LS_USER, JSON.stringify(actor));

    // ✅ Warm BASE pool
    // - dynamic import so build won't fail if file moves
    // - never block login if offline/rpc fails
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
        <a className="badge" href="/doctor">
          DOCTOR
        </a>
      </div>

      <div className="card">
        <div className="card-title-row">
          <h2 className="card-title">HYRJA</h2>
          <span style={{ opacity: 0.7, fontSize: 12 }}>{role}</span>
        </div>

        {/* ✅ ONLY PIN */}
        <div className="field-group">
          <label className="label">PIN</label>
          <input
            className="input"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="P.SH. 2380"
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
          <button type="button" className="btn" onClick={doLogin} disabled={!canSubmit}>
            LOG IN
          </button>
          <button type="button" className="btn" onClick={clearLocal}>
            CLEAR
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">SHENIM</h2>
        <p style={{ margin: 0, fontSize: 12, opacity: 0.75, lineHeight: 1.4 }}>
          Nese je OFFLINE, hyn normal — sesioni ruhet ne pajisje. Per diagnostike/hard-reset te Service Worker, hap DOCTOR.
        </p>
      </div>
    </div>
  );
}