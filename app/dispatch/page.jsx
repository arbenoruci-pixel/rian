"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { listUsers } from "@/lib/usersDb";

function onlyDigits(v) {
  return String(v ?? "").replace(/\D/g, "");
}

export default function DispatchPage() {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [drivers, setDrivers] = useState([]);
  const [driverId, setDriverId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [reschedules, setReschedules] = useState([]);

  useEffect(() => {
    (async () => {
      const res = await listUsers();
      if (res?.ok) {
        const ds = (res.items || []).filter((u) => String(u.role || "").toUpperCase() === "TRANSPORT" && u.is_active !== false);
        setDrivers(ds);
        if (ds.length === 1) setDriverId(String(ds[0].id));
      }
    })();
  }, []);

  async function loadReschedules() {
    try {
      const { data, error } = await supabase
        .from("transport_orders")
        .select("*")
        .eq("status", "gati")
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) throw error;
      const nowMs = Date.now();
      const out = (data || []).filter((r) => {
        const ra = r?.data?.reschedule_at || r?.data?.rescheduleAt || r?.data?.riplanifikim_at;
        const ms = ra ? Date.parse(String(ra)) : NaN;
        return Number.isFinite(ms) && ms > nowMs;
      });
      setReschedules(out);
    } catch (e) {
      setReschedules([]);
    }
  }

  async function setDispatchReschedule(row) {
    if (!row?.id) return;
    const date = prompt("RIPLANIFIKIM — DATA (YYYY-MM-DD)", "");
    if (!date) return;
    const time = prompt("RIPLANIFIKIM — ORA (HH:MM)", "14:00");
    if (!time) return;

    const whenLocal = new Date(`${date}T${time}:00`);
    if (!Number.isFinite(whenLocal.getTime())) return alert("DATA/ORA jo valide.");

    const nextData = { ...(row.data || {}) };
    nextData.reschedule_at = whenLocal.toISOString();
    nextData.reschedule_by = "DISPATCH";

    const { error } = await supabase
      .from("transport_orders")
      .update({ data: nextData, updated_at: new Date().toISOString() })
      .eq("id", row.id);

    if (error) return alert("Gabim: " + error.message);
    loadReschedules();
  }

  useEffect(() => {
    loadReschedules();
    const t = setInterval(loadReschedules, 15000);
    return () => clearInterval(t);
  }, []);


  const canSend = useMemo(() => {
    return String(name).trim().length >= 2 && onlyDigits(phone).length >= 6 && String(driverId||'').trim().length > 0;
  }, [name, phone, driverId]);

  async function send() {
    if (!canSend) { setErr('ZGJIDH SHOFERIN'); return; }
    setBusy(true);
    setErr("");
    setMsg("");
    try {
      const payload = {
        status: "dispatched",
        transport_id: driverId,
        data: {
          client: { name: String(name).trim(), phone: onlyDigits(phone) },
          address: String(address).trim(),
          note: String(note).trim(),
          created_by: "DISPATCH",
        },
      };

      const { error } = await supabase.from("transport_orders").insert([payload]);
      if (error) throw error;

      setMsg("U DËRGUA ✅");
      setName("");
      setPhone("");
      setAddress("");
      setNote("");
    } catch (e) {
      setErr(e?.message || "GABIM");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={ui.page}>
      <div style={ui.top}>
        <div>
          <div style={ui.title}>DISPATCH</div>
          <div style={ui.sub}>DËRGO POROSI TE TRANSPORTI</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/transport/board" style={ui.btnGhost}>TEREN</Link>
          <Link href="/" style={ui.btnGhost}>HOME</Link>
        </div>
      </div>

      <div style={ui.card}>
        <div style={ui.row2}>
          <div style={ui.field}>
            <div style={ui.label}>EMRI</div>
            <input style={ui.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="EMRI I KLIENTIT" />
          </div>
          <div style={ui.field}>
            <div style={ui.label}>TEL</div>
            <input style={ui.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+383..." inputMode="tel" />
          </div>
        </div>

        <div style={ui.field}>
          <div style={ui.label}>ADRESA</div>
          <input style={ui.input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="RRUGA / LAGJJA" />
        </div>

        <div style={ui.field}>
          <div style={ui.label}>SHËNIM</div>
          <textarea style={ui.textarea} value={note} onChange={(e) => setNote(e.target.value)} placeholder="OPSIONALE" />
        </div>

        <div style={ui.field}>
          <div style={ui.label}>SHOFERI</div>
          <select style={ui.input} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">(PA SHOFER – TË GJITHË E SHOHIN INBOX)</option>
            {drivers.map((d) => (
              <option key={String(d.id)} value={String(d.id)}>
                {String(d.name || "TRANSPORT").toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        {err ? <div style={ui.err}>{err}</div> : null}
        {msg ? <div style={ui.ok}>{msg}</div> : null}

        <button style={{ ...ui.btnPrimary, opacity: canSend && !busy ? 1 : 0.5 }} disabled={!canSend || busy} onClick={send}>
          {busy ? "DUKE DËRGU…" : "DËRGO"}
        </button>

      <div style={ui.card}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>RIPLANIFIKIME</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>Porosi te GATI me orar ne te ardhmen (shoferi s'i sheh ne GATI deri sa t'u vije koha).</div>

        {(reschedules?.length || 0) === 0 ? (
          <div style={{ fontWeight: 800, opacity: 0.75 }}>S'ka riplanifikime.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {reschedules.map((r) => {
              const cname = r?.data?.client?.name || r?.client_name || "PA EMER";
              const cphone = onlyDigits(r?.data?.client?.phone || r?.client_phone || "");
              const ra = r?.data?.reschedule_at;
              return (
                <div key={String(r.id)} style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: 14, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ fontWeight: 900 }}>{String(cname).toUpperCase()}</div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>{cphone ? cphone : "PA TEL"} • ⏰ {ra ? new Date(ra).toLocaleString() : "-"}</div>
                  </div>
                  <button style={ui.btnGhost} onClick={() => setDispatchReschedule(r)}>NDËRRO ORARIN</button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      </div>
    </div>
  );
}

const ui = {
  page: { minHeight: "100vh", background: "#f5f5f7", color: "#111", padding: 16 },
  top: { maxWidth: 720, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  title: { fontSize: 18, fontWeight: 900 },
  sub: { fontSize: 12, opacity: 0.7 },
  card: { maxWidth: 720, margin: "14px auto 0", background: "#fff", borderRadius: 18, border: "1px solid rgba(0,0,0,0.08)", padding: 14, boxShadow: "0 10px 24px rgba(0,0,0,0.06)" },
  row2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: 900, opacity: 0.75 },
  input: { height: 44, borderRadius: 12, border: "1px solid rgba(0,0,0,0.12)", padding: "0 12px", fontWeight: 800, outline: "none" },
  textarea: { minHeight: 70, borderRadius: 12, border: "1px solid rgba(0,0,0,0.12)", padding: 12, fontWeight: 800, outline: "none" },
  btnGhost: { border: "1px solid rgba(0,0,0,0.12)", background: "rgba(255,255,255,0.85)", padding: "10px 12px", borderRadius: 12, fontWeight: 900, textDecoration: "none", color: "#111" },
  btnPrimary: { width: "100%", height: 48, borderRadius: 14, border: "none", background: "#111", color: "#fff", fontWeight: 900, cursor: "pointer" },
  err: { background: "#fff1f1", border: "1px solid rgba(255,0,0,0.2)", color: "#b00020", padding: 10, borderRadius: 12, fontWeight: 800, marginBottom: 10 },
  ok: { background: "#eefbf0", border: "1px solid rgba(0,160,80,0.25)", color: "#0b6a2b", padding: 10, borderRadius: 12, fontWeight: 900, marginBottom: 10 },
};
