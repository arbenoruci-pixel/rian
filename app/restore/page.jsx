"use client";

import React, { useEffect, useMemo, useState, useCallback } from "react";

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
  const [loadingDates, setLoadingDates] = useState(false);
  const [selectedDate, setSelectedDate] = useState("");
  const [confirm, setConfirm] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  // Funksioni për të ngarkuar datat nga API
  const loadDates = useCallback(async () => {
    setLoadingDates(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      if (pin) qs.set("pin", pin);
      
      const r = await fetch(`/api/backup/dates?${qs.toString()}`, { cache: "no-store" });
      const j = await r.json();
      
      if (!r.ok || !j?.ok) throw new Error(j?.error || "Dështoi ngarkimi i datave");
      
      const items = Array.isArray(j.items) ? j.items : [];
      setDates(items);
      if (items.length > 0) setSelectedDate(items[0].backup_date);
    } catch (e) {
      setError(e.message);
      setDates([]);
    } finally {
      setLoadingDates(false);
    }
  }, [pin]);

  useEffect(() => {
    loadDates();
  }, [loadDates]);

  const selectedInfo = useMemo(() => {
    return dates.find((d) => d.backup_date === selectedDate) || null;
  }, [dates, selectedDate]);

  // Funksioni për provë (Dry Run) ose Restore real
  async function handleRestore(isDryRun = false) {
    if (!isDryRun && confirm.trim().toUpperCase() !== "PO") {
      setError("Shkruaj 'PO' për të konfirmuar rikthimin.");
      return;
    }

    setRunning(true);
    setError("");
    setResult(null);

    try {
      const qs = new URLSearchParams();
      if (pin) qs.set("pin", pin);
      qs.set("date", selectedDate);
      if (isDryRun) qs.set("dry", "1");

      const r = await fetch(`/api/backup/restore?${qs.toString()}`, { 
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || "Operacioni dështoi");
      
      setResult(j);
      if (!isDryRun) setConfirm("");
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main style={{ padding: 20, maxWidth: 800, margin: "0 auto", fontFamily: "sans-serif" }}>
      <h1 style={{ borderBottom: "2px solid #eee", paddingBottom: 10 }}>RESTORE NGA BACKUP</h1>
      
      <div style={{ background: "#f9f9f9", padding: 15, borderRadius: 8, marginBottom: 20 }}>
        <label>PIN Sigurie:</label>
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="Shkruaj PIN-in"
          style={{ marginLeft: 10, padding: 8, borderRadius: 5, border: "1px solid #ccc" }}
        />
        <button onClick={loadDates} disabled={loadingDates} style={{ marginLeft: 10, cursor: "pointer" }}>
          Rifresko
        </button>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label>Zgjidh Datën e Backup-it:</label>
        <select 
          value={selectedDate} 
          onChange={(e) => setSelectedDate(e.target.value)}
          style={{ display: "block", width: "100%", padding: 10, marginTop: 5 }}
        >
          {dates.map((d) => (
            <option key={d.backup_date} value={d.backup_date}>
              {d.backup_date} ({d.clients_cnt} klientë)
            </option>
          ))}
        </select>
      </div>

      {selectedInfo && (
        <div style={{ fontSize: "0.9rem", color: "#666", marginBottom: 20 }}>
          ✅ Detajet: {selectedInfo.clients_cnt} Klientë, {selectedInfo.orders_cnt} Porosi.
        </div>
      )}

      <div style={{ border: "1px solid #ffcccc", padding: 15, borderRadius: 8 }}>
        <button onClick={() => handleRestore(true)} disabled={running} style={{ marginRight: 10 }}>
          PROVO (DRY RUN)
        </button>
        
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Shkruaj PO"
          style={{ padding: 8, width: 100 }}
        />
        <button 
          onClick={() => handleRestore(false)} 
          disabled={running || !selectedDate}
          style={{ background: "red", color: "white", padding: "8px 15px", border: "none", borderRadius: 5, marginLeft: 10 }}
        >
          {running ? "Duke u rikthyer..." : "RESTORE TANI"}
        </button>
      </div>

      {error && <p style={{ color: "red", fontWeight: "bold" }}>❌ {error}</p>}
      {result && (
        <pre style={{ background: "#eee", padding: 10, marginTop: 20 }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </main>
  );
}
