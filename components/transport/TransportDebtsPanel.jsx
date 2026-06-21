'use client';

import React, { useEffect, useMemo, useState } from "react";
import { listDebtorsForTransport } from "@/lib/transportDebtDb";

export default function TransportDebtsPanel({ transportId, onClose }) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const rows = await listDebtorsForTransport(transportId, { limit: 300 });
        if (!alive) return;
        setItems(rows || []);
      } catch (e) {
        console.error(e);
        if (!alive) return;
        setItems([]);
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [transportId]);

  const filtered = useMemo(() => {
    const s = (q || "").trim().toUpperCase();
    if (!s) return items;
    return items.filter(x => String(x.client_tcode || "").toUpperCase().includes(s));
  }, [items, q]);

  return (
    <div className="transportDebtsOverlay">
      <div className="transportDebtsCard">
        <div className="transportDebtsHeader">
          <div className="transportDebtsTitle">BORXHET</div>
          <button className="transportDebtsClose" onClick={onClose}>MBYLL</button>
        </div>

        <div className="transportDebtsSearch">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="KËRKO T-KOD (p.sh. T302)"
          />
        </div>

        {loading ? (
          <div className="transportDebtsLoading">DUKE NGARKUAR...</div>
        ) : (
          <div className="transportDebtsList">
            {filtered.length === 0 ? (
              <div className="transportDebtsEmpty">S’KA BORXHE</div>
            ) : filtered.map((r) => (
              <div className="transportDebtsRow" key={`${r.client_tcode}-${r.transport_id}`}>
                <div className="transportDebtsLeft">
                  <div className="transportDebtsCode">{r.client_tcode}</div>
                  <div className="transportDebtsSub">TRANSPORT: {r.transport_id}</div>
                </div>
                <div className="transportDebtsAmt">€{Number(r.debt_eur || 0).toFixed(2)}</div>
              </div>
            ))}
          </div>
        )}

        <style jsx>{`
          .transportDebtsOverlay{
            position:fixed; inset:0; background:rgba(0,0,0,.55);
            display:flex; align-items:center; justify-content:center;
            padding:12px; z-index:9999;
          }
          .transportDebtsCard{
            width:min(520px, 100%);
            background:#0b0f14; border:1px solid #1f2a37; border-radius:12px;
            padding:12px;
          }
          .transportDebtsHeader{
            display:flex; align-items:center; justify-content:space-between; gap:10px;
            margin-bottom:10px;
          }
          .transportDebtsTitle{
            font-weight:800; letter-spacing:.08em;
          }
          .transportDebtsClose{
            background:#111827; border:1px solid #374151; color:#e5e7eb;
            padding:8px 10px; border-radius:10px; font-weight:700;
          }
          .transportDebtsSearch input{
            width:100%; background:#06080c; border:1px solid #233041; color:#e5e7eb;
            padding:10px 12px; border-radius:10px; outline:none;
            text-transform:uppercase;
          }
          .transportDebtsLoading,.transportDebtsEmpty{
            padding:16px; color:#9ca3af; text-align:center;
          }
          .transportDebtsList{
            margin-top:10px; max-height:60vh; overflow:auto; border-top:1px solid #1f2a37;
          }
          .transportDebtsRow{
            display:flex; justify-content:space-between; align-items:center;
            padding:10px 4px; border-bottom:1px solid #111827;
          }
          .transportDebtsCode{ font-weight:800; }
          .transportDebtsSub{ color:#9ca3af; font-size:12px; margin-top:2px; }
          .transportDebtsAmt{ font-weight:900; }
        `}</style>
      </div>
    </div>
  );
}
