"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { getTransportSession } from "@/lib/transportAuth";

function normalizeT(code) {
  if (!code) return "";
  const s = String(code).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, "").replace(/^0+/, "") || "0";
    return `T${n}`;
  }
  const n = s.replace(/\D+/g, "").replace(/^0+/, "");
  return n ? `T${n}` : "";
}

function pickCode(row) {
  return (
    normalizeT(row?.code_str) ||
    normalizeT(row?.code) ||
    (row?.code_n ? `T${Number(row.code_n)}` : "") ||
    normalizeT(row?.data?.client?.code)
  );
}

export default function TransportPickupPage() {
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);

  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) {
      router.push("/transport");
      return;
    }
    setMe(s);
  }, [router]);

  async function load() {
    if (!me?.transport_id) return;
    setLoading(true);
    setErr("");
    try {
      const tid = String(me.transport_id);

      // NOTE:
      // In Supabase we add a generated column `transport_id` on public.transport_orders
      // (derived from data->>'transport_id') so RLS/policies and filtering work.
      const { data, error } = await supabase
        .from("transport_orders")
        // NOTE: transport_orders nuk ka kolonë "code" (ka vetëm code_str/code_n)
        .select("id, created_at, status, code_str, code_n, data")
        .eq("transport_id", tid)
        .in("status", ["pickup", "loaded"])
        .order("created_at", { ascending: false })
        .limit(400);

      if (error) throw error;

      // Keep an extra safety filter (legacy rows), but DB-side filter should already do it.
      const filtered = (data || []).filter((r) => {
        const d = r?.data || {};
        const dTid = String(d.transport_id || d.transportId || d?.scope?.transport_id || "");
        const scope = String(d.scope || d?.scope?.name || "transport");
        return String(dTid) === tid && String(scope) === "transport";
      });

      setRows(filtered);
    } catch (e) {
      setErr(e?.message || String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!me?.transport_id) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.transport_id]);

  const pickup = useMemo(() => rows.filter((r) => r.status === "pickup"), [rows]);
  const loaded = useMemo(() => rows.filter((r) => r.status === "loaded"), [rows]);

  async function setStatus(id, status) {
    try {
      const { error } = await supabase
        .from("transport_orders")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      await load();
    } catch (e) {
      alert(e?.message || String(e));
    }
  }

  return (
    <div className="wrap">
      <header className="header-row" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 className="title">TRANSPORT • PICKUP</h1>
          <div className="subtitle">PICKUP → LOADED → SHKARKO NË BAZË</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link className="btn secondary" href="/transport/menu">MENU</Link>
        </div>
      </header>

      <section className="card" style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <button className="btn secondary" onClick={load} disabled={loading}>
            REFRESH
          </button>
          <div style={{ fontWeight: 900, letterSpacing: 0.5 }}>SHKARKO NË BAZË</div>
        </div>

        {err ? (
          <div style={{ color: "#ef4444", marginTop: 10, fontWeight: 800 }}>{err}</div>
        ) : null}

        <div style={{ marginTop: 14, fontWeight: 900, fontSize: 18 }}>PICKUP ({pickup.length})</div>
        {pickup.length === 0 ? (
          <div style={{ opacity: 0.75, marginTop: 6 }}>S'ka asnjë porosi në PICKUP.</div>
        ) : (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            {pickup.map((r) => (
              <div key={r.id} className="row" style={{ justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 90, fontWeight: 900 }}>{pickCode(r) || "T?"}</div>
                <div style={{ flex: 1, opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r?.data?.client?.name || "—"}
                </div>
                <button className="btn secondary" onClick={() => setStatus(r.id, "loaded")}>
                  LOADED
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 16, fontWeight: 900, fontSize: 18 }}>LOADED ({loaded.length})</div>
        {loaded.length === 0 ? (
          <div style={{ opacity: 0.75, marginTop: 6 }}>S'ka asnjë porosi të LOADED.</div>
        ) : (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            {loaded.map((r) => (
              <div key={r.id} className="row" style={{ justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 90, fontWeight: 900 }}>{pickCode(r) || "T?"}</div>
                <div style={{ flex: 1, opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r?.data?.client?.name || "—"}
                </div>
                <Link className="btn primary" href={`/transport/offload?id=${encodeURIComponent(r.id)}`}>
                  SHKARKO
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
