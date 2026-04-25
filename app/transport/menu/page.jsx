"use client";

import Link from "@/lib/routerCompat.jsx";
import { trackRender } from '@/lib/sensor';

const MENU_ITEMS = [
  {
    href: "/transport/board",
    title: "TEREN",
    desc: "INBOX • PICKUP • LOADED • NË BAZË",
    icon: "🚚",
    accent: "rgba(34,197,94,0.16)",
    iconColor: "#16a34a",
  },
  {
    href: "/dispatch",
    title: "DISPATCH",
    desc: "DËRGO POROSI TE SHOFERI",
    icon: "📡",
    accent: "rgba(59,130,246,0.16)",
    iconColor: "#2563eb",
  },
  {
    href: "/transport/pranimi",
    title: "PRANIMI (T)",
    desc: "HAP FORMËN TRANSPORT",
    icon: "🧾",
    accent: "rgba(245,158,11,0.16)",
    iconColor: "#d97706",
  },
  {
    href: "/transport/fletore",
    title: "FLETORJA",
    desc: "HISTORI / PDF",
    icon: "📘",
    accent: "rgba(168,85,247,0.16)",
    iconColor: "#7c3aed",
  },
  {
    href: "/llogaria-ime",
    title: "LLOGARIA IME",
    desc: "PAGESA • DORËZIME • NETO",
    icon: "👤",
    accent: "rgba(14,165,233,0.15)",
    iconColor: "#0284c7",
  },
  {
    href: "/",
    title: "HOME",
    desc: "KTHEHU TE BAZA",
    icon: "🏠",
    accent: "rgba(15,23,42,0.10)",
    iconColor: "#0f172a",
  },
];

export default function TransportMenu() {
  trackRender('TransportMenuPage');
  return (
    <div style={ui.page}>
      <div style={ui.shell}>
        <div style={ui.hero}>
          <div>
            <div style={ui.eyebrow}>TRANSPORT</div>
            <div style={ui.title}>MENU</div>
            <div style={ui.sub}>AKSIONE TË SHPEJTA NË NJË PAMJE TË PASTËR DHE PROFESIONALE.</div>
          </div>

          <Link href="/transport/board" style={ui.btnGhost}>
            HAP TERENIN
          </Link>
        </div>

        <div style={ui.grid}>
          {MENU_ITEMS.map((item) => (
            <Tile key={item.href} {...item} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Tile({ href, title, desc, icon, accent, iconColor }) {
  return (
    <Link href={href} style={ui.tile}>
      <div style={{ ...ui.tileIconWrap, background: accent, color: iconColor }}>
        <span style={ui.tileIcon}>{icon}</span>
      </div>
      <div style={ui.tileTextWrap}>
        <div style={ui.tileTitle}>{title}</div>
        <div style={ui.tileDesc}>{desc}</div>
      </div>
      <span style={ui.tileArrow}>→</span>
    </Link>
  );
}

const ui = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)",
    color: "#0f172a",
    padding: 16,
  },
  shell: {
    maxWidth: 560,
    margin: "0 auto",
    display: "grid",
    gap: 14,
  },
  hero: {
    display: "grid",
    gap: 14,
    padding: 18,
    borderRadius: 22,
    background: "rgba(255,255,255,0.82)",
    border: "1px solid rgba(15,23,42,0.08)",
    boxShadow: "0 16px 40px rgba(15,23,42,0.08)",
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: 900,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    color: "rgba(15,23,42,0.52)",
  },
  title: {
    marginTop: 4,
    fontSize: 24,
    lineHeight: 1.05,
    fontWeight: 1000,
    letterSpacing: -0.4,
  },
  sub: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 1.5,
    color: "rgba(15,23,42,0.64)",
    fontWeight: 700,
  },
  btnGhost: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    padding: "0 14px",
    borderRadius: 14,
    border: "1px solid rgba(15,23,42,0.10)",
    background: "#0f172a",
    color: "#fff",
    textDecoration: "none",
    fontWeight: 900,
    fontSize: 13,
    letterSpacing: 0.2,
    boxShadow: "0 12px 28px rgba(15,23,42,0.18)",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 12,
  },
  tile: {
    minHeight: 118,
    padding: 14,
    borderRadius: 20,
    border: "1px solid rgba(15,23,42,0.08)",
    background: "rgba(255,255,255,0.94)",
    textDecoration: "none",
    color: "#0f172a",
    boxShadow: "0 14px 30px rgba(15,23,42,0.07)",
    display: "grid",
    alignContent: "space-between",
    gap: 12,
  },
  tileIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.55)",
  },
  tileIcon: {
    fontSize: 20,
    lineHeight: 1,
  },
  tileTextWrap: {
    display: "grid",
    gap: 5,
  },
  tileTitle: {
    fontWeight: 1000,
    fontSize: 14,
    letterSpacing: 0.2,
    lineHeight: 1.15,
  },
  tileDesc: {
    fontSize: 11,
    lineHeight: 1.45,
    color: "rgba(15,23,42,0.62)",
    fontWeight: 700,
  },
  tileArrow: {
    justifySelf: "end",
    fontSize: 15,
    lineHeight: 1,
    fontWeight: 900,
    color: "rgba(15,23,42,0.34)",
  },
};
