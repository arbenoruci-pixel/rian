"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getPendingOps } from "@/lib/offlineStore";
import { runSync, attachAutoSync } from "@/lib/syncEngine";

// Tiny floating sync button (GREEN/YELLOW/RED) across all pages.
// - GREEN: no pending ops
// - YELLOW: syncing or pending ops
// - RED: last sync failed
export default function SyncFab() {
  const pathname = usePathname();
  const [state, setState] = useState("green"); // green|yellow|red
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const ops = await getPendingOps();
      const pending = (ops?.length || 0) > 0;
      if (!busy) setState(pending ? "yellow" : "green");
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    try { attachAutoSync(); } catch {}
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    setState("yellow");
    try {
      const r = await runSync({ manual: true });
      setState(r?.ok ? "green" : "red");
    } catch {
      setState("red");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (pathname === "/") return null;

  const color =
    state === "green" ? "#16a34a" :
    state === "yellow" ? "#eab308" :
    "#dc2626";

  return (
    <button
      onClick={onClick}
      title="SYNC"
      aria-label="SYNC"
      style={{
        position: "fixed",
        top: 10,
        right: 10,
        width: 34,
        height: 34,
        borderRadius: 999,
        border: "2px solid " + color,
        background: "rgba(11,15,20,0.65)",
        color: color,
        fontWeight: 900,
        lineHeight: "30px",
        textAlign: "center",
        zIndex: 9999,
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {busy ? "…" : "⟳"}
    </button>
  );
}