"use client";

import Link from "@/lib/routerCompat.jsx";

export default function RetiredArkaDailyClosePage() {
  return (
    <main style={{ minHeight: '100vh', background: '#05070d', color: '#f8fafc', display: 'grid', placeItems: 'center', padding: 20 }}>
      <section style={{ width: 'min(520px, 100%)', border: '1px solid #243044', borderRadius: 22, padding: 22, background: '#0b1120' }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>Arka funksionon vazhdimisht</h1>
        <p style={{ color: '#cbd5e1', lineHeight: 1.55 }}>Qel/mbyllja ditore është larguar. Pagesat, avanset dhe shpenzimet regjistrohen me datën dhe orën reale.</p>
        <Link prefetch={false} href="/arka" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', borderRadius: 14, padding: 13, background: '#2563eb', color: '#fff', fontWeight: 900 }}>KTHEHU NË ARKË</Link>
      </section>
    </main>
  );
}
