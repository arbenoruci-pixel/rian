"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getDeviceId } from "@/lib/deviceId";
import { cacheApprovedLogin, canLoginOffline } from "@/lib/deviceApprovalsCache";
import { LS_SESSION, LS_USER, LS_TRANSPORT, clearAllSessionState, persistMainSession, readTransportSession } from "@/lib/sessionStore";
import useRouteAlive from '@/lib/routeAlive';

const LOGIN_ROLE_OPTIONS = ["ADMIN", "ADMIN_MASTER", "OWNER", "PRONAR", "SUPERADMIN", "PUNTOR", "DISPATCH", "TRANSPORT"];

function safeGet(key) {
  try { return typeof window !== "undefined" ? window.localStorage.getItem(key) : null; } catch { return null; }
}


function safeDel(key) {
  try { if (typeof window !== "undefined") window.localStorage.removeItem(key); } catch {}
}

function LoginContent() {
  useRouteAlive('login_page');
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = sp?.get("returnTo") || sp?.get("next") || "/";

  const [pin, setPin] = useState("");
  const [role, setRole] = useState("ADMIN");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  function onlyDigits(v) { return String(v || "").replace(/\D/g, ""); }

  const deviceId = useMemo(() => getDeviceId(), []);

  useEffect(() => {
    try {
      if (sp?.get('clear') === '1' || sp?.get('logout') === '1' || sp?.get('force') === '1') {
        clearAllSessionState();
      }
      const raw = safeGet(LS_USER);
      const u = raw ? JSON.parse(raw) : null;
      if (u?.pin) setPin(String(u.pin));
      if (u?.role) setRole(String(u.role));
    } catch {}
  }, [sp]);

  const canSubmit = useMemo(() => {
    const p = String(pin || "").trim();
    return p.length >= 2;
  }, [pin]);


  function clearStaleTransportSession(currentPin) {
    try {
      const s = readTransportSession();
      const sessionPin = String(s?.transport_pin || s?.pin || "").trim();
      if (sessionPin && sessionPin !== String(currentPin || '').trim()) {
        safeDel(LS_TRANSPORT);
      }
    } catch {}
  }

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
      persistMainSession(actor);
      clearStaleTransportSession(p);
      try { window.dispatchEvent(new CustomEvent('tepiha:session-changed', { detail: { reason: 'login_offline', at: Date.now() } })); } catch {}
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
        persistMainSession(actor);
        clearStaleTransportSession(p);
        try { window.dispatchEvent(new CustomEvent('tepiha:session-changed', { detail: { reason: 'login', at: Date.now() } })); } catch {}
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
      setErr('HYRJA U RUAJT, POR NAVIGIMI DËSHTOI. PROVO PËRSËRI.');
    }
  }

  function clearLocal() {
    clearAllSessionState();
    try { window.dispatchEvent(new CustomEvent('tepiha:session-changed', { detail: { reason: 'clear_local', at: Date.now() } })); } catch {}
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
            {LOGIN_ROLE_OPTIONS.map((x) => (
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
