"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import supabase from "@/lib/supabaseClient";

/**
 * PASRTIMI page FIX:
 * 1) default import: import supabase from '@/lib/supabaseClient'
 * 2) realtime channel inside useEffect + guard for supabase existence
 * 3) "use client" first line
 * 4) 7s timeout + abortSignal for SELECT to reduce Safari "Load failed"
 */

function with7sTimeout(builderFn) {
  const controller = new AbortController();
  const t = setTimeout(() => {
    try {
      controller.abort();
    } catch (e) {}
  }, 7000);

  // builderFn should return a PostgrestBuilder
  const q = builderFn();

  // supabase-js v2 / postgrest-js supports abortSignal(signal)
  try {
    if (q && typeof q.abortSignal === "function") {
      q.abortSignal(controller.signal);
    }
  } catch (e) {}

  const run = async () => {
    try {
      return await q;
    } finally {
      clearTimeout(t);
    }
  };

  return run();
}

export default function PastrimiPage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);

  // prevent multiple parallel loads / race updates
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadOrders = useMemo(() => {
    return async () => {
      setErr("");
      setLoading(true);

      try {
        if (!supabase || typeof supabase.from !== "function") {
          throw new Error("SUPABASE CLIENT MUNGON / IMPORT I GABUAR");
        }

        // 7s timeout SELECT (reduces iOS Safari “Load failed” on stuck fetch)
        const { data, error } = await with7sTimeout(() =>
          supabase
            .from("orders")
            .select("*")
            .eq("status", "pastrim")
            .order("created_at", { ascending: false })
        );

        if (error) throw error;

        if (aliveRef.current) {
          setRows(Array.isArray(data) ? data : []);
        }
      } catch (e) {
        // Abort in Safari often looks like generic fetch failure
        const msg =
          (e && (e.message || e.toString && e.toString())) ||
          "GABIM I PANJOHUR";
        if (aliveRef.current) setErr(msg);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    };
  }, []);

  // Initial load
  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  // Realtime subscription (inside useEffect + guard)
  useEffect(() => {
    if (!supabase || typeof supabase.channel !== "function") return;

    const ch = supabase
      .channel("pastrim-live-orders")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        () => {
          // reload on any change
          loadOrders();
        }
      )
      .subscribe();

    return () => {
      try {
        supabase.removeChannel(ch);
      } catch (e) {}
    };
  }, [loadOrders]);

  return (
    <div className="page">
      <div className="header">
        <div className="title">PASTRIMI</div>
        <button className="btn" onClick={loadOrders} disabled={loading}>
          {loading ? "DUKE NGARKUAR…" : "REFRESH"}
        </button>
      </div>

      {err ? (
        <div className="error">
          <div className="errorTitle">GABIM</div>
          <div className="errorMsg">{String(err)}</div>
        </div>
      ) : null}

      <div className="list">
        {rows.length === 0 && !loading ? (
          <div className="empty">S’KA POROSI NË PASTRIM.</div>
        ) : null}

        {rows.map((r) => {
          const code = r?.code ?? r?.code_n ?? "—";
          const pieces = r?.pieces ?? r?.cope ?? r?.qty ?? "—";
          const total = r?.total ?? r?.shuma ?? r?.amount ?? "—";
          const name = r?.client_name ?? r?.name ?? r?.emri ?? "";

          return (
            <div key={r.id || `${code}-${Math.random()}`} className="row">
              <div className="left">
                <span className="code">{code}</span>
                <span className="name">{String(name || "").toUpperCase()}</span>
              </div>
              <div className="right">
                <span className="meta">{pieces} COPË</span>
                <span className="meta">€{total}</span>
              </div>
            </div>
          );
        })}
      </div>

      <style jsx>{`
        .page {
          padding: 14px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 12px;
        }
        .title {
          font-weight: 900;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .btn {
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.16);
          background: rgba(255, 255, 255, 0.06);
        }
        .btn:disabled {
          opacity: 0.6;
        }
        .error {
          padding: 12px;
          border-radius: 12px;
          border: 1px solid rgba(255, 80, 80, 0.35);
          background: rgba(255, 80, 80, 0.12);
          margin-bottom: 12px;
        }
        .errorTitle {
          font-weight: 900;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 6px;
        }
        .errorMsg {
          opacity: 0.9;
          word-break: break-word;
        }
        .list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.05);
        }
        .left {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .code {
          font-weight: 900;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          opacity: 0.95;
          white-space: nowrap;
        }
        .name {
          font-weight: 800;
          opacity: 0.9;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 56vw;
        }
        .right {
          display: flex;
          align-items: center;
          gap: 10px;
          white-space: nowrap;
        }
        .meta {
          font-weight: 800;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          opacity: 0.85;
        }
        .empty {
          padding: 14px;
          opacity: 0.7;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }
      `}</style>
    </div>
  );
}