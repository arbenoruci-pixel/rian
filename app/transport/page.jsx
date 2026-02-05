"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getTransportSession, setTransportSession, clearTransportSession } from "@/lib/transportAuth";

function onlyDigits(v){ return String(v||"").replace(/\D/g,""); }

export default function TransportHome() {
  const router = useRouter();
  const [sess, setSess] = useState(null);
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    setSess(getTransportSession());
  }, []);

  function onLogin(){
    const p = onlyDigits(pin);
    if(!p || p.length < 3) return alert("Shkruaj PIN.");
    const tid = `T_${p}`; // stable per-pin id
    setTransportSession({ transport_id: tid, pin: p, name: (name||"").trim() || "TRANSPORT" });
    setSess(getTransportSession());
    router.push("/transport/menu");
  }

  function onLogout(){
    clearTransportSession();
    setSess(null);
    setPin("");
    setName("");
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT</h1>
          <div className="subtitle">HYRJE ME PIN</div>
        </div>
        <Link className="pill" href="/">HOME</Link>
      </header>

      {!sess ? (
        <section className="card">
          <div className="field">
            <div className="label">EMRI (OPSIONALE)</div>
            <input className="input" value={name} onChange={(e)=>setName(e.target.value)} placeholder="p.sh. SABRI" />
          </div>
          <div className="field">
            <div className="label">PIN</div>
            <input className="input" value={pin} onChange={(e)=>setPin(e.target.value)} placeholder="PIN..." inputMode="numeric" />
          </div>
          <button className="btn btn-primary" onClick={onLogin}>LOGIN</button>
        </section>
      ) : (
        <section className="card">
          <div className="muted" style={{ marginBottom: 10 }}>I KYÇUR: {(sess?.name||"").toLowerCase()} • TRANSPORT</div>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
            <Link className="pill" href="/transport/menu">MENU</Link>
            <Link className="pill" href="/transport/pranimi">PRANIMI</Link>
            <Link className="pill" href="/transport/gati">GATI</Link>
            <Link className="pill" href="/transport/arka">ARKA</Link>
          </div>
          <div style={{ height: 12 }} />
          <button className="btn" onClick={onLogout}>LOG OUT</button>
        </section>
      )}
    </div>
  );
}
