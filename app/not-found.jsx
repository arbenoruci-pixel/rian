import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#070b14', color: '#fff', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial', padding: 20 }}>
      <div style={{ maxWidth: 460, width: '100%', textAlign: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 18, padding: 22 }}>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1.2 }}>FAQJA NUK U GJET</div>
        <div style={{ marginTop: 8, opacity: 0.74, fontSize: 14 }}>Kjo faqe nuk ekziston ose është zhvendosur.</div>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
          <Link href="/" style={{ textDecoration: 'none', color: '#fff', background: '#2563eb', borderRadius: 12, padding: '12px 16px', fontWeight: 900, letterSpacing: 0.6 }}>
            KTHEHU NË KRYEFAQE
          </Link>
        </div>
      </div>
    </div>
  );
}
