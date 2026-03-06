"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getDeviceId } from "@/lib/deviceId";
import { canLoginOffline, cacheApprovedLogin } from "@/lib/deviceApprovalsCache";

const LS_USER = "CURRENT_USER_DATA";
const LS_SESSION = "tepiha_session_v1";
const LS_TRANSPORT = "tepiha_transport_session_v1";

function readStoredUser() {
  try {
    const raw = localStorage.getItem(LS_USER);
    if (raw) {
      const u = JSON.parse(raw);
      if (u && typeof u === "object") return u;
    }
  } catch {}
  try {
    const raw = localStorage.getItem(LS_SESSION);
    if (raw) {
      const s = JSON.parse(raw);
      const u = s?.actor || s?.user;
      if (u && typeof u === "object") return u;
    }
  } catch {}
  return null;
}

function hasTransportSession() {
  try {
    const raw = localStorage.getItem(LS_TRANSPORT);
    if (!raw) return false;
    const s = JSON.parse(raw);
    return !!(s && (s.transport_id || s.transport_pin || s.role === 'TRANSPORT'));
  } catch {
    return false;
  }
}

export default function AuthGate({ children }) {
  const router = useRouter();
  const pathname = usePathname() || "/";

  const [ready, setReady] = useState(false);
  const [offlineNoUser, setOfflineNoUser] = useState(false);
  const [checkingDevice, setCheckingDevice] = useState(false);
  const [deviceApproved, setDeviceApproved] = useState(null);
  const [deviceId, setDeviceId] = useState(null);

  const mountedRef = useRef(false);
  const approvedRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const isLogin = pathname === "/login" || pathname?.startsWith("/login/") || pathname === "/transport/login" || pathname?.startsWith("/transport/login");
    if (isLogin) {
      setOfflineNoUser(false);
      setReady(true);
      return;
    }

    const isDoctor = pathname === "/doctor" || pathname?.startsWith("/doctor/");
    if (isDoctor) {
      setOfflineNoUser(false);
      setReady(true);
      return;
    }

    try {
      const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search || "") : null;
      if (sp && (sp.get("nogate") === "1" || sp.get("public") === "1")) {
        setOfflineNoUser(false);
        setReady(true);
        return;
      }
    } catch {}

    let hasAuth = false;
    let actor = readStoredUser();
    let userRole = actor?.role ? String(actor.role || "").toUpperCase() : null;

    if (actor) hasAuth = true;

    if (pathname?.startsWith("/transport") && hasTransportSession()) {
      hasAuth = true;
      if (!userRole) userRole = "TRANSPORT";
    }

    if (!hasAuth) {
      try {
        const isOffline = typeof navigator !== "undefined" && navigator && navigator.onLine === false;
        if (isOffline) {
          setOfflineNoUser(true);
          setReady(true);
          return;
        }
      } catch {}

      try {
        const next = pathname ? `?next=${encodeURIComponent(pathname)}` : "";
        router.replace(`/login${next}`);
      } catch {}
      setOfflineNoUser(false);
      setReady(false);
      return;
    }

    const currentDeviceId = getDeviceId();
    setDeviceId(currentDeviceId);

    if (userRole === "ADMIN") {
      setOfflineNoUser(false);
      setCheckingDevice(false);
      setDeviceApproved(true);
      setReady(true);
      return;
    }

    let cancelled = false;

    async function verifyUnifiedApproval() {
      const currentActor = readStoredUser() || actor || {};
      const pin = String(currentActor?.pin || "").trim();
      const role = String(currentActor?.role || userRole || "").trim().toUpperCase();
      const isOffline = typeof navigator !== "undefined" && navigator && navigator.onLine === false;

      if (!pin || !currentDeviceId) {
        if (!mountedRef.current || cancelled) return;
        setDeviceApproved(false);
        setCheckingDevice(false);
        setReady(true);
        return;
      }

      // KONTROLLI LOKAL (Eviton Flash-in)
      const localCheck = canLoginOffline({ pin, role, deviceId: currentDeviceId });
      if (localCheck.ok) {
        approvedRef.current = true;
        setDeviceApproved(true);
        setReady(true);
        setCheckingDevice(false); // E kalon direkt pa ekran te zi
      } else if (!isOffline) {
        setCheckingDevice(true); // Vetem nese s'e njohim fare e shfaqim
      }

      if (isOffline) {
        if (!mountedRef.current || cancelled) return;
        approvedRef.current = !!localCheck.ok;
        setDeviceApproved(!!localCheck.ok);
        setCheckingDevice(false);
        setOfflineNoUser(false);
        setReady(true);
        return;
      }

      try {
        const res = await fetch('/api/auth/device-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin, role, deviceId: currentDeviceId }),
          cache: 'no-store',
        });
        const json = await res.json().catch(() => ({}));
        const ok = !!json?.ok && !!json?.approved;

        if (ok) {
          cacheApprovedLogin({ pin, role, deviceId: currentDeviceId, actor: json?.actor || currentActor });
        }

        if (!mountedRef.current || cancelled) return;
        approvedRef.current = ok;
        setDeviceApproved(ok);
        setCheckingDevice(false);
        setOfflineNoUser(false);
        setReady(true);
      } catch {
        if (!mountedRef.current || cancelled) return;
        setDeviceApproved(!!localCheck.ok);
        setCheckingDevice(false);
        setReady(true);
      }
    }

    // Mos e bej flash nese tashme jemi te aprovuar
    if (approvedRef.current !== true) {
      verifyUnifiedApproval();
    } else {
      setReady(true);
    }

    const intervalId = window.setInterval(() => {
      if (!mountedRef.current || cancelled) return;
      if (approvedRef.current !== true) verifyUnifiedApproval();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pathname, router]);

  if (!ready) return null;

  const wrapStyle = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 18, background: "#0b0f14", color: "#e8eef6" };
  const cardStyle = { width: "100%", maxWidth: 560, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.03)", borderRadius: 14, padding: 18 };
  const titleStyle = { fontWeight: 900, letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 14 };
  const subStyle = { marginTop: 10, opacity: 0.88, lineHeight: 1.35, fontSize: 13 };
  const metaStyle = { marginTop: 14, border: "1px dashed rgba(255,255,255,0.18)", borderRadius: 12, padding: 12, background: "rgba(0,0,0,0.18)" };
  const kStyle = { fontSize: 11, opacity: 0.7, letterSpacing: "0.08em", textTransform: "uppercase" };
  const vStyle = { marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace', fontSize: 13, wordBreak: "break-all" };
  const hintStyle = { marginTop: 12, fontSize: 12, opacity: 0.8, lineHeight: 1.35 };
  const btnRowStyle = { display: "flex", gap: 10, marginTop: 16 };
  const btnStyle = { flex: 1, padding: "12px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "#fff", fontWeight: 900, cursor: "pointer", textTransform: "uppercase", letterSpacing: "1px", fontSize: 12 };

  if (checkingDevice) {
    return (
      <div style={wrapStyle}>
        <div style={{ ...cardStyle, maxWidth: 520 }}>
          <div style={titleStyle}>DUKE KONTROLLUAR…</div>
          <div style={subStyle}>Po verifikojmë pajisjen nga i njëjti sistem i login-it. Ju lutem prisni.</div>
        </div>
      </div>
    );
  }

  if (deviceApproved === false) {
    return (
      <div style={wrapStyle}>
        <div style={cardStyle}>
          <div style={titleStyle}>PAJISJA NUK ËSHTË APROVUAR</div>
          <div style={subStyle}>Kjo pajisje po kontrollohet me të njëjtin DEVICE ID si login-i. Aprovoheni te /ARKA/PUNTORET dhe pastaj bëni hyrje prapë.</div>

          <div style={metaStyle}>
            <div style={kStyle}>DEVICE ID</div>
            <div style={vStyle}>{deviceId || "—"}</div>
          </div>

          <div style={hintStyle}>Ky ekran nuk krijon më ID tjetër dhe nuk shkruan më në tabelën e vjetër device_approvals.</div>

          <div style={btnRowStyle}>
            <button
              style={btnStyle}
              onClick={() => {
                try { navigator.clipboard.writeText(deviceId || ""); alert("U kopjua!"); } catch {}
              }}
            >
              KOPJO ID
            </button>
            <button
              style={btnStyle}
              onClick={() => { window.location.href = '/login'; }}
            >
              KTHEHU TE LOGIN
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {offlineNoUser ? (
        <div style={{ padding: 10, margin: 10, borderRadius: 12, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,180,0,0.10)", color: "#ffd28a", fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", fontSize: 12 }}>
          OFFLINE • S'KA SESSION — KTHEHU ONLINE ME HY
        </div>
      ) : null}
      {children}
    </>
  );
}
