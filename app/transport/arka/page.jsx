"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getTransportSession } from "@/lib/transportAuth";
import { readTransportArka, openTransportDay, addTransportCollected, closeTransportDay, addTransportExpense } from "@/lib/transportArkaStore";

function parseAmount(v){
  const s = String(v ?? "").replace(/[^0-9.,-]/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export default function TransportArkaPage(){
  const router = useRouter();
  const [me, setMe] = useState(null);
  const [state, setState] = useState({ day: null, open_cash: 0, items: [], expenses: [] });
  const [openCash, setOpenCash] = useState("");
  const [expName, setExpName] = useState("");
  const [expAmt, setExpAmt] = useState("");

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

  const collected = useMemo(()=> (state.items||[]).reduce((a,x)=>a + (Number(x.amount)||0),0), [state]);
  const expenses = useMemo(()=> (state.expenses||[]).reduce((a,x)=>a + (Number(x.amount)||0),0), [state]);
  const net = useMemo(()=> Number((collected - expenses).toFixed(2)), [collected, expenses]);

  function doOpen(){
    const n = parseAmount(openCash);
    openTransportDay(me.transport_id, Number.isFinite(n)?n:0);
    setOpenCash("");
    refresh();
  }
  function doExpense(){
    const n = parseAmount(expAmt);
    if(!Number.isFinite(n) || n<=0) return alert("Shuma?");
    addTransportExpense(me.transport_id, { name: expName||"SHPENZIM", amount: n, ts: Date.now() });
    setExpName(""); setExpAmt("");
    refresh();
  }
  function doClose(){
    closeTransportDay(me.transport_id);
    refresh();
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT • ARKA</h1>
          <div className="subtitle">{me?.transport_id || ""}</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <button className="pill" onClick={refresh}>RIFRESKO</button>
        </div>
      </header>

      <section className="card">
        {!state.day ? (
          <>
            <div className="card-title">HAPE DITËN</div>
            <div className="row" style={{ gap:8 }}>
              <input className="input" value={openCash} onChange={(e)=>setOpenCash(e.target.value)} placeholder="CASH HAPJE (0)" />
              <button className="btn btn-primary" onClick={doOpen}>HAPE</button>
            </div>
          </>
        ) : (
          <>
            <div className="row" style={{ justifyContent:"space-between" }}>
              <span className="pill">COLLECTED: {Number(collected||0).toFixed(2)} €</span>
              <span className="pill">SHPENZIME: {Number(expenses||0).toFixed(2)} €</span>
              <span className="badge">NETO: {Number(net||0).toFixed(2)} €</span>
            </div>

            <div className="sep" />

            <div className="card-title">SHTO SHPENZIM</div>
            <div className="row" style={{ gap:8 }}>
              <input className="input" value={expName} onChange={(e)=>setExpName(e.target.value)} placeholder="PËRSHKRIM" />
              <input className="input" value={expAmt} onChange={(e)=>setExpAmt(e.target.value)} placeholder="SHUMA" inputMode="decimal" />
              <button className="btn" onClick={doExpense}>SHTO</button>
            </div>

            <div style={{ height: 10 }} />
            <button className="btn btn-primary" onClick={doClose}>MBYLLE DITËN</button>
          </>
        )}
      </section>
    </div>
  );
}
