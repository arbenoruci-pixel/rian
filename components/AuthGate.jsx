"use client";

import React, { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

const LS_USER = "CURRENT_USER_DATA";
const LS_SESSION = "tepiha_session_v1";

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

export default function AuthGate({ children }) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const [ready, setReady] = useState(false);
  const [offlineNoUser, setOfflineNoUser] = useState(false);

  useEffect(() => {
    // ULTRA STABLE FIX:
    // wait one tick so localStorage/session hydrate before redirect
    const t = setTimeout(() => {

      const isLogin = pathname === "/login" || pathname?.startsWith("/login/");
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

      const u = readStoredUser();
      if (u) {
        setOfflineNoUser(false);
        setReady(true);
        return;
      }

      try {
        const isOffline =
          typeof navigator !== "undefined" &&
          navigator &&
          navigator.onLine === false;

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

    }, 0);

    return () => clearTimeout(t);
  }, [pathname, router]);

  if (!ready) return null;

  return (
    <>
      {offlineNoUser ? (
        <div style={{
          padding: 10,
          margin: 10,
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(255,180,0,0.10)",
          color: "#ffd28a",
          fontWeight: 800,
          letterSpacing: 1,
          textTransform: "uppercase",
          fontSize: 12
        }}>
          OFFLINE • S'KA SESSION — KTHEHU ONLINE ME HY
        </div>
      ) : null}
      {children}
    </>
  );
}
