"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { listUsers } from "@/lib/usersDb";

function onlyDigits(v) {
  return String(v ?? "").replace(/\D/g, "");
}
function s(v) {
  return String(v ?? "").trim();
}
function up(v) {
  return s(v).toUpperCase();
}
function isTodayLike(v) {
  try {
    const d = new Date(v);
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  } catch {
    return false;
  }
}
function niceDate(v) {
  try {
    if (!v) return "-";
    return new Date(v).toLocaleString();
  } catch {
    return "-";
  }
}
function getClientName(row) {
  return s(row?.client_name || row?.data?.client?.name || row?.data?.client_name || row?.data?.name || row?.name);
}
function getClientPhone(row) {
  return onlyDigits(
    row?.client_phone || row?.data?.client?.phone || row?.data?.client_phone || row?.data?.phone || row?.phone || ""
  );
}
function getAddress(row) {
  return s(
    row?.address ||
      row?.pickup_address ||
      row?.delivery_address ||
      row?.data?.address ||
      row?.data?.pickup_address ||
      row?.data?.delivery_address ||
      row?.data?.client?.address ||
      row?.data?.location ||
      ""
  );
}
function getOrderCode(row) {
  return s(row?.client_tcode || row?.code || row?.code_str || row?.data?.code || row?.data?.client_tcode || row?.id);
}
function normalizeStatus(v) {
  const x = s(v).toLowerCase();
  if (["pickup", "pranim", "new", "inbox", "dispatched"].includes(x)) return "PICKUP";
  if (["delivery", "dorzim", "dorëzim", "dorezim", "dorezuar", "dorëzuar", "dorzuar", "marrje"].includes(x)) return "DORZIM";
  if (["failed", "deshtuar", "dështuar", "parealizuar", "no_show", "noshow", "returned", "kthim"].includes(x)) return "DËSHTUAR";
  if (x === "loaded" || x === "ngarkim" || x === "ngarkuar") return "NGARKIM";
  if (x === "gati") return "GATI";
  return up(v || "-");
}
function isFailedRow(row) {
  const st = normalizeStatus(row?.status || row?.data?.status || "");
  if (st === "DËSHTUAR") return true;
  const failFlag = row?.data?.failed || row?.data?.unsuccessful || row?.data?.not_done || row?.data?.rejected_delivery;
  return !!failFlag;
}
function isLiveBoardRow(row) {
  if (!row) return false;
  const st = normalizeStatus(row?.status || row?.data?.status || "");
  if (st !== "PICKUP" && st !== "DORZIM") return false;
  return isTodayLike(row?.updated_at || row?.created_at || row?.data?.assigned_at || row?.data?.created_at);
}
function sourceLabel(row) {
  return row?._table === "orders" ? "BAZË" : "TRANSPORT";
}
function mergeById(rows) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const key = `${row?._table || "x"}:${row?.id || Math.random()}`;
    const prev = map.get(key);
    const prevTs = Date.parse(prev?.updated_at || prev?.created_at || 0) || 0;
    const nextTs = Date.parse(row?.updated_at || row?.created_at || 0) || 0;
    if (!prev || nextTs >= prevTs) map.set(key, row);
  });
  return Array.from(map.values());
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

  const [crmQuery, setCrmQuery] = useState("");
  const [crmBusy, setCrmBusy] = useState(false);
  const [crmOpen, setCrmOpen] = useState(false);
  const [crmHits, setCrmHits] = useState([]);

  const [liveRows, setLiveRows] = useState([]);
  const [failedRows, setFailedRows] = useState([]);
  const [reassigning, setReassigning] = useState("");
  const [reassignMap, setReassignMap] = useState({});

  const searchTimer = useRef(null);

  useEffect(() => {
    (async () => {
      const res = await listUsers();
      if (res?.ok) {
        // KËTU ËSHTË BASHKIMI: Merr TRANSPORT dhe HYBRID
        const ds = (res.items || []).filter((u) => {
          const roleOk = String(u.role || "").toUpperCase() === "TRANSPORT";
          const hybridOk = u?.is_hybrid_transport === true;
          const activeOk = u?.is_active !== false;
          return activeOk && (roleOk || hybridOk);
        });
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
    } catch {
      setReschedules([]);
    }
  }

  async function loadBoards() {
    try {
      const [baseRes, transRes] = await Promise.all([
        supabase.from("orders").select("*").order("updated_at", { ascending: false }).limit(200),
        supabase.from("transport_orders").select("*").order("updated_at", { ascending: false }).limit(300),
      ]);
      const base = Array.isArray(baseRes?.data) ? baseRes.data.map((r) => ({ ...r, _table: "orders" })) : [];
      const trans = Array.isArray(transRes?.data) ? transRes.data.map((r) => ({ ...r, _table: "transport_orders" })) : [];
      const merged = mergeById([...trans, ...base]);
      setLiveRows(
        merged
          .filter(isLiveBoardRow)
          .sort((a, b) => (Date.parse(b?.updated_at || b?.created_at || 0) || 0) - (Date.parse(a?.updated_at || a?.created_at || 0) || 0))
          .slice(0, 40)
      );
      setFailedRows(
        merged
          .filter(isFailedRow)
          .sort((a, b) => (Date.parse(b?.updated_at || b?.created_at || 0) || 0) - (Date.parse(a?.updated_at || a?.created_at || 0) || 0))
          .slice(0, 40)
      );
    } catch {
      setLiveRows([]);
      setFailedRows([]);
    }
  }

  useEffect(() => {
    loadReschedules();
    loadBoards();

    let ch1 = null;
    let ch2 = null;
    try {
      ch1 = supabase
        .channel("dispatch-live-orders")
        .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
          loadBoards();
        })
        .subscribe();
      ch2 = supabase
        .channel("dispatch-live-transport-orders")
        .on("postgres_changes", { event: "*", schema: "public", table: "transport_orders" }, () => {
          loadBoards();
          loadReschedules();
        })
        .subscribe();
    } catch {}

    const t = setInterval(() => {
      loadReschedules();
      loadBoards();
    }, 15000);

    return () => {
      clearInterval(t);
      try { if (ch1) supabase.removeChannel(ch1); } catch {}
      try { if (ch2) supabase.removeChannel(ch2); } catch {}
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  useEffect(() => {
    const q = s(crmQuery);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.length < 2) {
      setCrmHits([]);
      setCrmOpen(false);
      return;
    }
    searchTimer.current = setTimeout(() => {
      runSmartSearch(q);
    }, 220);
  }, [crmQuery]);

  async function runSmartSearch(q) {
    setCrmBusy(true);
    try {
      const [baseRes, transRes] = await Promise.all([
        supabase.from("orders").select("*").order("updated_at", { ascending: false }).limit(180),
        supabase.from("transport_orders").select("*").order("updated_at", { ascending: false }).limit(180),
      ]);
      const rows = mergeById([
        ...((baseRes?.data || []).map((r) => ({ ...r, _table: "orders" }))),
        ...((transRes?.data || []).map((r) => ({ ...r, _table: "transport_orders" }))),
      ]);
      const needle = q.toLowerCase();
      const digits = onlyDigits(q);
      const hits = rows.filter((row) => {
        const hay = [getClientName(row), getClientPhone(row), getAddress(row), getOrderCode(row)].join(" ").toLowerCase();
        if (hay.includes(needle)) return true;
        if (digits && getClientPhone(row).includes(digits)) return true;
        return false;
      });
      const dedup = [];
      const seen = new Set();
      for (const row of hits) {
        const key = `${getClientName(row)}|${getClientPhone(row)}|${getAddress(row)}`.toLowerCase();
        if (!getClientName(row) && !getClientPhone(row)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(row);
        if (dedup.length >= 8) break;
      }
      setCrmHits(dedup);
      setCrmOpen(dedup.length > 0);
    } catch {
      setCrmHits([]);
      setCrmOpen(false);
    } finally {
      setCrmBusy(false);
    }
  }

  function applySuggestion(row) {
    setName(getClientName(row));
    setPhone(getClientPhone(row));
    setAddress(getAddress(row));
    setCrmQuery(getClientName(row) || getClientPhone(row));
    setCrmOpen(false);
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

  const canSend = useMemo(() => {
    return String(name).trim().length >= 2 && onlyDigits(phone).length >= 6 && String(driverId || "").trim().length > 0;
  }, [name, phone, driverId]);

  async function send() {
    if (!canSend) {
      setErr("ZGJIDH SHOFERIN");
      return;
    }
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
      setCrmQuery("");
      loadBoards();
    } catch (e) {
      setErr(e?.message || "GABIM");
    } finally {
      setBusy(false);
    }
  }

  async function reassignOrder(row) {
    if (!row?.id) return;
    const nextDriver = String(reassignMap[row.id] || "").trim();
    if (!nextDriver) return alert("ZGJIDH SHOFERIN.");
    setReassigning(String(row.id));
    try {
      const nextData = {
        ...(row.data || {}),
        reassigned_by: "DISPATCH",
        reassigned_at: new Date().toISOString(),
        failed_note: row?.data?.failed_note || row?.data?.reason || row?.data?.unsuccess_reason || null,
      };
      const { error } = await supabase
        .from(row._table === "orders" ? "orders" : "transport_orders")
        .update({
          transport_id: nextDriver,
          status: "dispatched",
          updated_at: new Date().toISOString(),
          data: nextData,
        })
        .eq("id", row.id);
      if (error) throw error;
      setReassignMap((prev) => ({ ...prev, [row.id]: "" }));
      loadBoards();
    } catch (e) {
      alert(e?.message || "Gabim gjatë ri-caktimit.");
    } finally {
      setReassigning("");
    }
  }

  return (
    <div style={ui.page}>
      <div style={ui.top}>
        <div>
          <div style={ui.title}>DISPATCH</div>
          <div style={ui.sub}>SMART DISPATCH CENTER</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/transport/board" style={ui.btnGhost}>TEREN</Link>
          <Link href="/" style={ui.btnGhost}>HOME</Link>
        </div>
      </div>

      <div style={ui.card}>
        <div style={ui.sectionTitle}>SMART SEARCH (CRM)</div>
        <div style={{ ...ui.field, marginBottom: 14, position: "relative" }}>
          <div style={ui.label}>KËRKO KLIENT TË VJETËR</div>
          <input
            style={ui.input}
            value={crmQuery}
            onChange={(e) => {
              setCrmQuery(e.target.value);
              setCrmOpen(true);
            }}
            placeholder="EMRI OSE TELI"
          />
          {crmBusy ? <div style={ui.mini}>DUKE KËRKUAR…</div> : null}
          {crmOpen && crmHits.length > 0 ? (
            <div style={ui.suggestBox}>
              {crmHits.map((row) => (
                <button key={`${row._table}_${row.id}`} type="button" style={ui.suggestItem} onClick={() => applySuggestion(row)}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontWeight: 900 }}>{up(getClientName(row) || "PA EMËR")}</div>
                    <div style={ui.badge}>{sourceLabel(row)}</div>
                  </div>
                  <div style={ui.suggestSub}>{getClientPhone(row) || "PA TEL"}</div>
                  <div style={ui.suggestSub}>{getAddress(row) || "PA ADRESË"}</div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

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
      </div>

      <div style={ui.card}>
        <div style={ui.sectionHeadRow}>
          <div style={ui.sectionTitle}>LIVE ACTIVITY</div>
          <button type="button" style={ui.btnGhostMini} onClick={loadBoards}>REFRESH</button>
        </div>
        <div style={ui.sectionHint}>Porositë e sotme me status PICKUP dhe DORZIM. Ndryshojnë live pa refresh kur vjen update nga terreni.</div>
        {(liveRows?.length || 0) === 0 ? (
          <div style={ui.empty}>S'KA AKTIVITET SOT.</div>
        ) : (
          <div style={ui.list}>
            {liveRows.map((row) => (
              <div key={`${row._table}_${row.id}`} style={ui.listItem}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={ui.itemTop}>
                    <span style={ui.itemTitle}>{up(getClientName(row) || "PA EMËR")}</span>
                    <span style={ui.badge}>{sourceLabel(row)}</span>
                    <span style={normalizeStatus(row.status) === "DORZIM" ? ui.badgeWarn : ui.badgeOk}>{normalizeStatus(row.status)}</span>
                  </div>
                  <div style={ui.itemSub}>{getClientPhone(row) || "PA TEL"} • {getAddress(row) || "PA ADRESË"}</div>
                </div>
                <div style={ui.timeCol}>{niceDate(row.updated_at || row.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={ui.card}>
        <div style={ui.sectionTitle}>POROSITË E DËSHTUARA</div>
        <div style={ui.sectionHint}>Dispatch mund t'i ri-caktojë menjëherë te një shofer tjetër.</div>
        {(failedRows?.length || 0) === 0 ? (
          <div style={ui.empty}>S'KA POROSI TË DËSHTUARA.</div>
        ) : (
          <div style={ui.list}>
            {failedRows.map((row) => (
              <div key={`${row._table}_${row.id}`} style={ui.failedItem}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={ui.itemTop}>
                    <span style={ui.itemTitle}>{up(getClientName(row) || "PA EMËR")}</span>
                    <span style={ui.badge}>{sourceLabel(row)}</span>
                    <span style={ui.badgeBad}>DËSHTUAR</span>
                  </div>
                  <div style={ui.itemSub}>{getClientPhone(row) || "PA TEL"} • {getAddress(row) || "PA ADRESË"}</div>
                  <div style={ui.itemSub}>ARSYE: {up(row?.data?.failed_note || row?.data?.reason || row?.data?.unsuccess_reason || "PA SHËNIM")}</div>
                </div>
                <div style={ui.reassignBox}>
                  <select
                    style={ui.inputMini}
                    value={reassignMap[row.id] || ""}
                    onChange={(e) => setReassignMap((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  >
                    <option value="">ZGJIDH SHOFERIN</option>
                    {drivers.map((d) => (
                      <option key={String(d.id)} value={String(d.id)}>{up(d.name || "TRANSPORT")}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    style={{ ...ui.btnGhostMini, minWidth: 108 }}
                    onClick={() => reassignOrder(row)}
                    disabled={reassigning === String(row.id)}
                  >
                    {reassigning === String(row.id) ? "DUKE…" : "RE-ASSIGN"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
  );
}

const ui = {
  page: { minHeight: "100vh", background: "#f5f5f7", color: "#111", padding: 16 },
  top: { maxWidth: 860, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  title: { fontSize: 18, fontWeight: 900 },
  sub: { fontSize: 12, opacity: 0.7 },
  card: { maxWidth: 860, margin: "14px auto 0", background: "#fff", borderRadius: 18, border: "1px solid rgba(0,0,0,0.08)", padding: 14, boxShadow: "0 10px 24px rgba(0,0,0,0.06)" },
  row2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 },
  label: { fontSize: 12, fontWeight: 900, opacity: 0.75 },
  input: { height: 44, borderRadius: 12, border: "1px solid rgba(0,0,0,0.12)", padding: "0 12px", fontWeight: 800, outline: "none", width: "100%" },
  inputMini: { height: 40, borderRadius: 12, border: "1px solid rgba(0,0,0,0.12)", padding: "0 10px", fontWeight: 800, outline: "none", minWidth: 180 },
  textarea: { minHeight: 70, borderRadius: 12, border: "1px solid rgba(0,0,0,0.12)", padding: 12, fontWeight: 800, outline: "none" },
  btnGhost: { border: "1px solid rgba(0,0,0,0.12)", background: "rgba(255,255,255,0.85)", padding: "10px 12px", borderRadius: 12, fontWeight: 900, textDecoration: "none", color: "#111" },
  btnGhostMini: { border: "1px solid rgba(0,0,0,0.12)", background: "rgba(255,255,255,0.85)", padding: "8px 10px", borderRadius: 10, fontWeight: 900, color: "#111", cursor: "pointer" },
  btnPrimary: { width: "100%", height: 48, borderRadius: 14, border: "none", background: "#111", color: "#fff", fontWeight: 900, cursor: "pointer" },
  err: { background: "#fff1f1", border: "1px solid rgba(255,0,0,0.2)", color: "#b00020", padding: 10, borderRadius: 12, fontWeight: 800, marginBottom: 10 },
  ok: { background: "#eefbf0", border: "1px solid rgba(0,160,80,0.25)", color: "#0b6a2b", padding: 10, borderRadius: 12, fontWeight: 900, marginBottom: 10 },
  mini: { fontSize: 11, fontWeight: 800, opacity: 0.65, marginTop: 6 },
  suggestBox: { position: "absolute", left: 0, right: 0, top: 78, background: "#fff", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 14, boxShadow: "0 14px 28px rgba(0,0,0,0.08)", zIndex: 20, overflow: "hidden" },
  suggestItem: { width: "100%", textAlign: "left", background: "#fff", border: "none", borderBottom: "1px solid rgba(0,0,0,0.06)", padding: 12, cursor: "pointer" },
  suggestSub: { fontSize: 12, opacity: 0.72, marginTop: 3 },
  badge: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(0,0,0,0.12)", background: "rgba(0,0,0,0.04)" },
  badgeOk: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(0,160,80,0.2)", background: "rgba(16,185,129,0.12)", color: "#0b6a2b" },
  badgeWarn: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(245,158,11,0.25)", background: "rgba(245,158,11,0.12)", color: "#8a5a00" },
  badgeBad: { fontSize: 11, fontWeight: 900, borderRadius: 999, padding: "4px 8px", border: "1px solid rgba(239,68,68,0.25)", background: "rgba(239,68,68,0.12)", color: "#b00020" },
  sectionTitle: { fontWeight: 900, marginBottom: 8 },
  sectionHint: { fontSize: 12, opacity: 0.7, marginBottom: 10 },
  sectionHeadRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 },
  empty: { fontWeight: 800, opacity: 0.75 },
  list: { display: "flex", flexDirection: "column", gap: 10 },
  listItem: { border: "1px solid rgba(0,0,0,0.08)", borderRadius: 14, padding: 12, display: "flex", alignItems: "center", gap: 12 },
  failedItem: { border: "1px solid rgba(239,68,68,0.18)", background: "rgba(255,0,0,0.02)", borderRadius: 14, padding: 12, display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" },
  itemTop: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  itemTitle: { fontWeight: 900 },
  itemSub: { fontSize: 12, opacity: 0.72, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  timeCol: { fontSize: 12, opacity: 0.7, fontWeight: 800, whiteSpace: "nowrap" },
  reassignBox: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },
};
