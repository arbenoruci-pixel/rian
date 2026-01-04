"use client";

<<<<<<<+main
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const euro = (n) => `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })}`;
=====
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

const euro = (n) =>
  `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;
>>>>>>> origin/main

function parseEuroInput(v) {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

<<<<<<< main
async function safeOrder(baseQuery, limit = 300) {
  let r = await baseQuery.order('at', { ascending: false }).limit(limit);
  if (r.error) r = await baseQuery.order('created_at', { ascending: false }).limit(limit);
=======
// provon me radhë: at -> created_at -> pa order
async function safeOrder(baseQuery, limit = 300) {
  let r = await baseQuery.order("at", { ascending: false }).limit(limit);
  if (r.error) r = await baseQuery.order("created_at", { ascending: false }).limit(limit);
>>>>>>> origin/main
  if (r.error) r = await baseQuery.limit(limit);
  if (r.error) throw r.error;
  return r.data || [];
}

export default function CompanyBudgetPage() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [days, setDays] = useState([]);
  const [moves, setMoves] = useState([]);
<<<<<<< main
  const [budgetExpenses, setBudgetExpenses] = useState([]);
=======
  const [budgetExpenses, setBudgetExpenses] = useState([]); // arka_expenses where paid_from=COMPANY_BUDGET
>>>>>>> origin/main

  const [type, setType] = useState('OUT'); // IN | OUT
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  async function refresh() {
    setErr('');
    setBusy(true);
    try {
<<<<<<< main
      // 1) IN from DISPATCH (received cycles): stored on arka_days
=======
      // IN (DISPATCH) nga arka_days received
>>>>>>> origin/main
      const d = await supabase
        .from('arka_days')
        .select('id,day_key,received_amount,received_at,received_by')
        .not('received_at', 'is', null)
        .order('received_at', { ascending: false })
        .limit(365);
      if (d.error) throw d.error;
      setDays(d.data || []);

<<<<<<< main
      // 2) Manual moves in company budget
      const m = await safeOrder(supabase.from('arka_company_moves').select('*'), 400);
      setMoves(m);

      // 3) Budget expenses (should already create OUT moves now, but we still count them for visibility)
      // NOTE: once your DB creates moves for each expense (external_id), you may choose to not count these here.
      const e = await safeOrder(
        supabase
          .from('arka_expenses')
          .select('id,amount,paid_from,day_key,created_at')
          .in('paid_from', ['COMPANY_BUDGET', 'BUXHET', 'BUDGET']),
        800
      );
      setBudgetExpenses(e);
=======
      // Moves manual (arka_company_moves) — mos u thy nese s’ka kolonë "at"
      const mData = await safeOrder(supabase.from("arka_company_moves").select("*"), 300);
      setMoves(mData);

      // Shpenzime qe jane pagu prej BUXHETIT (arka_expenses)
      const eData = await safeOrder(
        supabase
          .from("arka_expenses")
          .select("id,amount,paid_from,day_key,created_at,at")
          .eq("paid_from", "COMPANY_BUDGET"),
        500
      );
      setBudgetExpenses(eData);
>>>>>>> origin/main
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
    const receivedIn = (days || []).reduce((a, r) => a + Number(r.received_amount || 0), 0);

    const inMoves = (moves || [])
      .filter((x) => String(x.type).toUpperCase() === 'IN')
      .reduce((a, x) => a + Number(x.amount || 0), 0);

    const outMoves = (moves || [])
      .filter((x) => String(x.type).toUpperCase() === 'OUT')
      .reduce((a, x) => a + Number(x.amount || 0), 0);

<<<<<<< main
    // If your system creates OUT moves automatically for each budget expense,
    // counting expenses here would double-subtract.
    // So we show them as a separate stat only, and we do NOT subtract them from balance.
    const outExpenses = (budgetExpenses || []).reduce((a, x) => a + Number(x.amount || 0), 0);

    const balance = receivedIn + inMoves - outMoves;

    return { receivedIn, inMoves, outMoves, outExpenses, balance };
=======
    // OUT nga shpenzimet qe jane pagu prej buxhetit (sepse disa s’krijojne move)
    const outBudgetExpenses = (budgetExpenses || []).reduce(
      (a, x) => a + Number(x.amount || 0),
      0
    );

    const balance = receivedIn + inMoves - outMoves - outBudgetExpenses;

    return { receivedIn, inMoves, outMoves, outBudgetExpenses, balance };
>>>>>>> origin/main
  }, [days, moves, budgetExpenses]);

  async function addMove() {
    setErr('');
    const n = parseEuroInput(amount);
<<<<<<< main
    if (!Number.isFinite(n) || n <= 0) {
      setErr('SHUMA E PAVLEFSHME');
      return;
    }
=======
    if (!Number.isFinite(n) || n <= 0) return setErr("SHUMA E PAVLEFSHME");
>>>>>>> origin/main

    setBusy(true);
    try {
      const ins = await supabase
        .from('arka_company_moves')
        .insert({
          type,
          amount: n,
          note: String(note || '').trim(),
          created_by: 'UI',
        })
        .select('*')
        .single();
      if (ins.error) throw ins.error;

      setAmount('');
      setNote('');
      await refresh();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
<<<<<<< main
    <div style={{ maxWidth: 860, margin: '0 auto', padding: 16, overflowX: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            fontSize: 'clamp(20px, 6vw, 28px)',
            fontWeight: 800,
            letterSpacing: 2,
            lineHeight: 1.1,
            flex: '1 1 auto',
            minWidth: 0,
            wordBreak: 'break-word',
          }}
        >
=======
    <div style={{ maxWidth: 860, margin: "0 auto", padding: 16, overflowX: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ fontSize: "clamp(20px, 6vw, 28px)", fontWeight: 800, letterSpacing: 2, lineHeight: 1.1, flex: "1 1 auto", minWidth: 0, wordBreak: "break-word" }}>
>>>>>>> origin/main
          BUXHETI I KOMPANISË
        </div>
        <div style={{ marginLeft: 'auto', flex: '0 0 auto' }}>
          <Link
            href="/arka"
            style={{
              display: 'inline-block',
              padding: '10px 14px',
              borderRadius: 14,
              background: '#111',
              border: '1px solid #333',
              color: '#fff',
              textDecoration: 'none',
              fontWeight: 700,
              letterSpacing: 1,
            }}
          >
            KTHEHU
          </Link>
        </div>
      </div>

      {err ? (
<<<<<<< main
        <div
          style={{
            border: '1px solid #ff3333',
            background: 'rgba(255,0,0,0.08)',
            padding: 12,
            borderRadius: 12,
            marginBottom: 14,
            fontWeight: 700,
          }}
        >
=======
        <div style={{ border: "1px solid #ff3333", background: "rgba(255,0,0,0.08)", padding: 12, borderRadius: 12, marginBottom: 14, fontWeight: 700 }}>
>>>>>>> origin/main
          {err}
        </div>
      ) : null}

      <div
        style={{
          border: '1px solid #222',
          background: '#0b0b0b',
          borderRadius: 16,
          padding: 14,
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.75, letterSpacing: 2, fontWeight: 800 }}>GJENDJA</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <div style={{ border: '1px solid #222', borderRadius: 14, padding: 12, background: '#090909' }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>IN (DISPATCH)</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.receivedIn)}</div>
          </div>

          <div style={{ border: '1px solid #222', borderRadius: 14, padding: 12, background: '#090909' }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>OUT (MOVES)</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.outMoves)}</div>
          </div>

          <div style={{ border: '1px solid #222', borderRadius: 14, padding: 12, background: '#090909' }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>IN (MANUAL)</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.inMoves)}</div>
          </div>

<<<<<<< main
          <div style={{ border: '1px solid #2a2a2a', borderRadius: 14, padding: 12, background: '#0a0a0a' }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>OUT (SHPENZIME • BUXHET)</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.outExpenses)}</div>
=======
          <div style={{ border: "1px solid #2a2a2a", borderRadius: 14, padding: 12, background: "#0a0a0a" }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>OUT (SHPENZIME • BUXHET)</div>
            <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>{euro(totals.outBudgetExpenses)}</div>
>>>>>>> origin/main
          </div>

          <div style={{ gridColumn: '1 / -1', border: '1px solid #2a2a2a', borderRadius: 14, padding: 12, background: '#0a0a0a' }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, fontWeight: 800 }}>BALANCI</div>
            <div style={{ fontSize: 24, fontWeight: 900, marginTop: 6 }}>{euro(totals.balance)}</div>
          </div>
        </div>
      </div>

      <div style={{ border: '1px solid #222', background: '#0b0b0b', borderRadius: 16, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 12, opacity: 0.75, letterSpacing: 2, fontWeight: 800 }}>SHTO LËVIZJE</div>

        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, marginTop: 10 }}>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
<<<<<<< main
            style={{
              height: 48,
              borderRadius: 14,
              border: '1px solid #333',
              background: '#111',
              color: '#fff',
              fontWeight: 800,
              letterSpacing: 2,
              padding: '0 10px',
            }}
=======
            style={{ height: 48, borderRadius: 14, border: "1px solid #333", background: "#111", color: "#fff", fontWeight: 800, letterSpacing: 2, padding: "0 10px" }}
>>>>>>> origin/main
          >
            <option value="OUT">OUT</option>
            <option value="IN">IN</option>
          </select>

          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="€"
<<<<<<< main
            style={{
              height: 48,
              width: '100%',
              maxWidth: '100%',
              minWidth: 0,
              boxSizing: 'border-box',
              borderRadius: 14,
              border: '1px solid #333',
              background: '#fff',
              color: '#000',
              fontWeight: 800,
              padding: '0 12px',
              fontSize: 18,
            }}
=======
            style={{ height: 48, width: "100%", maxWidth: "100%", minWidth: 0, boxSizing: "border-box", borderRadius: 14, border: "1px solid #333", background: "#fff", color: "#000", fontWeight: 800, padding: "0 12px", fontSize: 18 }}
>>>>>>> origin/main
          />
        </div>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="SHËNIM (opsional)"
<<<<<<< main
          style={{
            height: 48,
            borderRadius: 14,
            border: '1px solid #333',
            background: '#fff',
            color: '#000',
            fontWeight: 800,
            padding: '0 12px',
            fontSize: 15,
            marginTop: 10,
          }}
=======
          style={{ height: 48, borderRadius: 14, border: "1px solid #333", background: "#fff", color: "#000", fontWeight: 800, padding: "0 12px", fontSize: 15, marginTop: 10 }}
>>>>>>> origin/main
        />

        <button
          onClick={addMove}
          disabled={busy}
<<<<<<< main
          style={{
            marginTop: 10,
            width: '100%',
            height: 52,
            borderRadius: 16,
            background: busy ? '#333' : '#e9e9e9',
            color: '#000',
            fontWeight: 900,
            letterSpacing: 3,
            border: '1px solid #333',
          }}
=======
          style={{ marginTop: 10, width: "100%", height: 52, borderRadius: 16, background: busy ? "#333" : "#e9e9e9", color: "#000", fontWeight: 900, letterSpacing: 3, border: "1px solid #333" }}
>>>>>>> origin/main
        >
          SHTO
        </button>
      </div>

      <div style={{ border: '1px solid #222', background: '#0b0b0b', borderRadius: 16, padding: 14 }}>
        <div style={{ fontSize: 12, opacity: 0.75, letterSpacing: 2, fontWeight: 800 }}>HISTORIA (MOVES)</div>

        <div style={{ marginTop: 10 }}>
          {(moves || []).length === 0 ? (
            <div style={{ opacity: 0.75, fontWeight: 700 }}>S’KA LËVIZJE.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {moves.map((m) => (
                <div
                  key={m.id}
<<<<<<< main
                  style={{
                    border: '1px solid #222',
                    borderRadius: 14,
                    padding: 10,
                    background: '#070707',
                    display: 'grid',
                    gridTemplateColumns: '90px 1fr 140px',
                    gap: 10,
                    alignItems: 'center',
                  }}
=======
                  style={{ border: "1px solid #222", borderRadius: 14, padding: 10, background: "#070707", display: "grid", gridTemplateColumns: "90px 1fr 140px", gap: 10, alignItems: "center" }}
>>>>>>> origin/main
                >
                  <div style={{ fontWeight: 900, letterSpacing: 2 }}>{String(m.type || '').toUpperCase()}</div>
                  <div style={{ opacity: 0.85, fontWeight: 700 }}>{m.note || ''}</div>
                  <div style={{ textAlign: 'right', fontWeight: 900 }}>{euro(m.amount)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ marginTop: 16, opacity: 0.65, fontSize: 12, lineHeight: 1.4 }}>
<<<<<<< main
          SHPENZIMET me “BUXHET” tash krijohen automatikisht si OUT te <span style={{ fontWeight: 800 }}>arka_company_moves</span>.
=======
          OUT (SHPENZIME • BUXHET) llogaritet direkt nga <b>arka_expenses</b> kur paid_from = COMPANY_BUDGET.
>>>>>>> origin/main
        </div>
      </div>
    </div>
  );
}
