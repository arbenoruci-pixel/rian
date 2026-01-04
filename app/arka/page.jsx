import Link from "next/link";

export const dynamic = "force-dynamic";

export default function ArkaIndexPage() {
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 20, color: "#fff" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 24, fontWeight: 900, letterSpacing: 2 }}>ARKA</div>
          <div style={{ opacity: 0.6, fontWeight: 700, marginTop: 4 }}>Zgjidh modulin</div>
        </div>
        <Link
          href="/"
          style={{
            background: "rgba(255,255,255,0.1)",
            color: "#fff",
            padding: "8px 14px",
            borderRadius: 12,
            textDecoration: "none",
            fontWeight: 800,
            fontSize: 12,
          }}
        >
          KTHEHU
        </Link>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 10,
        }}
      >
        <Link
          href="/arka/cash"
          style={tile}
        >
          CASH
        </Link>
        <Link
          href="/arka/shpenzime"
          style={tile}
        >
          SHPENZIME
        </Link>
        <Link
          href="/arka/buxheti"
          style={tile}
        >
          BUXHETI I KOMPANISË
        </Link>
        <Link
          href="/arka/histori"
          style={tile}
        >
          HISTORI
        </Link>
        <Link
          href="/arka/dispatch"
          style={tile}
        >
          DISPATCH
        </Link>
      </div>
    </div>
  );
}

const tile = {
  display: "block",
  padding: "16px 18px",
  borderRadius: 18,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.06)",
  textDecoration: "none",
  color: "#fff",
  fontWeight: 900,
  letterSpacing: 1.5,
};
