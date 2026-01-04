"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

const euro = (n) =>
  `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

function parseEuroInput(v) {
  const s = String(v ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace(",", ".");
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

export default function CompanyBudgetPage() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [days, setDays] = useState([]);
  const [moves, setMoves] = useState([]);

  const [type, setType] = useState("OUT"); // IN | OUT
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  async function refresh() {
    setErr("");
    setBusy(true);
    try {
      // IN = cash received by DISPATCH (from arka_days)
      const d = await supabase
        .from("arka_days")
        .select("id,day_key,received_amount,received_at,received_by")
        .not("received_at", "is", null)
        .order("received_at", { ascending: false })
        .limit(365);

      if (d.error) throw d.error;
      setDays(d.data || []);

      // OUT/IN manual moves (company budget)
      const m = await supabase
        .from("arka_company_moves")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(300);

      if (m.error) throw m.error;
      setMoves(m.data || []);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const totals = useMemo(() => {
    const receivedIn = (days || []).reduce(
      (a, r) => a + Number(r.received_amount || 0),
      0
    );

    const inMoves = (moves || [])
      .filter((x) => String(x.type).toUpperCase() === "IN")
      .reduce((a, x) => a + Number(x.amount || 0), 0);

    const outMoves = (moves || [])
      .filter((x) => String(x.type).toUpperCase() === "OUT")
      .reduce((a, x) => a + Number(x.amount || 0), 0);

    const balance = receivedIn + inMoves - outMoves;

    return { receivedIn, inMoves, outMoves, balance };
  }, [days, moves]);

  async function addMove() {
    setErr("");
    const n = parseEuroInput(amount);
    if (!Number.isFinite(n) || n <= 0) {
      setErr("SHUMA E PAVLEFSHME");
      return;
    }

    setBusy(true);
    try {
      const ins = await supabase
        .from("arka_company_moves")
        .insert({
          type,
          amount: n,
          note: String(note || "").trim(),
          created_by: "UI",
        })
        .select("*")
        .single();

      if (ins.error) throw ins.error;

      setAmount("");
      setNote("");
      await refresh();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 2 }}>BUXHETI I KOMPANISË</div>
        <div style={{ marginLeft: "auto" }}>
          <Link
            href="/arka"
            style={{
              display: "inline-block",
              padding: "10px 14px",
              borderRadius: 14,
              background: "#111",
              border: "1px solid #333",
              color: "#fff",
              textDecoration: "none",
              fontWeight: 700,
              letterSpacing: 1,
            }}
          >
            KTHEHU
          </Link>
        </div>
      </div>

      {err ? (
        <div
          style={{
            border: "1px solid #ff3333",
            background: "rgba(255,0,0,0.08)",
            padding: 12,
            borderRadius: 12,
            marginBottom: 14,
            fontWeight: 700,
          }}
        >
          {err}
        </div>
      ) : null}

      <div
        style={{
          border: "1px solid #222",
          background: "#0b0b0b",
          borderRadius: 16,
          padding: 14,
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.75, letterSpacing: 2, fontWeight: 800 }}>
          GJENDJA
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginTop: 10,
          }}
        >
          <div style={{ border: "1px solid #222", borderRadius: 14, padding: 12, background: "#090909" }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>IN (DISPATCH)</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.receivedIn)}</div>
          </div>

          <div style={{ border: "1px solid #222", borderRadius: 14, padding: 12, background: "#090909" }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>OUT (TOTAL)</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.outMoves)}</div>
          </div>

          <div style={{ border: "1px solid #222", borderRadius: 14, padding: 12, background: "#090909" }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>IN (MANUAL)</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.inMoves)}</div>
          </div>

          <div style={{ border: "1px solid #2a2a2a", borderRadius: 14, padding: 12, background: "#0a0a0a" }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>BALANCI</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.balance)}</div>
          </div>
        </div>
      </div>

      <div
        style={{
          border: "1px solid #222",
          background: "#0b0b0b",
          borderRadius: 16,
          padding: 14,
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.75, letterSpacing: 2, fontWeight: 800 }}>
          SHTO LËVIZJE
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10, marginTop: 10 }}>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            style={{
              height: 48,
              borderRadius: 14,
              border: "1px solid #333",
              background: "#111",
              color: "#fff",
              fontWeight: 800,
              letterSpacing: 2,
              padding: "0 10px",
            }}
          >
            <option value="OUT">OUT</option>
            <option value="IN">IN</option>
          </select>

          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="€"
            style={{
              height: 48,
              borderRadius: 14,
              border: "1px solid #333",
              background: "#fff",
              color: "#000",
              fontWeight: 800,
              padding: "0 12px",
              fontSize: 18,
            }}
          />
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="SHËNIM (opsional)"
          style={{
            height: 48,
            borderRadius: 14,
            border: "1px solid #333",
            background: "#fff",
            color: "#000",
            fontWeight: 800,
            padding: "0 12px",
            fontSize: 15,
            marginTop: 10,
          }}
        />

        <button
          onClick={addMove}
          disabled={busy}
          style={{
            marginTop: 10,
            width: "100%",
            height: 52,
            borderRadius: 16,
            background: busy ? "#333" : "#e9e9e9",
            color: "#000",
            fontWeight: 900,
            letterSpacing: 3,
            border: "1px solid #333",
          }}
        >
          SHTO
        </button>
      </div>

      <div
        style={{
          border: "1px solid #222",
          background: "#0b0b0b",
          borderRadius: 16,
          padding: 14,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.75, letterSpacing: 2, fontWeight: 800 }}>
          HISTORIA (300)
        </div>

        <div style={{ marginTop: 10 }}>
          {(moves || []).length === 0 ? (
            <div style={{ opacity: 0.75, fontWeight: 700 }}>S’KA LËVIZJE.</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {moves.map((m) => (
                <div
                  key={m.id}
                  style={{
                    border: "1px solid #222",
                    borderRadius: 14,
                    padding: 10,
                    background: "#070707",
                    display: "grid",
                    gridTemplateColumns: "90px 1fr 140px",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <div style={{ fontWeight: 900, letterSpacing: 2 }}>
                    {String(m.type || "").toUpperCase()}
                  </div>
                  <div style={{ opacity: 0.85, fontWeight: 700 }}>
                    {m.note || ""}
                  </div>
                  <div style={{ textAlign: "right", fontWeight: 900 }}>
                    {euro(m.amount)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginTop: 16, opacity: 0.65, fontSize: 12, lineHeight: 1.4 }}>
          IN (DISPATCH) llogaritet nga dorëzimet e pranuara (RECEIVED) në CASH. OUT/IN manual ruhen te
          <span style={{ fontWeight: 800 }}> arka_company_moves</span>.
        </div>
      </div>
    </div>
  );
}
