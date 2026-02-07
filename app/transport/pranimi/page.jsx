"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { getTransportSession } from "@/lib/transportAuth";
import { reserveTransportCode, markTransportCodeUsed } from "@/lib/transportCodes";

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function parseAmount(v) {
  const s = String(v ?? "").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

async function safeSearchByCode(q) {
  const txt = String(q || "").trim();
  if (!txt) return [];

  // 1) try code_str exact (if exists)
  try {
    const { data, error } = await supabase
      .from("transport_clients")
      .select("id, name, phone, code, code_str")
      .eq("code_str", txt)
      .limit(10);
    if (!error && data?.length) return data;
  } catch {}

  // 2) try numeric code exact (if exists)
  const n = Number(onlyDigits(txt));
  if (Number.isFinite(n) && n > 0) {
    try {
      const { data, error } = await supabase
        .from("transport_clients")
        .select("id, name, phone, code, code_str")
        .eq("code", n)
        .limit(10);
      if (!error && data?.length) return data;
    } catch {}
  }

  return [];
}

async function searchClientsLive(q) {
  const query = String(q || "").trim();
  if (!query) return [];

  // First, try strict code lookup (best-effort)
  const byCode = await safeSearchByCode(query);
  if (byCode.length) return byCode;

  // Then, name/phone search
  const like = `%${query}%`;
  const { data, error } = await supabase
    .from("transport_clients")
    .select("id, name, phone, code, code_str")
    .or(`name.ilike.${like},phone.ilike.${like}`)
    .limit(15);

  if (error) return [];
  return data || [];
}

export default function TransportPranimiPage() {
  const router = useRouter();

  const [session, setSession] = useState(null);
  const [codeStr, setCodeStr] = useState("");

  const [clientId, setClientId] = useState(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  const [searchQ, setSearchQ] = useState("");
  const [searchItems, setSearchItems] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const [totalEur, setTotalEur] = useState("");
  const [paidEur, setPaidEur] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const debRef = useRef(null);

  useEffect(() => {
    const s = getTransportSession();
    setSession(s);

    // reserve code (Txx) from pool/online
    const reservedBy = s?.transport_id || "APP";
    reserveTransportCode(reservedBy)
      .then((c) => setCodeStr(String(c || "")))
      .catch((e) => setError(String(e?.message || e || "Gabim")));
  }, []);

  useEffect(() => {
    const q = String(searchQ || "").trim();
    if (!q) {
      setSearchItems([]);
      setSearchOpen(false);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    setSearchOpen(true);

    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(async () => {
      const items = await searchClientsLive(q);
      setSearchItems(items);
      setSearchLoading(false);
    }, 250);

    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
  }, [searchQ]);

  const debt = useMemo(() => {
    const t = parseAmount(totalEur);
    const p = parseAmount(paidEur);
    return Math.max(0, Number((t - p).toFixed(2)));
  }, [totalEur, paidEur]);

  function pickClient(c) {
    setClientId(c?.id || null);
    setName(String(c?.name || ""));
    setPhone(String(c?.phone || ""));
    setSearchOpen(false);
  }

  async function ensureClient() {
    const nm = String(name || "").trim();
    const ph = String(phone || "").trim();
    if (!ph) throw new Error("TELEFONI ËSHTË I DETYRUESHËM");

    // If selected existing
    if (clientId) return clientId;

    // Create/Upsert by phone (best effort)
    // NOTE: column names may vary; keep minimal and tolerant
    try {
      const { data, error } = await supabase
        .from("transport_clients")
        .insert({ name: nm || "KLIENT", phone: ph })
        .select("id")
        .single();
      if (error) throw error;
      return data?.id;
    } catch (e) {
      // Fallback: try find by phone
      const { data } = await supabase
        .from("transport_clients")
        .select("id")
        .eq("phone", ph)
        .limit(1);
      if (data?.[0]?.id) return data[0].id;
      throw e;
    }
  }

  async function onSave() {
    setError("");
    if (!session?.transport_id) {
      setError("S'JE LOGUAR SI TRANSPORT");
      return;
    }
    if (!codeStr) {
      setError("S'KA KOD (REFRESH / RRJET)");
      return;
    }

    setSaving(true);
    try {
      const cid = await ensureClient();

      const payload = {
        code_str: codeStr,
        code_n: Number(onlyDigits(codeStr)) || null,
        client_id: cid,
        client_name: String(name || "").trim() || "KLIENT",
        client_phone: String(phone || "").trim(),
        status: "transport", // porosia është te kamioni
        transport_id: String(session.transport_id),
        data: {
          total: parseAmount(totalEur),
          paid: parseAmount(paidEur),
          debt,
        },
      };

      const { error } = await supabase.from("transport_orders").insert(payload);
      if (error) throw error;

      // Mark code used (best-effort)
      await markTransportCodeUsed(codeStr, String(session.transport_id));

      // Go to pickup list
      router.push("/transport/pickup");
    } catch (e) {
      setError(String(e?.message || e || "Gabim"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page" style={{ paddingBottom: 32 }}>
      <div className="topbar">
        <div>
          <div className="title">PRANIMI (TRANSPORT)</div>
          <div className="sub">KRIJO POROSI T (KOD REAL)</div>
        </div>
        <Link className="btn" href="/transport/menu">MENU</Link>
      </div>

      <div className="panel">
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
          <div className="label">KODI</div>
          <div className="badge" style={{ background: "#10b981" }}>{codeStr || "..."}</div>
        </div>

        <div style={{ height: 12 }} />

        <div className="label">🔎 KËRKO KLIENTIN (KOD / EMËR / TELEFON)</div>
        <div style={{ position: "relative" }}>
          <input
            className="input"
            style={{ background: "#0f172a", borderColor: "#334155" }}
            placeholder="p.sh. 12 / arben / 045..."
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onFocus={() => setSearchOpen(true)}
          />

          {searchOpen && (searchLoading || searchItems.length > 0) && (
            <div className="dropdown" style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 6, zIndex: 50 }}>
              {searchLoading && <div className="ddItem">DUKE KËRKUAR...</div>}
              {!searchLoading && searchItems.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="ddItem"
                  onClick={() => pickClient(c)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ textAlign: "left" }}>
                      <div style={{ fontWeight: 800 }}>{String(c?.name || "KLIENT")}</div>
                      <div style={{ opacity: 0.75, fontSize: 12 }}>{String(c?.phone || "")}</div>
                    </div>
                    <div style={{ fontWeight: 900, opacity: 0.8 }}>{String(c?.code_str || c?.code || "")}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ height: 14 }} />

        <div className="grid2">
          <div>
            <div className="label">EMRI (MJAFTON EMRI)</div>
            <input
              className="input"
              style={{ background: "#0b1220", borderColor: "#334155" }}
              placeholder="Emri"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <div className="label">TELEFONI (I DETYRUESHËM)</div>
            <input
              className="input"
              style={{ background: "#0b1220", borderColor: "#334155" }}
              placeholder="+383 44..."
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
        </div>

        <div style={{ height: 14 }} />

        <div className="grid2">
          <div>
            <div className="label">SHUMA (€)</div>
            <input className="input" style={{ background: "#0b1220", borderColor: "#334155" }} value={totalEur} onChange={(e) => setTotalEur(e.target.value)} />
          </div>
          <div>
            <div className="label">KLIENTI DHA (€)</div>
            <input className="input" style={{ background: "#0b1220", borderColor: "#334155" }} value={paidEur} onChange={(e) => setPaidEur(e.target.value)} />
          </div>
        </div>

        <div style={{ height: 10 }} />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="label">BORXHI</div>
          <div className="badge" style={{ background: debt > 0 ? "#ef4444" : "#334155" }}>€{debt.toFixed(2)}</div>
        </div>

        {error && (
          <div className="err">{error}</div>
        )}

        <div style={{ height: 14 }} />

        <button
          type="button"
          className="btnPrimary"
          style={{ touchAction: "manipulation" }}
          onClick={onSave}
          disabled={saving}
        >
          {saving ? "DUKE RUAJTUR..." : "RUAJ POROSIN"}
        </button>

        <div style={{ height: 10 }} />

        <Link className="btnGhost" href="/transport/te-pa-plotsuara">
          TË PA PLOTSUARAT
        </Link>
      </div>

      <style jsx>{`
        .page{min-height:100vh;background:#050914;color:#e5e7eb;padding:18px 14px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;}
        .topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;max-width:720px;margin:0 auto 14px;}
        .title{font-size:26px;font-weight:900;letter-spacing:1px;}
        .sub{font-size:12px;opacity:.65;margin-top:2px;}
        .panel{max-width:720px;margin:0 auto;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);}
        .row{display:flex;align-items:center;gap:10px;}
        .label{font-size:12px;font-weight:800;letter-spacing:.8px;opacity:.85;text-transform:uppercase;}
        .badge{padding:8px 12px;border-radius:999px;font-weight:900;}
        .input{width:100%;padding:12px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);outline:none;color:#e5e7eb;}
        .input:focus{border-color:rgba(59,130,246,.8);box-shadow:0 0 0 3px rgba(59,130,246,.15);}
        .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
        @media(max-width:520px){.grid2{grid-template-columns:1fr;}}
        .btn{padding:10px 12px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);font-weight:800;text-transform:uppercase;font-size:12px;}
        .btnPrimary{width:100%;padding:13px 14px;border-radius:14px;background:linear-gradient(135deg,#2563eb,#4f46e5);border:none;color:white;font-weight:900;letter-spacing:.8px;text-transform:uppercase;}
        .btnPrimary:disabled{opacity:.6;}
        .btnGhost{display:block;text-align:center;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.16);font-weight:900;letter-spacing:.8px;text-transform:uppercase;}
        .err{margin-top:10px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);padding:10px 12px;border-radius:14px;font-weight:700;}
        .dropdown{background:#070b18;border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.45);}
        .ddItem{width:100%;text-align:left;padding:10px 12px;background:transparent;border:none;color:#e5e7eb;cursor:pointer;}
        .ddItem:hover{background:rgba(255,255,255,.06);}
      `}</style>
    </div>
  );
}
