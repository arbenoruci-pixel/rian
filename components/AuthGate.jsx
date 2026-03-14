"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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

  try {
    const raw = localStorage.getItem(LS_TRANSPORT);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s === "object") {
        return {
          pin: s.transport_pin || s.pin || "",
          role: s.role || "TRANSPORT",
          name: s.transport_name || s.name || "",
          transport_id: s.transport_id || "",
        };
      }
    }
  } catch {}

  return null;
}

function hasTransportSession() {
  try {
    const raw = localStorage.getItem(LS_TRANSPORT);
    if (!raw) return false;
    const s = JSON.parse(raw);
    return !!(s && (s.transport_id || s.transport_pin || s.pin || s.role === "TRANSPORT"));
  } catch {
    return false;
  }
}

function hasAnyLocalAuth() {
  return !!readStoredUser() || hasTransportSession();
}

function isPublicPath(pathname) {
  if (!pathname) return false;
  if (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname === "/transport/login" ||
    pathname.startsWith("/transport/login")
  ) {
    return true;
  }
  try {
    const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search || "") : null;
    return !!(sp && (sp.get("nogate") === "1" || sp.get("public") === "1"));
  } catch {
    return false;
  }
}

export default function AuthGate({ children }) {
  const router = useRouter();
  const pathname = usePathname() || "/";

  const [ready, setReady] = useState(false);
  const [checkingDevice, setCheckingDevice] = useState(false);
  const [deviceApproved, setDeviceApproved] = useState(null);
  const [offlineNoUser, setOfflineNoUser] = useState(false);
  const [deviceId, setDeviceId] = useState(null);
  const [redirecting, setRedirecting] = useState(false);

  const mountedRef = useRef(false);
  const bootedRef = useRef(false);

  const currentPathIsPublic = useMemo(() => isPublicPath(pathname), [pathname]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (bootedRef.current && currentPathIsPublic) {
      setReady(true);
      setCheckingDevice(false);
      setDeviceApproved(true);
      setOfflineNoUser(false);
      setRedirecting(false);
      return;
    }

    const actor = readStoredUser();
    const localHasAuth = !!actor || hasTransportSession();
    const currentDeviceId = getDeviceId();
    const role = String(actor?.role || (pathname.startsWith("/transport") ? "TRANSPORT" : "") || "").toUpperCase();
    const pin = String(actor?.pin || actor?.transport_pin || "").trim();
    const localApproval = pin && currentDeviceId
      ? canLoginOffline({ pin, role: role || "TRANSPORT", deviceId: currentDeviceId })
      : { ok: false };

    bootedRef.current = true;
    setDeviceId(currentDeviceId || null);

    if (currentPathIsPublic) {
      setReady(true);
      setCheckingDevice(false);
      setDeviceApproved(true);
      setOfflineNoUser(false);
      setRedirecting(false);
      return;
    }

    // OPTIMISTIC OPEN: any local auth or local approval cache opens immediately.
    if (localHasAuth || localApproval.ok) {
      setReady(true);
      setCheckingDevice(false);
      setDeviceApproved(true);
      setOfflineNoUser(false);
      setRedirecting(false);
    } else {
      const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
      if (isOffline) {
        setOfflineNoUser(true);
        setReady(true);
        setCheckingDevice(false);
        setDeviceApproved(true);
        setRedirecting(false);
        return;
      }

      setRedirecting(true);
      setReady(true);
      setCheckingDevice(false);
      setDeviceApproved(true);
      setOfflineNoUser(false);
      try {
        const next = pathname ? `?next=${encodeURIComponent(pathname)}` : "";
        router.replace(`/login${next}`);
      } catch {}
      return;
    }

    // Never block ADMIN locally.
    if (role === "ADMIN") return;

    // Background check only once. Never use intervals / loops.
    let cancelled = false;
    async function verifyInBackground() {
      if (!pin || !currentDeviceId) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;

      try {
        const res = await fetch("/api/auth/device-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin, role, deviceId: currentDeviceId }),
          cache: "no-store",
        });

        const json = await res.json().catch(() => ({}));
        if (cancelled || !mountedRef.current) return;

        const approved = !!json?.ok && !!json?.approved;

        if (approved) {
          cacheApprovedLogin({
            pin,
            role,
            deviceId: currentDeviceId,
            actor: json?.actor || actor,
          });
          return;
        }

        // Block only if API explicitly says approved:false AND we do not have local approval cache.
        if (json?.approved === false && !localApproval.ok) {
          setDeviceApproved(false);
          setCheckingDevice(false);
          setReady(true);
        }
      } catch {
        // Offline / network / server hiccup: ignore and keep optimistic UI alive.
      }
    }

    verifyInBackground();
    return () => {
      cancelled = true;
    };
  }, [currentPathIsPublic, pathname, router]);

  const wrapStyle = {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    background: "#0b0f14",
    color: "#e8eef6",
  };
  const cardStyle = {
    width: "100%",
    maxWidth: 560,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.03)",
    borderRadius: 14,
    padding: 18,
  };
  const titleStyle = {
    fontWeight: 900,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    fontSize: 14,
  };
  const subStyle = { marginTop: 10, opacity: 0.88, lineHeight: 1.35, fontSize: 13 };
  const metaStyle = {
    marginTop: 14,
    border: "1px dashed rgba(255,255,255,0.18)",
    borderRadius: 12,
    padding: 12,
    background: "rgba(0,0,0,0.18)",
  };
  const kStyle = { fontSize: 11, opacity: 0.7, letterSpacing: "0.08em", textTransform: "uppercase" };
  const vStyle = {
    marginTop: 6,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: 13,
    wordBreak: "break-all",
  };
  const hintStyle = { marginTop: 12, fontSize: 12, opacity: 0.8, lineHeight: 1.35 };
  const btnRowStyle = { display: "flex", gap: 10, marginTop: 16 };
  const btnStyle = {
    flex: 1,
    padding: "12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: "1px",
    fontSize: 12,
  };

  if (!ready) {
    return (
      <div style={wrapStyle}>
        <div style={{ ...cardStyle, maxWidth: 520, textAlign: "center" }}>
          <div style={titleStyle}>DUKE U NGARKUAR...</div>
        </div>
      </div>
    );
  }

  if (redirecting) {
    return (
      <div style={wrapStyle}>
        <div style={{ ...cardStyle, maxWidth: 520 }}>
          <div style={titleStyle}>DUKE TË DËRGUAR TE LOGIN...</div>
          <div style={subStyle}>Nuk u gjet session aktiv në këtë pajisje.</div>
        </div>
      </div>
    );
  }

  if (checkingDevice) {
    return (
      <div style={wrapStyle}>
        <div style={{ ...cardStyle, maxWidth: 520 }}>
          <div style={titleStyle}>DUKE KONTROLLUAR…</div>
          <div style={subStyle}>Po verifikojmë pajisjen. Ju lutem prisni.</div>
        </div>
      </div>
    );
  }

  if (deviceApproved === false) {
    return (
      <div style={wrapStyle}>
        <div style={cardStyle}>
          <div style={titleStyle}>PAJISJA NUK ËSHTË APROVUAR</div>
          <div style={subStyle}>
            Kjo pajisje nuk u aprovua nga sistemi. Aprovoheni te /ARKA/PUNTORET dhe pastaj bëni hyrje prapë.
          </div>

          <div style={metaStyle}>
            <div style={kStyle}>DEVICE ID</div>
            <div style={vStyle}>{deviceId || "—"}</div>
          </div>

          <div style={hintStyle}>Nëse jeni offline por keni session valid, aplikacioni duhet të hapet pa bllokim.</div>

          <div style={btnRowStyle}>
            <button
              style={btnStyle}
              onClick={() => {
                try {
                  navigator.clipboard.writeText(deviceId || "");
                  alert("U kopjua!");
                } catch {}
              }}
            >
              KOPJO ID
            </button>
            <button
              style={btnStyle}
              onClick={() => {
                window.location.href = "/login";
              }}
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
        <div
          style={{
            padding: 10,
            margin: 10,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,180,0,0.10)",
            color: "#ffd28a",
            fontWeight: 800,
            letterSpacing: 1,
            textTransform: "uppercase",
            fontSize: 12,
          }}
        >
          OFFLINE • S'KA SESSION — KTHEHU ONLINE ME HY
        </div>
      ) : null}
      {children}
    </>
  );
}
