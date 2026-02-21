"use client";

import Link from "next/link";

export default function TransportMenu() {
  return (
    <div style={ui.page}>
      <div style={ui.top}>
        <div>
          <div style={ui.title}>TRANSPORT</div>
          <div style={ui.sub}>MENU (UNIFIKUAR)</div>
        </div>
        <Link href="/transport/board" style={ui.btnGhost}>
          TEREN
        </Link>
      </div>

      <div style={ui.grid}>
        <Tile href="/transport/board" title="TEREN" desc="INBOX • PICKUP • LOADED • NË BAZË" />
        <Tile href="/dispatch" title="DISPATCH" desc="DËRGO POROSI TE SHOFERI" />
        <Tile href="/transport/pranimi" title="PRANIMI (T)" desc="HAP FORMËN TRANSPORT" />
        <Tile href="/transport/fletore" title="FLETORJA" desc="HISTORI / PDF" />
        <Tile href="/transport/arka" title="ARKA" desc="TRANSPORT (CASH)" />
        <Tile href="/" title="HOME" desc="KTHEHU TE BAZA" />
      </div>
    </div>
  );
}

function Tile({ href, title, desc }) {
  return (
    <Link href={href} style={ui.tile}>
      <div style={ui.tileTitle}>{title}</div>
      <div style={ui.tileDesc}>{desc}</div>
    </Link>
  );
}

const ui = {
  page: { minHeight: "100vh", background: "#f5f5f7", color: "#111", padding: 16 },
  top: { maxWidth: 900, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  title: { fontSize: 18, fontWeight: 900 },
  sub: { fontSize: 12, opacity: 0.7 },
  btnGhost: { border: "1px solid rgba(0,0,0,0.12)", background: "rgba(255,255,255,0.85)", padding: "10px 12px", borderRadius: 12, fontWeight: 900, textDecoration: "none", color: "#111" },
  grid: { maxWidth: 900, margin: "14px auto 0", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 },
  tile: { background: "#fff", borderRadius: 18, border: "1px solid rgba(0,0,0,0.08)", padding: 14, textDecoration: "none", color: "#111", boxShadow: "0 10px 24px rgba(0,0,0,0.06)" },
  tileTitle: { fontWeight: 900, fontSize: 14 },
  tileDesc: { marginTop: 6, fontSize: 12, opacity: 0.75, fontWeight: 800 },
};
