"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { getTransportSession } from "@/lib/transportAuth";

function draftKeyFor(transportId) {
  return `transport_drafts_v1__${String(transportId || "unknown")}`;
}

function readDrafts(transportId) {
  try {
    const key = draftKeyFor(transportId);
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeDrafts(transportId, list) {
  const key = draftKeyFor(transportId);
  localStorage.setItem(key, JSON.stringify(list || []));
}

export default function TransportIncomplete() {
  const [me, setMe] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  function load() {
    if (!me?.transport_id) return;
    setLoading(true);
    try {
      let list = readDrafts(me.transport_id);
      // MIGRATE legacy drafts stored under old key (transport_drafts_v1)
      if (!list?.length) {
        try {
          const legacyRaw = localStorage.getItem('transport_drafts_v1');
          const legacy = legacyRaw ? JSON.parse(legacyRaw) : [];
          const leg = Array.isArray(legacy) ? legacy : [];
          const migrated = leg.map(d => ({ ...d, scope: d?.scope || 'transport', transport_id: String(me.transport_id) }))
            .filter(d => d && d.id);
          if (migrated.length) {
            writeDrafts(me.transport_id, migrated);
            list = migrated;
          }
        } catch {}
      }
      // vetëm draftet e transportit të këtij shoferi
      list = list.filter((d) => d?.scope === "transport");
      list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      setItems(list);
    } finally {
      setLoading(false);
    }
  }

  function del(id) {
    if (!confirm("FSHI DRAFTIN?")) return;
    const list = readDrafts(me.transport_id).filter((d) => d.id !== id);
    writeDrafts(me.transport_id, list);
    setItems(list);
  }

  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) {
      window.location.href = "/transport";
      return;
    }
    setMe(s);
  }, []);

  useEffect(() => {
    if (!me?.transport_id) return;
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [me?.transport_id]);

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT • TË PA PLOTSUARA</h1>
          <div className="subtitle">{items.length} DRAFT</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <button className="pill" onClick={load}>RIFRESKO</button>
        </div>
      </header>

      <section className="card">
        {loading ? <div className="muted">DUKE NGARKUAR...</div> : null}
        {!loading && items.length === 0 ? (
          <div className="muted">S’KA DRAFT.</div>
        ) : null}

        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {items.map((o) => (
            <div key={o.id} className="row" style={{ justifyContent: "space-between" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span className="badge">{o?.codeRaw || ""}</span>
                <span className="pill">{String(o?.name || "").toLowerCase()}</span>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <Link className="pill" href={`/transport/pranimi?id=${o.id}`}>HAP</Link>
                <button className="pill" style={{ color: "#ef4444" }} onClick={() => del(o.id)}>
                  FSHI
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
