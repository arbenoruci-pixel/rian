"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getTransportSession, clearTransportSession } from "@/lib/transportAuth";

export default function TransportMenu() {
  const router = useRouter();
  const [s, setS] = useState(null);

  useEffect(() => {
    const ss = getTransportSession();
    if (!ss?.transport_id) { router.push("/transport"); return; }
    setS(ss);
  }, [router]);

  function logout(){
    clearTransportSession();
    router.push("/transport");
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT</h1>
          <div className="subtitle">{(s?.name||"").toLowerCase()} • TRANSPORT</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Link className="pill" href="/?base=1" title="HAP BAZEN (OPSION)">SWITCH TO BASE</Link>
          <button className="pill" onClick={logout}>LOG OUT</button>
        </div>
      </header>

      <section className="card">
        <div className="grid" style={{ display:"grid", gap:10 }}>
          <Link className="btn btn-primary" href="/transport/pranimi">PRANIMI (T)</Link>
                    <Link className="btn" href="/transport/pickup">PICKUP → LOADED</Link>
<Link className="btn" href="/transport/te-pa-plotsuara">TË PA PLOTSUARA</Link>
          <Link className="btn" href="/transport/offload">OFFLOAD NË BAZË</Link>
          <Link className="btn" href="/transport/gati">GATI (VETËM TË MIAT)</Link>
          <Link className="btn" href="/transport/fletore">FLETORJA (PDF)</Link>
          <Link className="btn" href="/transport/arka">ARKA (TRANSPORT)</Link>
        </div>
      </section>
    </div>
  );
}
