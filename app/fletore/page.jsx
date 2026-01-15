"use client";

import React, { useEffect, useMemo, useState } from "react";

function fmtDate(d) {
  if (!d) return "";
  try {
    return new Date(d).toLocaleString("sq-AL");
  } catch {
    return String(d);
  }
}

const clamp = (s, n = 80) => {
  const t = String(s || "");
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
};

export default function FletorePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null); // snapshot payload
  const [meta, setMeta] = useState(null); // {id, created_at, pin, downloadUrl}
  const [pin, setPin] = useState("");
  const [running, setRunning] = useState(false);
  const [q, setQ] = useState("");

  async function loadLatest(p = pin) {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      if (p) qs.set("pin", p);
      const r = await fetch(`/api/backup/latest?${qs.toString()}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "FAILED_LATEST");

      const item = j.item;
      setMeta({
        id: item?.id,
        created_at: item?.created_at,
        pin: item?.pin,
        downloadUrl: `/api/backup/latest?${qs.toString()}&raw=1`,
      });
      setData(item?.payload || null);
    } catch (e) {
      setError(String(e?.message || e));
      setData(null);
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
      if (pin) qs.set("pin", pin);
      const r = await fetch(`/api/backup/run?${qs.toString()}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "FAILED_BACKUP");
      await loadLatest();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    loadLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clients = useMemo(() => {
    const arr = Array.isArray(data?.clients) ? data.clients : [];
    const term = String(q || "").trim().toLowerCase();
    if (!term) return arr;
    return arr.filter((c) => {
      const name = String(c?.name || "").toLowerCase();
      const phone = String(c?.phone || "").toLowerCase();
      const code = String(c?.code || "").toLowerCase();
      return name.includes(term) || phone.includes(term) || code.includes(term);
    });
  }, [data, q]);

  return (
    <main style={{ padding: 16, maxWidth: 1000, margin: "0 auto" }}>
      <h1 style={{ margin: 0, letterSpacing: 1 }}>FLETORJA</h1>
      <p style={{ opacity: 0.85, marginTop: 6 }}>
        KËTU I KE BACKUP‑ET (ONLINE) TË KLIENTAVE/POROSIVE. NËSE APP PRISHET, HAP /FLETORE DHE I GJEN EMRAT, TEL,
        KODAT, COPË, TOTAL.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "14px 0" }}>
        <button onClick={() => loadLatest()} disabled={loading} style={{ padding: "10px 12px", borderRadius: 10, fontWeight: 900 }}>
          RIFRESKO
        </button>

        <input
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN BACKUP (p.sh. 654321)"
          style={{ padding: "10px 12px", borderRadius: 10, minWidth: 220 }}
        />

        <button onClick={runNow} disabled={running} style={{ padding: "10px 12px", borderRadius: 10, fontWeight: 900 }}>
          {running ? "DUKE RUJT…" : "RUAJ TANI"}
        </button>

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

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="KËRKO: EMËR / TEL / KOD"
          style={{ padding: "10px 12px", borderRadius: 10, minWidth: 260, flex: "1 1 260px" }}
        />
      </div>

      {error ? (
        <div style={{ padding: 12, borderRadius: 12, border: "1px solid #7a2b2b", background: "#2a1111" }}>
          <b>GABIM:</b> {error}
          <div style={{ marginTop: 8, opacity: 0.9 }}>
            Diagnostikë: <a href="/api/backup/ping" target="_blank" rel="noreferrer">/api/backup/ping</a>
            <div style={{ marginTop: 8 }}>
              Nëse del <code>PIN_REQUIRED</code> → në Vercel vendose env <b>BACKUP_PIN</b> dhe përdor të njëjtin PIN këtu.
            </div>
            <div style={{ marginTop: 6 }}>
              Nëse del <code>NO_BACKUPS_TABLE_ACCESS</code> → krijoje tabelën <code>app_backups</code> në Supabase (ose jep env
              <code>BACKUPS_TABLE</code> nëse e ke tjetër).
            </div>
          </div>
        </div>
      ) : null}

      {loading ? <p>DUKE NGARKU…</p> : null}

      {data ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", opacity: 0.9 }}>
            <div>
              <b>BACKUP:</b> {fmtDate(data.generated_at)}
            </div>
            <div>
              <b>KLIENTA:</b> {data.clients_count ?? (Array.isArray(data.clients) ? data.clients.length : 0)}
            </div>
            <div>
              <b>POROSI:</b> {data.orders_count ?? (Array.isArray(data.orders) ? data.orders.length : 0)}
            </div>
            {meta?.created_at ? (
              <div>
                <b>RUJT NË SERVER:</b> {fmtDate(meta.created_at)}
              </div>
            ) : null}
          </div>

          <h2 style={{ marginTop: 18, marginBottom: 8, letterSpacing: 1 }}>KLIENTAT</h2>

          <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid rgba(255,255,255,0.08)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.85 }}>
                  <th style={{ padding: 10 }}>KOD</th>
                  <th style={{ padding: 10 }}>EMRI</th>
                  <th style={{ padding: 10 }}>TELEFONI</th>
                  <th style={{ padding: 10 }}>AKTIVE</th>
                  <th style={{ padding: 10 }}>COPË</th>
                  <th style={{ padding: 10 }}>€ TOTAL</th>
                  <th style={{ padding: 10 }}>E FUNDIT</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.phone || c.code} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    <td style={{ padding: 10, fontWeight: 900 }}>{c.code ?? "-"}</td>
                    <td style={{ padding: 10 }} title={c.name || ""}>{clamp(c.name || "-")}</td>
                    <td style={{ padding: 10 }}>{c.phone || "-"}</td>
                    <td style={{ padding: 10 }}>{c.active_orders ?? 0}</td>
                    <td style={{ padding: 10 }}>{c.pieces_sum ?? 0}</td>
                    <td style={{ padding: 10 }}>{Number(c.total_sum || 0).toFixed(2)}</td>
                    <td style={{ padding: 10 }}>{fmtDate(c.last_order_at)}</td>
                  </tr>
                ))}
                {clients.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 12, opacity: 0.75 }}>
                      S’KA TË DHËNA.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, opacity: 0.75, fontSize: 13 }}>
            Shënim: Kjo është “FLETORJA” për emergjencë — të paktën emër/tel/kod/copë/total. Për detaje të porosisë përdor
            app-in normal.
          </div>
        </div>
      ) : null}
    </main>
  );
}
