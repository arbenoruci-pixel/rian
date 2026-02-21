'use client';
import { useEffect, useMemo, useState } from 'react';
import { dbgGet, dbgClear } from '@/lib/debugLog';

// Opens with: 5 quick taps on the very top of the screen (invisible strip),
// or Ctrl+Alt+D on desktop.
export default function HiddenDebug() {
  const [open, setOpen] = useState(false);
  const [tap, setTap] = useState({ n: 0, t: 0 });
  const [logs, setLogs] = useState([]);

  const isOnline = useMemo(() => (typeof navigator !== 'undefined' ? navigator.onLine : true), []);

  useEffect(() => {
    function onKey(e) {
      if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setLogs(dbgGet());
    const t = setInterval(() => setLogs(dbgGet()), 700);
    return () => clearInterval(t);
  }, [open]);

  if (!open) {
    return (
      <div
        onClick={() => {
          const now = Date.now();
          const fresh = now - tap.t < 3000;
          const n = fresh ? tap.n + 1 : 1;
          setTap({ n, t: now });
          if (n >= 5) setOpen(true);
        }}
        style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 10, zIndex: 999999, opacity: 0 }}
        aria-hidden="true"
      />
    );
  }

  return (
    <div style={wrap}>
      <div style={bar}>
        <div style={{ fontWeight: 900 }}>DEBUG MODE</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>NET: {isOnline ? 'ONLINE' : 'OFFLINE'}</div>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => {
            try {
              const txt = JSON.stringify(dbgGet(), null, 2);
              navigator.clipboard?.writeText(txt);
            } catch {}
          }}
          style={btn}
        >
          COPY
        </button>
        <button
          onClick={() => {
            dbgClear();
            setLogs([]);
          }}
          style={btn}
        >
          CLEAR
        </button>
        <button onClick={() => setOpen(false)} style={btn}>
          CLOSE
        </button>
      </div>

      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>
        Hapet me <b>5 klikime të shpejta</b> në pjesën e sipërme të ekranit. (S’prek UI normal.)
      </div>

      <pre style={pre}>{JSON.stringify(logs, null, 2)}</pre>
    </div>
  );
}

const wrap = {
  position: 'fixed',
  inset: 0,
  zIndex: 999999,
  background: 'rgba(0,0,0,0.92)',
  color: '#fff',
  padding: 14,
};

const bar = {
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  marginBottom: 10,
};

const btn = {
  padding: '8px 10px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'rgba(255,255,255,0.06)',
  color: '#fff',
  fontWeight: 800,
};

const pre = {
  whiteSpace: 'pre-wrap',
  fontSize: 12,
  lineHeight: 1.35,
  maxHeight: '88vh',
  overflow: 'auto',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 12,
  padding: 12,
};
