"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("sq-AL");
  } catch {
    return String(d);
  }
}

export default function FletorePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [meta, setMeta] = useState(null); // {url,path,bucket}
  const [data, setData] = useState(null); // backup json
  const [pin, setPin] = useState("");
  const [q, setQ] = useState("");
  const [running, setRunning] = useState(false);

  const nameOfClient = (c) => {
    const full = String(c?.full_name || c?.name || "").trim();
    if (full) return full;
    const fn = String(c?.first_name || "").trim();
    const ln = String(c?.last_name || "").trim();
    const combo = `${fn} ${ln}`.trim();
    return combo || "-";
  };

  const phoneOfClient = (c) => String(c?.phone || c?.client_phone || "").trim() || "-";

  async function loadLiveData() {
    const [cRes, oRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, code, full_name, first_name, last_name, phone, created_at, updated_at")
        .order("code", { ascending: true }),
      supabase
        .from("orders")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500),
    ]);

    if (cRes.error) throw new Error(`LIVE_CLIENTS_FAILED: ${cRes.error.message}`);
    if (oRes.error) throw new Error(`LIVE_ORDERS_FAILED: ${oRes.error.message}`);

    const clients = (cRes.data || []).map((c) => ({
      ...c,
      // make sure UI always has these
      code: c.code,
      full_name: nameOfClient(c),
      phone: phoneOfClient(c),
    }));

    const orders = (oRes.data || []).map((o) => {
      const client_name =
        String(o?.client_full_name || o?.client_name || o?.full_name || o?.name || "").trim() || "-";
      const client_phone = String(o?.client_phone || o?.phone || "").trim() || "-";
      return { ...o, client_name, client_phone };
    });

    setMeta({ mode: "LIVE" });
    setData({ backup_date: null, clients, orders, live: true });
  }
  async function loadLatest(pinOverride) {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const qs = new URLSearchParams();
      const usePin = String(pinOverride ?? pin ?? "").trim();
      if (usePin) qs.set("pin", usePin);
      const r = await fetch(`/api/backup/latest?${qs.toString()}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "FAILED_LATEST");
      const item = j.item;
      if (!item || !item?.payload) {
        // No backup yet (or empty) -> show live DB data instead of red error.
        setNotice("");
        await loadLiveData();
        setMeta(null);
        return;
      }
      setMeta({
        id: item?.id,
        created_at: item?.created_at,
        pin: item?.pin,
        downloadUrl: `/api/backup/latest?${qs.toString()}&raw=1`,
      });
      setData(item.payload);
    } catch (e) {
      // If backup fetch fails, we still try to show live data.
      setNotice("");
      await loadLiveData();
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      const usePin = String(pin || "").trim();
      if (usePin) qs.set("pin", usePin);
      const r = await fetch(`/api/backup/run?${qs.toString()}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "FAILED_BACKUP");
      // after run, reload latest
      await loadLatest();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    loadLatest();
  }, []);

  // Auto-refresh when PIN changes (so user doesn't have to guess when to press RIFRESKO)
  useEffect(() => {
    const p = String(pin || "").trim();
    // if user entered a 6-digit pin (or cleared the pin), refresh
    if (p && p.length < 6) return;
    const t = setTimeout(() => {
      loadLatest(p);
    }, 250);
    return () => clearTimeout(t);
  }, [pin]);

  const clients = useMemo(() => {
    const arr = Array.isArray(data?.clients) ? data.clients : [];
    const s = String(q || "").trim().toLowerCase();
    if (!s) return arr;
    return arr.filter((c) => {
      const code = String(c?.code ?? "").toLowerCase();
      const name = nameOfClient(c).toLowerCase();
      const phone = phoneOfClient(c).toLowerCase();
      return code.includes(s) || name.includes(s) || phone.includes(s);
    });
  }, [data, q]);

  const orders = useMemo(() => {
    const arr = Array.isArray(data?.orders) ? data.orders : [];
    const s = String(q || "").trim().toLowerCase();
    if (!s) return arr;
    return arr.filter((o) => {
      const code = String(o?.code ?? o?.client_code ?? "").toLowerCase();
      const name = String(o?.client_full_name ?? o?.client_name ?? o?.raw?.client_name ?? "").toLowerCase();
      const phone = String(o?.client_phone ?? o?.raw?.client_phone ?? "").toLowerCase();
      return code.includes(s) || name.includes(s) || phone.includes(s);
    });
  }, [data, q]);

  return (
    <main style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ margin: 0, letterSpacing: 1 }}>FLETORJA</h1>
      <p style={{ opacity: 0.85, marginTop: 6 }}>
        KËTU I KE BACKUP‑ET DITORE. NËSE APP PRISHET, HAP KËTU DHE I GJEN KLIENTAT.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "14px 0" }}>
        <button
          onClick={loadLatest}
          disabled={loading}
          style={{ padding: "10px 12px", borderRadius: 10, fontWeight: 800 }}
        >
          RIFRESKO
        </button>

        <input
          value={pin}
          onChange={(e) => {
            const v = String(e.target.value || "")
              .replace(/[^0-9]/g, "")
              .slice(0, 12);
            setPin(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") loadLatest();
          }}
          placeholder="PIN BACKUP (opsionale)"
          style={{ padding: "10px 12px", borderRadius: 10, minWidth: 220 }}
        />

        <button
          onClick={runNow}
          disabled={running}
          style={{ padding: "10px 12px", borderRadius: 10, fontWeight: 900 }}
        >
          {running ? "DUKE RUJT..." : "RUAJ TANI"}
        </button>

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="KËRKO KODIN / EMRIN / TELEFONIN"
          style={{ padding: "10px 12px", borderRadius: 10, minWidth: 260, flex: 1 }}
        />

        {meta?.downloadUrl ? (
          <a
            href={meta.downloadUrl}
            target="_blank"
            rel="noreferrer"
            style={{ padding: "10px 12px", borderRadius: 10, fontWeight: 900, textDecoration: "none" }}
          >
            SHKARKO JSON
          </a>
        ) : null}
      </div>

      {error && !data ? (
        <div style={{ padding: 12, borderRadius: 12, border: "1px solid #7a2b2b", background: "#2a1111" }}>
          <b>GABIM:</b> {error}
          <div style={{ marginTop: 8, opacity: 0.9 }}>
            <div style={{ marginBottom: 6 }}>
              Diagnostikë: <a href="/api/backup/ping" target="_blank" rel="noreferrer">/api/backup/ping</a>
            </div>
            <div>
              Nëse sheh <code>MISSING_SUPABASE_SERVICE_ROLE_KEY</code> → shto env <code>SUPABASE_SERVICE_ROLE_KEY</code> në Vercel.
            </div>
            <div style={{ marginTop: 6 }}>
              Nëse sheh <code>FETCH_FAILED</code> / <code>fetch failed</code> → zakonisht do të thotë që KEY është ruajtur me newline/space.
              Hape env-in në Vercel dhe ri‑ruaje KEY-n si <b>një rresht</b> (pa hapësira, pa rreshta të rinj).
            </div>
          </div>
        </div>
      ) : null}

      {notice && data ? (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", opacity: 0.95 }}>
          {notice === "NO_BACKUP_YET" ? (
            <span>
              S’KA BACKUP ENDE — PO SHFAQIM TË DHËNAT LIVE NGA DB. (SHTYPE <b>RUAJ TANI</b> PËR TA KRIJU BACKUP-IN E PARË)
            </span>
          ) : (
            <span>{notice}</span>
          )}
        </div>
      ) : null}

      {loading ? <p>DUKE NGARKU...</p> : null}

      {data ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", opacity: 0.9 }}>
            <div>
              <b>BACKUP:</b> {fmtDate(data.generated_at)}
            </div>
            <div>
              <b>KLIENTA:</b> {data.clients_count}
            </div>
            <div>
              <b>POROSI:</b> {data.orders_count}
            </div>
          </div>

          <h2 style={{ marginTop: 18, marginBottom: 8, letterSpacing: 1 }}>KLIENTAT</h2>
          <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.85 }}>
                  <th style={{ padding: 10 }}>KODI</th>
                  <th style={{ padding: 10 }}>EMRI</th>
                  <th style={{ padding: 10 }}>TELEFONI</th>
                  <th style={{ padding: 10 }}>POROSI</th>
                  <th style={{ padding: 10 }}>€ TOTAL</th>
                  <th style={{ padding: 10 }}>E FUNDIT</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c, idx) => (
                  <tr key={c.id || c.code || c.phone || idx} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    <td style={{ padding: 10, fontWeight: 900 }}>{c.code ?? idx + 1}</td>
                    <td style={{ padding: 10 }}>{nameOfClient(c)}</td>
                    <td style={{ padding: 10 }}>{phoneOfClient(c)}</td>
                    <td style={{ padding: 10 }}>{c.orders_count || 0}</td>
                    <td style={{ padding: 10 }}>{Number(c.total_sum || 0).toFixed(2)}</td>
                    <td style={{ padding: 10 }}>{fmtDate(c.last_order_at)}</td>
                  </tr>
                ))}
                {clients.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 12, opacity: 0.75 }}>
                      S’KA TË DHËNA.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <h2 style={{ marginTop: 18, marginBottom: 8, letterSpacing: 1 }}>POROSIT</h2>
          <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.85 }}>
                  <th style={{ padding: 10 }}>KODI</th>
                  <th style={{ padding: 10 }}>STATUSI</th>
                  <th style={{ padding: 10 }}>EMRI</th>
                  <th style={{ padding: 10 }}>TELEFONI</th>
                  <th style={{ padding: 10 }}>€ TOTAL</th>
                  <th style={{ padding: 10 }}>€ PAGUAR</th>
                  <th style={{ padding: 10 }}>KRIJUAR</th>
                </tr>
              </thead>
              <tbody>
                {orders.slice(0, 400).map((o) => (
                  <tr key={o.id || o.code || o.created_at} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    <td style={{ padding: 10, fontWeight: 900 }}>{o.client_code ?? o.code ?? "-"}</td>
                    <td style={{ padding: 10 }}>{(o.status || "").toUpperCase()}</td>
                    <td style={{ padding: 10 }}>{o.client_full_name || o.client_name || "-"}</td>
                    <td style={{ padding: 10 }}>{o.client_phone || "-"}</td>
                    <td style={{ padding: 10 }}>{Number(o.total || 0).toFixed(2)}</td>
                    <td style={{ padding: 10 }}>{Number(o.paid || 0).toFixed(2)}</td>
                    <td style={{ padding: 10 }}>{fmtDate(o.created_at)}</td>
                  </tr>
                ))}
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 12, opacity: 0.75 }}>
                      S’KA POROSI.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {orders.length > 400 ? (
            <p style={{ opacity: 0.8, marginTop: 10 }}>
              Po i shfaq 400 porositë e fundit në ekran. JSON-i i shkarkuar i ka të gjitha.
            </p>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}
