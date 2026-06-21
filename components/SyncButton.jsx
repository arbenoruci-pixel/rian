"use client";

import { useEffect, useState } from "react";
import { getPendingOps } from "@/lib/offlineStore";
import { syncNow } from "@/lib/syncManager";

export default function SyncButton() {
  const [color, setColor] = useState("green");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const ops = await getPendingOps();
      if ((ops?.length || 0) > 0) setColor("yellow");
      else setColor("green");
    } catch {}
  }

  useEffect(() => { refresh(); }, []);

  async function onSync() {
    setBusy(true);
    setColor("yellow");
    try {
      const res = await syncNow({ immediate: true, source: 'SyncButton' });
      setColor(res?.ok ? "green" : "red");
    } catch {
      setColor("red");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  const c =
    color === "green" ? "#16a34a" :
    color === "yellow" ? "#eab308" :
    "#dc2626";

  return (
    <button
      onClick={onSync}
      disabled={busy}
      style={{
        width: 44,
        height: 44,
        borderRadius: 999,
        border: "2px solid " + c,
        background: "transparent",
        color: c,
        fontWeight: 800,
        letterSpacing: 0.5
      }}
      title="SYNC"
    >
      {busy ? "..." : "SYNC"}
    </button>
  );
}
