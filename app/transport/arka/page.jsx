"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getTransportSession } from "@/lib/transportAuth";
import { readTransportArka, addTransportExpense, addTransportTransferToBase, computeTransportBalance } from "@/lib/transportArkaStore";

function parseAmount(v){
  const s = String(v ?? "").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const EXP_TYPES = [
  { v: "FUEL", label: "NAFTË" },
  { v: "PARKING", label: "PARKING" },
  { v: "TOLL", label: "TOLL / RRUGË" },
  { v: "OTHER", label: "TË TJERA" },
];

export default function TransportArkaPage(){
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [state, setState] = useState({ items: [], expenses: [], transfers: [] });

  const [expType, setExpType] = useState("FUEL");
  const [expNote, setExpNote] = useState("");
  const [expAmt, setExpAmt] = useState("");

  const [trAmt, setTrAmt] = useState("");
  const [trNote, setTrNote] = useState("");

  useEffect(()=>{
    const s = getTransportSession();
    if(!s?.transport_id){ router.push("/transport"); return; }
    setMe(s);
    setState(readTransportArka(s.transport_id));
  }, [router]);

  function refresh(){
    if(!me?.transport_id) return;
    setState(readTransportArka(me.transport_id));
  }

  const sums = useMemo(()=> computeTransportBalance(state), [state]);
  const balance = sums.balance;

  function doExpense(){
    const n = parseAmount(expAmt);
    if(!Number.isFinite(n) || n<=0) return alert("Shuma?");
    addTransportExpense(me.transport_id, { type: expType, amount: n, note: (expNote||"").trim() });
    setExpAmt(""); setExpNote(""); setExpType("FUEL");
    refresh();
  }

  async function doTransferAll(){
    if(balance <= 0) return alert("S’ka cash në dorë.");
    const ok = confirm(`TRANSFER te DISPATCH: €${balance.toFixed(2)} ?`);
    if(!ok) return;
    await addTransportTransferToBase({ transportId: me.transport_id, transporterName: me.transport_name, amount: balance, note: (trNote||"").trim() });
    setTrNote("");
    refresh();
  }

  async function doTransferCustom(){
    const n = parseAmount(trAmt);
    if(!Number.isFinite(n) || n<=0) return alert("Shuma?");
    if(n > balance) return alert("S’mundesh me transferu ma shumë se CASH NË DORË.");
    const ok = confirm(`TRANSFER te DISPATCH: €${n.toFixed(2)} ?`);
    if(!ok) return;
    await addTransportTransferToBase({ transportId: me.transport_id, transporterName: me.transport_name, amount: n, note: (trNote||"").trim() });
    setTrAmt(""); setTrNote("");
    refresh();
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT • ARKA</h1>
          <div className="subtitle">{me?.transport_name || ""} • PIN {me?.transport_id || ""}</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <button className="pill" onClick={refresh}>RIFRESKO</button>
        </div>
      </header>

      {!me ? (
        <section className="card">
          <div className="muted">NUK JE I KYÇUR</div>
          <Link className="btn" href="/login">LOGIN</Link>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="topGrid">
              <div className="kpi">
                <div className="k">COLLECTED</div>
                <div className="v">€{sums.collected.toFixed(2)}</div>
              </div>
              <div className="kpi">
                <div className="k">SHPENZIME</div>
                <div className="v">€{sums.expenses.toFixed(2)}</div>
              </div>
              <div className="kpi">
                <div className="k">TRANSFER</div>
                <div className="v">€{sums.transfers.toFixed(2)}</div>
              </div>
              <div className="cashBox">
                <div className="k">CASH NË DORË</div>
                <div className="v">€{balance.toFixed(2)}</div>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-title">SHTO SHPENZIM</div>
            <div className="row" style={{ gap:8, flexWrap:"wrap" }}>
              <select className="input" value={expType} onChange={(e)=>setExpType(e.target.value)} style={{ maxWidth: 210 }}>
                {EXP_TYPES.map(x => <option key={x.v} value={x.v}>{x.label}</option>)}
              </select>
              <input className="input" value={expAmt} onChange={(e)=>setExpAmt(e.target.value)} placeholder="SHUMA (€)" inputMode="decimal" style={{ maxWidth: 160 }} />
              <input className="input" value={expNote} onChange={(e)=>setExpNote(e.target.value)} placeholder="PËRSHKRIM (tekst)" />
              <button className="btn" onClick={doExpense}>SHTO</button>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>SHPENZIME = NAFTË / PARKING / TOLL / TJERA + përshkrim tekst.</div>
          </section>

          <section className="card">
            <div className="card-title">TRANSFER TE DISPATCH</div>
            <div className="row" style={{ gap:8, flexWrap:"wrap" }}>
              <input className="input" value={trAmt} onChange={(e)=>setTrAmt(e.target.value)} placeholder={`SHUMA (max ${balance.toFixed(2)}€)`} inputMode="decimal" style={{ maxWidth: 220 }} />
              <input className="input" value={trNote} onChange={(e)=>setTrNote(e.target.value)} placeholder="PËRSHKRIM (opsional)" />
              <button className="btn" onClick={doTransferCustom}>TRANSFER</button>
              <button className="btn btn-primary" onClick={doTransferAll}>TRANSFER KREJT</button>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>Kjo e zbret cash-in nga transportusi dhe e fut në ARKËN E BAZËS si “handover”.</div>
          </section>

          <section className="card">
            <div className="card-title">HISTORI (E FUNDIT)</div>
            <div className="muted">TRANSFER (10 të fundit)</div>
            <div style={{ marginTop: 8, display:"grid", gap:6 }}>
              {(state.transfers||[]).slice(0,10).map((t)=>(
                <div key={t.id} className="row" style={{ justifyContent:"space-between" }}>
                  <span className="pill">{new Date(t.ts).toLocaleString()}</span>
                  <span className="pill">€{Number(t.amount||0).toFixed(2)}</span>
                  <span className="muted" style={{ flex:1, marginLeft: 8, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.note || ""}</span>
                </div>
              ))}
              {(!state.transfers || state.transfers.length===0) ? <div className="muted">S’ka transfere ende.</div> : null}
            </div>
          </section>

          <style jsx>{`
            .wrap { padding: 18px; max-width: 980px; margin: 0 auto; }
            .header-row { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; margin-bottom: 14px; }
            .title { margin:0; font-size: 22px; letter-spacing: .6px; }
            .subtitle { opacity:.75; font-size: 12px; margin-top: 2px; }
            .card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 14px; }
            .card-title { font-weight: 900; letter-spacing: .8px; font-size: 12px; margin-bottom: 10px; opacity: .95; }
            .pill { padding: 8px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.04); text-decoration:none; font-weight: 800; font-size: 12px; }
            .btn { padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08); color: inherit; font-weight: 900; font-size: 12px; }
            .btn-primary { background: rgba(37,99,235,.20); border-color: rgba(37,99,235,.40); }
            .input { padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.04); color: inherit; outline: none; }
            .row { display:flex; align-items:center; gap: 8px; }
            .muted { opacity:.75; font-size: 12px; }

            .topGrid {
              display: grid;
              grid-template-columns: repeat(3, minmax(0, 1fr));
              gap: 10px;
              align-items: stretch;
            }
            .kpi {
              border: 1px solid rgba(255,255,255,.10);
              background: rgba(255,255,255,.03);
              border-radius: 14px;
              padding: 10px 12px;
              display:flex;
              flex-direction:column;
              justify-content:center;
              min-height: 64px;
            }
            .cashBox {
              grid-column: 1 / -1;
              border: 1px solid rgba(34,197,94,.22);
              background: rgba(34,197,94,.10);
              border-radius: 14px;
              padding: 12px 12px;
              display:flex;
              justify-content:space-between;
              align-items:center;
            }
            .k { font-weight: 900; letter-spacing: .8px; font-size: 11px; opacity:.85; }
            .v { font-weight: 1000; letter-spacing: .6px; font-size: 18px; margin-top: 2px; }
            .cashBox .v { font-size: 20px; }

            @media (max-width: 520px) {
              .wrap { padding: 14px; }
              .topGrid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
              .kpi { padding: 10px; min-height: 58px; }
              .k { font-size: 10px; }
              .v { font-size: 16px; }
              .cashBox { padding: 12px; }
              .btn { min-height: 44px; }
              .input { min-height: 44px; }
            }
          `}</style>
        </>
      )}
    </div>
  );
}
