"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { getTransportSession } from "@/lib/transportAuth";

const BUCKET = "tepiha-photos";

async function listJson(prefix) {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw error;
  return data || [];
}

async function downloadJson(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error || new Error("No signedUrl");
  const res = await fetch(`${data.signedUrl}&t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Fetch failed");
  return await res.json();
}

export default function TransportGati() {
  const [me, setMe] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) { window.location.href = "/transport"; return; }
    setMe(s);
  }, []);

  async function load() {
    if (!me?.transport_id) return;
    setLoading(true);
    try {
      const files = await listJson("orders");
      const jsonFiles = files.filter(f => String(f.name||"").endsWith(".json"));
      const take = jsonFiles.slice(-120); // last N
      const out = [];
      for (const f of take) {
        try {
          const ord = await downloadJson(`orders/${f.name}`);
          if (ord?.scope !== "transport") continue;
          if (ord?.transport_id !== me.transport_id) continue;
          if (ord?.status !== "transport_ready_for_base") continue;
          out.push(ord);
        } catch {}
      }
      out.sort((a,b)=>(b.ts||0)-(a.ts||0));
      setItems(out);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [me?.transport_id]);

  const count = items.length;

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT • GATI</h1>
          <div className="subtitle">{count} POROSI</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <button className="pill" onClick={load}>RIFRESKO</button>
        </div>
      </header>

      <section className="card">
        {loading ? <div className="muted">DUKE NGARKUAR...</div> : null}
        {!loading && count === 0 ? <div className="muted">S’KA POROSI GATI PËR TY.</div> : null}

        <div style={{ display:"grid", gap:8, marginTop: 10 }}>
          {items.map((o) => (
            <Link key={o.id} className="row" href={`/pastrimi?id=${o.id}`} style={{ justifyContent:"space-between" }}>
              <span className="badge">{o?.client?.code || ""}</span>
              <span className="pill">{Number(o?.pay?.m2||0).toFixed(2)} m²</span>
              <span className="pill">{Number(o?.pay?.euro||0).toFixed(2)} €</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
