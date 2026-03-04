"use client";

import React, { useEffect, useState, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

const LS_USER = "CURRENT_USER_DATA";
const LS_SESSION = "tepiha_session_v1";
const LS_TRANSPORT = "tepiha_transport_session_v1";
const LS_DEVICE_ID = "tepiha_device_id_v1";
const LS_DEVICE_APPROVED_CACHE = "tepiha_device_approved_cache_v1"; // Mban mend aprovimin kur s'ka internet

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
      const u = s?.user;
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

function safeGetDeviceId() {
  try {
    if (typeof window === "undefined") return null;
    let id = window.localStorage.getItem(LS_DEVICE_ID);
    if (!id) {
      id = "dev_" + Math.random().toString(36).slice(2) + "_" + Date.now().toString(36);
      window.localStorage.setItem(LS_DEVICE_ID, id);
    }
    return id;
  } catch {
    return null;
  }
}

export default function AuthGate({ children }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  
  const [ready, setReady] = useState(false);
  const [offlineNoUser, setOfflineNoUser] = useState(false);

  // States për aprovimin e pajisjes
  const [checkingDevice, setCheckingDevice] = useState(false);
  const [deviceApproved, setDeviceApproved] = useState(null);
  const [deviceId, setDeviceId] = useState(null);

  const mountedRef = useRef(false);
  const lastApprovedRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    // 1. BYPASS për Login & Doctor
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

    // 2. KONTROLLI I SESIONIT (Kodi yt ekzistues)
    let hasAuth = false;
    let userRole = null;

    const u = readStoredUser();
    if (u) {
      hasAuth = true;
      userRole = String(u.role || "").toUpperCase();
    }

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

    // 3. KONTROLLI I APROVIMIT TË PAJISJES
    const currentDeviceId = safeGetDeviceId();
    setDeviceId(currentDeviceId);

    // ADMIN kalon direkt
    if (userRole === "ADMIN") {
       setOfflineNoUser(false);
       setCheckingDevice(false);
       setDeviceApproved(true);
       setReady(true);
       return;
    }

    setCheckingDevice(true);
    let cancelled = false;

    async function checkDbApproval() {
      try {
        if (!currentDeviceId) {
          if (!mountedRef.current || cancelled) return;
          setDeviceApproved(false);
          setCheckingDevice(false);
          setReady(true);
          return;
        }

        // Shpëtimi Offline: Nëse s'ka internet, por ka qenë aprovuar më parë, lëre të futet
        const isOffline = typeof navigator !== "undefined" && navigator && navigator.onLine === false;
        if (isOffline) {
           try {
              const cached = localStorage.getItem(LS_DEVICE_APPROVED_CACHE);
              if (cached === "1") {
                 if (!mountedRef.current || cancelled) return;
                 setDeviceApproved(true);
                 setCheckingDevice(false);
                 setReady(true);
                 return;
              }
           } catch {}
        }

        // Kontrollo në Supabase
        const { data, error } = await supabase
          .from("device_approvals")
          .select("approved")
          .eq("device_id", currentDeviceId)
          .maybeSingle();

        // Krijo pajisjen si 'Në pritje' nëse s'ekziston
        if (!data && !error) {
           await supabase.from("device_approvals").upsert({ device_id: currentDeviceId, approved: false }, { onConflict: "device_id" });
        }

        const ok = !!data?.approved;
        
        // Ruaj/Fshi Cache-in e aprovimit
        if (ok) {
           try { localStorage.setItem(LS_DEVICE_APPROVED_CACHE, "1"); } catch {}
        } else {
           try { localStorage.removeItem(LS_DEVICE_APPROVED_CACHE); } catch {}
        }

        if (!mountedRef.current || cancelled) return;

        if (lastApprovedRef.current !== ok) {
          lastApprovedRef.current = ok;
          setDeviceApproved(ok);
        }
        setCheckingDevice(false);
        setOfflineNoUser(false);
        setReady(true);
      } catch {
        // Gabim interneti/DB -> Provo cache-in prap
        if (!mountedRef.current || cancelled) return;
        let cachedOk = false;
        try { cachedOk = localStorage.getItem(LS_DEVICE_APPROVED_CACHE) === "1"; } catch {}

        if (lastApprovedRef.current !== cachedOk) {
          lastApprovedRef.current = cachedOk;
          setDeviceApproved(cachedOk);
        }
        setCheckingDevice(false);
        setReady(true);
      }
    }

    checkDbApproval();

    // Rifresko çdo 5 sekonda (vetëm nëse s'është aprovuar ende)
    const intervalId = window.setInterval(() => {
      if (!mountedRef.current) return;
      if (lastApprovedRef.current !== true) {
         checkDbApproval();
      }
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };

  }, [pathname, router]);

  if (!ready) return null;

  // Stilet Inline (SWC Safe)
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

  // UI Gjatë Kontrollit
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

  // UI Nëse Pajisja nuk është aprovuar
  if (deviceApproved === false) {
    return (
      <div style={wrapStyle}>
        <div style={cardStyle}>
          <div style={titleStyle}>PAJISJA NUK ËSHTË APROVUAR</div>
          <div style={subStyle}>Kjo pajisje duhet të aprovohet nga ADMIN para se të vazhdoni.</div>

          <div style={metaStyle}>
            <div style={kStyle}>DEVICE ID</div>
            <div style={vStyle}>{deviceId || "—"}</div>
          </div>

          <div style={hintStyle}>Hapni menynë e profilit te ADMIN → “APROVO PAJISJET”, dhe aprovojeni këtë Device ID.</div>

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
