"use client";
import React, { useEffect, useMemo, useState } from "react";
import { dbGetActiveCycle, dbOpenCycle, dbCloseCycle, dbReceiveCycle, dbAddCycleMove, dbListCycleMoves, dbHasPendingHanded, dbListPendingHanded, dbGetCarryoverToday, dbListHistoryDays, dbListCyclesByDay } from "@/lib/arkaDb";
import { listPendingCashPayments, applyPendingPaymentToCycle, rejectPendingPayment } from "@/lib/arkaCashSync";

const euro = (n) => `€${Number(n || 0).toLocaleString("de-DE", { minimumFractionDigits: 2 })}`;

export default function CashClient() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("OPEN");
  const [cycle, setCycle] = useState(null);
  const [moves, setMoves] = useState([]);
  const [pendingHanded, setPendingHanded] = useState(false);
  const [pendingPays, setPendingPays] = useState([]);
  const [pendingModal, setPendingModal] = useState(false);
  const [pendingBusy, setPendingBusy] = useState(false);

  useEffect(() => {
    const u = JSON.parse(localStorage.getItem("CURRENT_USER_DATA") || "null");
    setUser(u);
    refresh();
  }, [tab]);

  async function refresh() {
    try {
      const c = await dbGetActiveCycle();
      setCycle(c);
      if (c) {
        const m = await dbListCycleMoves(c.id);
        setMoves(m);
      }
      const ph = await dbHasPendingHanded();
      setPendingHanded(ph);
      const pp = await listPendingCashPayments();
      setPendingPays(pp.items || []);
    } catch (e) { console.error(e); }
  }

  async function applyPending(p) {
    if (!cycle?.id) { setErr("HAP ARKËN NJËHERË!"); return; }
    setPendingBusy(true);
    setErr("");
    try {
      const res = await applyPendingPaymentToCycle({
        pending: p,
        cycle_id: cycle.id,
        approved_by_pin: user?.pin || null,
        approved_by_name: user?.name || "UI"
      });
      if (!res.ok) setErr("GABIM: " + res.error);
      else await refresh();
    } catch (e) { setErr("CRITICAL: " + e.message); }
    finally { setPendingBusy(false); }
  }

  return (
    <div style={{ padding: 16, color: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={() => setTab("OPEN")} style={{ flex: 1, padding: 12 }}>OPEN</button>
        <button onClick={() => setTab("DISPATCH")} style={{ flex: 1, padding: 12 }}>DISPATCH</button>
      </div>

      {err && <div style={{ background: 'red', padding: 10, borderRadius: 8, marginBottom: 10 }}>{err}</div>}

      {tab === "OPEN" && (
        <div>
          {!cycle ? (
            <button onClick={() => dbOpenCycle({ opening_cash: 0 }).then(refresh)} style={{ width: '100%', padding: 15 }}>HAP ARKËN</button>
          ) : (
            <div>
              <div style={{ marginBottom: 15, padding: 10, border: '1px solid #333' }}>
                ARKË E HAPUR: {euro(cycle.opening_cash)}
              </div>
              
              {pendingPays.length > 0 && (
                <button onClick={() => setPendingModal(true)} style={{ width: '100%', padding: 15, background: 'orange', color: '#000', fontWeight: 'bold', marginBottom: 10 }}>
                  PAGESA PENDING ({pendingPays.length})
                </button>
              )}

              <div style={{ marginTop: 20 }}>
                <strong>LËVIZJET:</strong>
                {moves.map(m => (
                  <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', padding: 8, borderBottom: '1px solid #222' }}>
                    <span>{m.type} - {m.note}</span>
                    <span>{euro(m.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {pendingModal && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', padding: 20, zIndex: 100 }}>
          <h3>PAGESAT PENDING</h3>
          {pendingPays.map(p => (
            <div key={p.id} style={{ padding: 10, border: '1px solid #444', marginBottom: 10 }}>
              <div>{p.client_name || 'Pa emer'} - {euro(p.amount)}</div>
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <button disabled={pendingBusy} onClick={() => applyPending(p)} style={{ flex: 1, padding: 10, background: 'green' }}>PRANO</button>
                <button onClick={() => setPendingModal(false)} style={{ flex: 1, padding: 10 }}>MBYLL</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
