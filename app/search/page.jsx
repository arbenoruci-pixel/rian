"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { normalizeCode } from "@/lib/baseCodes";
import { normTCode } from "@/lib/transport/transportDb";

// ---- helpers ----
function isTCode(v) {
  const s = String(v ?? "").trim();
  return /^t\s*\d+/i.test(s) || s.toUpperCase().startsWith("T");
}
function normalizeAnyCode(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  if (isTCode(raw)) return normTCode(raw);
  return String(normalizeCode(raw) ?? "").trim();
}
function stageLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "pranim") return "PRANIMI";
  if (s === "pastrim" || s === "pastrimi") return "PASTRIMI";
  if (s === "gati") return "GATI";
  if (s === "marrje" || s === "marrje_sot" || s === "dorzim" || s === "dorzuar")
    return "MARRJE";
  return (status || "N/A").toUpperCase();
}
function stageHref(status, code) {
  const s = String(status || "").toLowerCase();
  const c = encodeURIComponent(code || "");
  if (s === "pranim") return `/pranimi?q=${c}`;
  if (s === "pastrim" || s === "pastrimi") return `/pastrimi?q=${c}`;
  if (s === "gati") return `/gati?q=${c}`;
  if (s === "marrje" || s === "marrje_sot" || s === "dorzim" || s === "dorzuar")
    return `/marrje-sot?q=${c}`;
  return `/pastrimi?q=${c}`;
}

export default function SearchPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const codeParam = sp.get("code") || sp.get("q") || "";
  const code = useMemo(() => normalizeAnyCode(codeParam), [codeParam]);

  const [loading, setLoading] = useState(false);
  const [baseRow, setBaseRow] = useState(null);
  const [transportRow, setTransportRow] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    async function run() {
      setErr("");
      setBaseRow(null);
      setTransportRow(null);

      const q = normalizeAnyCode(codeParam);
      if (!q) return;

      setLoading(true);
      try {
        if (isTCode(q)) {
          const { data, error } = await supabase
            .from("transport_orders")
            .select("*")
            .eq("code_str", q)
            .order("created_at", { ascending: false })
            .limit(1);
          if (error) throw error;
          if (alive) setTransportRow(data?.[0] || null);
        } else {
          const n = Number(q);
          if (!Number.isFinite(n) || n <= 0) {
            if (alive) setErr("KODI NUK ËSHTË I SAKTË.");
            return;
          }
          const { data, error } = await supabase
            .from("orders")
            .select("*")
            .eq("code", n)
            .order("created_at", { ascending: false })
            .limit(1);
          if (error) throw error;
          if (alive) setBaseRow(data?.[0] || null);
        }
      } catch (e) {
        if (alive) setErr(e?.message || "GABIM NË KËRKIM.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    run();
    return () => {
      alive = false;
    };
  }, [codeParam]);

  const row = baseRow || transportRow;
  const isTransport = !!transportRow;

  const createdBy =
    row?.created_by_name ||
    row?.created_by ||
    row?.data?._audit?.created_by_name ||
    row?.data?._audit?.created_by ||
    "";

  const name =
    row?.client_name ||
    row?.data?.client?.name ||
    row?.client?.name ||
    row?.name ||
    "PA EMËR";

  const phone =
    row?.client_phone ||
    row?.data?.client?.phone ||
    row?.client?.phone ||
    row?.phone ||
    "";

  const status = isTransport ? row?.status : row?.status;
  const stage = stageLabel(status);

  const openHref = isTransport
    ? `/transport/item?id=${encodeURIComponent(row?.id || "")}`
    : stageHref(status, code);

  return (
    <div className="container" style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn ghost" onClick={() => router.push("/")}>
          HOME
        </button>
        <div style={{ flex: 1 }} />
        <Link className="btn ghost" href="/pastrimi">
          LISTA
        </Link>
      </div>

      <h1 style={{ marginTop: 16, fontSize: 18 }}>KËRKO</h1>

      <div className="card" style={{ marginTop: 10 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="badge">{isTCode(code) ? "TRANSPORT" : "BAZA"}</span>
          <span className="badge">{code || "—"}</span>
          {loading ? <span className="badge">DUKE KËRKUAR…</span> : null}
          {err ? <span className="badge danger">{err}</span> : null}
        </div>

        {!code ? (
          <div style={{ marginTop: 10, opacity: 0.85 }}>
            SHKRUAJ KODIN NË LINK OSE KTHEHU TE HOME DHE KËRKO NGA ATY.
          </div>
        ) : null}

        {code && !loading && !row && !err ? (
          <div style={{ marginTop: 10, opacity: 0.85 }}>NUK U GJET ASGJË PËR KËTË KOD.</div>
        ) : null}

        {row ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span className="badge ok">{stage}</span>
                {createdBy ? <span className="badge">KUSH E KA PRU: {String(createdBy).toUpperCase()}</span> : null}
              </div>

              <div className="row" style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontWeight: 800 }}>{String(name).toUpperCase()}</div>
                  {phone ? <div style={{ opacity: 0.85 }}>{phone}</div> : null}
                </div>

                <Link className="btn" href={openHref}>
                  HAPE
                </Link>
              </div>

              {isTransport ? (
                <div style={{ opacity: 0.85 }}>
                  <div>KODI: {row?.code_str || row?.code}</div>
                  {row?.address ? <div>ADRESA: {row.address}</div> : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ marginTop: 12, opacity: 0.75, fontSize: 12 }}>
        TIP: NËSE KLIENTI ËSHTË NË GATI OSE MARRJE, KËTU TË TREGON AUTOMATIKISHT STAZËN.
      </div>
    </div>
  );
}
