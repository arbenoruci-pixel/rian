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

export default function RestorePage() {
  const [pin, setPin] = useState("");
  const [dates, setDates] = useState([]);
  const [loadingDates, setLoadingDates] = useState(true);
  const [selectedDate, setSelectedDate] = useState("");
  const [confirm, setConfirm] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  async function loadDates() {
    setLoadingDates(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      if (pin) qs.set("pin", pin);
      const r = await fetch(`/api/backup/dates?${qs.toString()}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "DATES_FAILED");
      const items = Array.isArray(j.items) ? j.items : [];
      setDates(items);
      if (!selectedDate && items[0]?.backup_date) setSelectedDate(items[0].backup_date);
    } catch (e) {
      setError(String(e?.message || e));
      setDates([]);
    } finally {
      setLoadingDates(false);
    }
  }

  useEffect(() => {
    loadDates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedInfo = useMemo(() => {
    return dates.find((d) => d.backup_date === selectedDate) || null;
  }, [dates, selectedDate]);

  async function dryRun() {
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const qs = new URLSearchParams();
      if (pin) qs.set("pin", pin);
      qs.set("date", selectedDate);
      qs.set("dry", "1");
      const r = await fetch(`/api/backup/restore?${qs.toString()}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "DRY_RUN_FAILED");
      setResult(j);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setRunning(false);
    }
  }

  async function doRestore() {
    if (confirm.trim().toUpperCase() !== "PO") {
      setError("SHKRUAJ 'PO' PËR KONFIRMIM.");
      return;
    }
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const qs = new URLSearchParams();
      if (pin) qs.set("pin", pin);
      qs.set("date", selectedDate);
      const r = await fetch(`/api/backup/restore?${qs.toString()}`, { method: "POST" });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "RESTORE_FAILED");
      setResult(j);
      setConfirm("");
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <main style={{ padding: 16, maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ margin: 0, letterSpacing: 1 }}>RESTORE NGA BACKUP</h1>
      <p style={{ opacity: 0.85, marginTop: 6 }}>
        KJO FAQE RIKTHEN KLIENTAT + POROSIT NGA <b>backups_daily</b> NË TABELAT <b>clients</b> DHE <b>orders</b>.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "14px 0" }}>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="PIN (nëse është aktiv)"
          style={{ padding: "10px 12px", borderRadius: 10, minWidth: 220 }}
        />
        <button
          onClick={loadDates}
          disabled={loadingDates || running}
          style={{ padding: "10px 12px", borderRadius: 10, fontWeight: 900 }}
        >
          {loadingDates ? "DUKE NGARKU..." : "RIFRESKO DATAT"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontWeight: 900, opacity: 0.9 }}>DATA:</label>
        <select
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          style={{ padding: "10px 12px", borderRadius: 10, minWidth: 180 }}
        >
          {dates.map((d) => (
            <option key={d.backup_date} value={d.backup_date}>
              {d.backup_date}
            </option>
          ))}
        </select>
        <button
          onClick={dryRun}
          disabled={!selectedDate || running}
          style={{ padding: "10px 12px", borderRadius: 10, fontWeight: 900 }}
        >
          DRY RUN
        </button>
      </div>

      {selectedInfo ? (
        <p style={{ marginTop: 10, opacity: 0.9 }}>
          <b>BACKUP:</b> {selectedInfo.backup_date} • <b>KLIENTA:</b> {selectedInfo.clients_cnt} • <b>POROSI:</b>{" "}
          {selectedInfo.orders_cnt} • <b>HAPURA:</b> {selectedInfo.open_orders_cnt} • <b>KRIJUAR:</b> {fmtDate(selectedInfo.created_at)}
        </p>
      ) : null}

      <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)" }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>KONFIRMO RESTORE</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Shkruaj PO"
            style={{ padding: "10px 12px", borderRadius: 10, minWidth: 160 }}
          />
          <button
            onClick={doRestore}
            disabled={!selectedDate || running}
            style={{ padding: "10px 12px", borderRadius: 10, fontWeight: 900 }}
          >
            {running ? "DUKE RIKTHY..." : "RESTORE"}
          </button>
        </div>
        <p style={{ marginTop: 10, opacity: 0.85 }}>
          RESTORE BËN <b>UPSERT</b> (nuk fshin). Kjo do të rikthejë rekordet që mund të jenë fshirë/korruptuar.
        </p>
      </div>

      {error ? (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: "1px solid #7a2b2b", background: "#2a1111" }}>
          <b>GABIM:</b> {error}
        </div>
      ) : null}

      {result ? (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)" }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>REZULTATI</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0, opacity: 0.9 }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      ) : null}
    </main>
  );
}