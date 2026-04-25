"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import Link from "@/lib/routerCompat.jsx";
import { useRouter, useSearchParams } from "@/lib/routerCompat.jsx";
import { findLatestOrderByCode } from "@/lib/ordersService";
import { normalizeCode } from "@/lib/baseCodes";
import { normTCode } from "@/lib/transport/transportDb";

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
  if (s === "marrje" || s === "marrje_sot" || s === "dorzim" || s === "dorzuar") return "MARRJE";
  return (status || "N/A").toUpperCase();
}

function stageHref(status, code) {
  const s = String(status || "").toLowerCase();
  const c = encodeURIComponent(code || "");
  if (s === "pranim") return `/pranimi?q=${c}`;
  if (s === "pastrim" || s === "pastrimi") return `/pastrimi?q=${c}`;
  if (s === "gati") return `/gati?q=${c}`;
  if (s === "marrje" || s === "marrje_sot" || s === "dorzim" || s === "dorzuar") return `/marrje-sot?q=${c}`;
  return `/pastrimi?q=${c}`;
}

function codeLabel(row) {
  return String(row?.code ?? "").trim() || "";
}

function SearchPageInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const codeParam = sp.get("code") || sp.get("q") || "";
  const code = useMemo(() => normalizeAnyCode(codeParam), [codeParam]);

  const [loading, setLoading] = useState(false);
  const [row, setRow] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    async function run() {
      setErr("");
      setRow(null);

      const q = normalizeAnyCode(codeParam);
      if (!q) return;

      if (isTCode(q)) {
        router.replace(`/transport/item?code=${encodeURIComponent(q)}&from=home_search`);
        return;
      }

      setLoading(true);
      try {
        const n = Number(q);
        if (!Number.isFinite(n) || n <= 0) {
          if (alive) setErr("KODI NUK ËSHTË I SAKTË.");
          return;
        }
        const found = await findLatestOrderByCode("orders", q, "*");
        if (alive) setRow(found || null);
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
  }, [codeParam, router]);

  const name = row?.client_name || row?.data?.client?.name || row?.client?.name || row?.name || "PA EMËR";
  const phone = row?.client_phone || row?.data?.client?.phone || row?.client?.phone || row?.phone || "";
  const status = row?.status;
  const stage = stageLabel(status);
  const openHref = stageHref(status, code);

  return (
    <div className="container" style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn ghost" onClick={() => router.push("/")}>HOME</button>
        <div style={{ flex: 1 }} />
        <Link className="btn ghost" href="/pastrimi" prefetch={false}>LISTA</Link>
      </div>

      <h1 style={{ marginTop: 16, fontSize: 18 }}>KËRKO</h1>

      <div className="card" style={{ marginTop: 10 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="badge">BAZA</span>
          <span className="badge">{code || "—"}</span>
          {loading ? <span className="badge">DUKE KËRKUAR…</span> : null}
          {err ? <span className="badge danger">{err}</span> : null}
        </div>

        {!code ? <div style={{ marginTop: 10, opacity: 0.85 }}>SHKRUAJ KODIN NË LINK OSE KTHEHU TE HOME DHE KËRKO NGA ATY.</div> : null}
        {code && !loading && !row && !err ? <div style={{ marginTop: 10, opacity: 0.85 }}>NUK U GJET ASGJË PËR KËTË KOD.</div> : null}

        {row ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="badge ok">{stage}</span>
              </div>

              <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 18, background: 'rgba(255,255,255,0.04)', padding: 14, display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ width: 46, minWidth: 46, height: 46, marginRight: 10, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#39d86f', color: '#03140a', fontSize: 14, fontWeight: 1000, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 12px 26px rgba(57,216,111,0.18)' }}>{codeLabel(row) || code}</div>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ffffff', fontSize: 18, fontWeight: 950, letterSpacing: 0.2 }}>{String(name).toUpperCase()}</span>
                  </div>
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap' }}>{stage}</span>
                </div>

                <div style={{ color: '#fbbf24', fontSize: 14, fontWeight: 950, letterSpacing: 0.2 }}>
                  {(Number(row?.pieces || row?.data?.pieces || row?.data?.totals?.pieces || 0) || 0)} copë • {Number(row?.total || row?.data?.total || row?.data?.totals?.total || 0) || 0} €
                </div>

                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {String(row?.address || row?.pickup_address || row?.data?.client?.address || row?.data?.address || phone || 'Pa adresë / telefon')}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Link className="btn" href={openHref} prefetch={false}>HAPE</Link>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchPageInner />
    </Suspense>
  );
}
