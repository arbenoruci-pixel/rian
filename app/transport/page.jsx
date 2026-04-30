"use client";

import { useEffect, useState } from "react";
import { useRouter } from "@/lib/routerCompat.jsx";
import { trackRender } from '@/lib/sensor';
import { getTransportSession } from '@/lib/transportAuth';

function TransportShell({ text = 'DUKE HAPUR…' }) {
  return (
    <div style={{ minHeight: '100vh', background: '#0B1020', color: '#fff', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 1000, letterSpacing: 0.6, fontSize: 18 }}>{text}</div>
        <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.62)', fontWeight: 700 }}>TRANSPORT</div>
      </div>
    </div>
  );
}

// Single entry point for TRANSPORT: open a small shell first,
// then move to board only after the transport session is readable.
export default function TransportHome() {
  trackRender('TransportHomePage');
  const router = useRouter();
  const [status, setStatus] = useState('boot');

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      const s = getTransportSession();
      if (!cancelled && s?.transport_id) {
        setStatus('ready');
        router.replace('/transport/board');
      }
    };
    const t = window.setTimeout(run, 40);
    return () => {
      cancelled = true;
      try { window.clearTimeout(t); } catch {}
    };
  }, [router]);

  return <TransportShell text={status === 'ready' ? 'PO HAPET BOARD-I…' : 'DUKE HAPUR…'} />;
}
