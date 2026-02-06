/*
 PATCH NOTE:
 Replace your existing app/transport/pranimi/page.jsx with this file.
 It only changes LOCAL DRAFT handling to be PER-TRANSPORT (no Supabase).
*/

"use client";

import React, { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getTransportSession } from "@/lib/transportAuth";

function draftKeyFor(transportId) {
  return `transport_drafts_v1__${String(transportId || 'unknown')}`;
}

export default function TransportPranimi() {
  const params = useSearchParams();
  const oid = params.get("id") || crypto.randomUUID();

  const [me, setMe] = useState(null);
  const [drafts, setDrafts] = useState([]);

  // TODO: keep your existing form state here
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) {
      window.location.href = "/transport";
      return;
    }
    setMe(s);
  }, []);

  function refreshDrafts() {
    try {
      const key = draftKeyFor(me?.transport_id);
      const raw = localStorage.getItem(key);
      const list = raw ? JSON.parse(raw) : [];
      list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      setDrafts(list);
    } catch {}
  }

  function saveDraftLocal() {
    try {
      const key = draftKeyFor(me?.transport_id);
      const draft = {
        id: oid,
        ts: Date.now(),
        scope: "transport",
        transport_id: me?.transport_id,
        transport_name: me?.transport_name,
        name,
        phone,
      };

      let list = [];
      try { list = JSON.parse(localStorage.getItem(key) || "[]"); } catch {}
      list = list.filter(d => d.id !== oid);
      list.unshift(draft);
      localStorage.setItem(key, JSON.stringify(list));
      setDrafts(list);
    } catch {}
  }

  useEffect(() => {
    if (!me?.transport_id) return;
    refreshDrafts();
  }, [me?.transport_id]);

  return (
    <div className="wrap">
      <h1 className="title">TRANSPORT • PRANIMI</h1>

      <input placeholder="Emri" value={name} onChange={e=>setName(e.target.value)} />
      <input placeholder="Telefoni" value={phone} onChange={e=>setPhone(e.target.value)} />

      <button className="pill" onClick={saveDraftLocal}>RUAJ DRAFT</button>
    </div>
  );
}
