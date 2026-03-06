"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getDeviceId } from "@/lib/deviceId";
import { cacheApprovedLogin, canLoginOffline } from "@/lib/deviceApprovalsCache";

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

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function LoginContent() {
  const router = useRouter();
  const sp = useSearchParams();
  const returnTo = sp?.get("returnTo") || "/";

  const [pin, setPin] = useState("");
  const [role, setRole] = useState("ADMIN");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const deviceId = useMemo(() => getDeviceId(), []);

  useEffect(() => {
    try {
      const raw = safeGet(LS_USER);
      const u = raw ? JSON.parse(raw) : null;
      if (u?.role) setRole(String(u.role));
    } catch {}
  }, []);

  const canSubmit = useMemo(() => String(pin || "").trim().length >= 2, [pin]);

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
            setErr("PAJISJA NË PRITJE — ADMINI E APROVON TE LISTA E PAJISJEVE");
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
      } catch {
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
    <div style={styles.wrap}>
      <div style={styles.headerRow}>
        <div>
          <h1 style={styles.title}>TEPIHA</h1>
          <p style={styles.subtitle}>LOG IN</p>
        </div>
        <a style={styles.badge} href="/doctor">
          DOCTOR
        </a>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h2 style={styles.cardTitle}>HYRJA</h2>
          <span style={{ opacity: 0.7, fontSize: 12 }}>{role}</span>
        </div>

        <div style={styles.fieldGroup}>
          <label style={styles.label}>PIN</label>
          <input
            style={styles.input}
            type="password"
            value={pin}
            onChange={(e) => setPin(onlyDigits(e.target.value))}
            placeholder="****"
            inputMode="numeric"
            autoComplete="current-password"
          />
        </div>

        <div style={styles.fieldGroup}>
          <label style={styles.label}>ROLI</label>
          <div style={styles.chipRow}>
            {["ADMIN", "PUNTOR", "DISPATCH", "TRANSPORT"].map((x) => {
              const active = role === x;
              return (
                <button
                  key={x}
                  type="button"
                  onClick={() => setRole(x)}
                  style={{
                    ...styles.chip,
                    ...(active ? styles.chipActive : styles.chipOutline),
                  }}
                >
                  {x}
                </button>
              );
            })}
          </div>
        </div>

        {err ? <div style={styles.error}>{err}</div> : null}

        <div style={styles.btnRow}>
          <button type="button" style={styles.btn} onClick={doLogin} disabled={!canSubmit || busy}>
            {busy ? "DUKE HYRË…" : "LOG IN"}
          </button>
          <button type="button" style={styles.btnSecondary} onClick={clearLocal}>
            CLEAR
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#0b1220" }} />}>
      <LoginContent />
    </Suspense>
  );
}

const styles = {
  wrap: {
    minHeight: "100vh",
    background: "#0b1220",
    color: "#f8fafc",
    padding: "24px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 900,
    letterSpacing: "0.06em",
  },
  subtitle: {
    margin: "4px 0 0",
    opacity: 0.7,
    fontWeight: 700,
    letterSpacing: "0.08em",
  },
  badge: {
    textDecoration: "none",
    color: "#fff",
    border: "1px solid rgba(255,255,255,0.16)",
    borderRadius: 999,
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 800,
    background: "rgba(255,255,255,0.06)",
  },
  card: {
    width: "100%",
    maxWidth: 520,
    background: "rgba(15,23,42,0.88)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 18,
    padding: 18,
    boxShadow: "0 20px 40px rgba(0,0,0,0.35)",
  },
  cardTitleRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  cardTitle: {
    margin: 0,
    fontSize: 16,
    fontWeight: 900,
    letterSpacing: "0.06em",
  },
  fieldGroup: {
    marginTop: 12,
  },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: "0.06em",
    marginBottom: 6,
  },
  input: {
    width: "100%",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    padding: "12px 14px",
    fontSize: 16,
    boxSizing: "border-box",
    outline: "none",
  },
  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    borderRadius: 999,
    padding: "9px 12px",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
  },
  chipActive: {
    border: "1px solid #2563eb",
    background: "#2563eb",
    color: "#fff",
  },
  chipOutline: {
    border: "1px solid rgba(255,255,255,0.14)",
    background: "transparent",
    color: "#e2e8f0",
  },
  error: {
    marginTop: 10,
    color: "#f87171",
    fontSize: 12,
    fontWeight: 800,
  },
  btnRow: {
    display: "flex",
    gap: 10,
    marginTop: 14,
  },
  btn: {
    flex: 1,
    border: 0,
    borderRadius: 12,
    padding: "12px 14px",
    background: "#2563eb",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnSecondary: {
    flex: 1,
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 12,
    padding: "12px 14px",
    background: "transparent",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
};
