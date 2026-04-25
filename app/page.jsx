'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link, { useRouter } from '@/lib/routerCompat.jsx';
import { APP_VERSION } from '@/lib/appEpoch';
import useRouteAlive, { markRouteUiAlive } from '@/lib/routeAlive';

const HOME_FAST_BOOT_VERSION = 'home-fast-boot-v12';

function isOnlineNow() {
  try {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

function normalizeSearch(value) {
  return String(value || '').trim();
}

function isTransportCode(value) {
  const raw = normalizeSearch(value).replace(/\s+/g, '').toUpperCase();
  return /^T\d+$/.test(raw);
}

function normalizeTransportCode(value) {
  const raw = normalizeSearch(value).replace(/\s+/g, '').toUpperCase();
  const digits = raw.replace(/^T+/i, '').replace(/\D+/g, '');
  return digits ? `T${digits}` : raw;
}

function primarySearchHref(value) {
  const raw = normalizeSearch(value);
  if (!raw) return '';
  if (isTransportCode(raw)) {
    return `/transport/item?code=${encodeURIComponent(normalizeTransportCode(raw))}&from=home_search_fast_v12`;
  }
  return `/search?q=${encodeURIComponent(raw)}&from=home_fast_v12`;
}

const MAIN_MODULES = [
  { href: '/pranimi', title: 'PRANIMI', subtitle: 'HYRJE E RE', eager: true },
  { href: '/pastrimi', title: 'PASTRIMI', subtitle: 'LISTA E PUNËS', eager: true },
  { href: '/gati', title: 'GATI', subtitle: 'GATI PËR MARRJE', eager: true },
  { href: '/marrje-sot', title: 'MARRJE SOT', subtitle: 'DORËZIME', eager: true },
  { href: '/arka', title: 'ARKA', subtitle: 'FINANCA', eager: false },
  { href: '/transport', title: 'TRANSPORT', subtitle: 'POROSI TRANSPORTI', eager: false },
];

export default function HomePage() {
  useRouteAlive('home_fast_boot_v12');
  const router = useRouter();
  const renderedAtRef = useRef(Date.now());
  const readyMarkedRef = useRef(false);
  const [online, setOnline] = useState(isOnlineNow);
  const [q, setQ] = useState('');

  useEffect(() => {
    try {
      window.__TEPIHA_HOME_FAST_BOOT_VERSION__ = HOME_FAST_BOOT_VERSION;
      window.__TEPIHA_HOME_STATIC_SHELL_RENDERED__ = true;
      window.__TEPIHA_HOME_COUNTS_MODE__ = 'placeholder_only_v12';
      window.__TEPIHA_HOME_INTERACTIVE__ = true;
      window.__TEPIHA_HOME_INTERACTIVE_AT__ = Date.now();
      window.dispatchEvent(new CustomEvent('tepiha:home-interactive', {
        detail: { version: HOME_FAST_BOOT_VERSION, at: Date.now(), staticShell: true },
      }));
    } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;
    let raf1 = 0;
    let raf2 = 0;

    const mark = (label, extra = {}) => {
      try {
        markRouteUiAlive(label, '/', {
          version: HOME_FAST_BOOT_VERSION,
          sourceLayer: 'home_fast_boot_v12',
          msFromRender: Math.max(0, Date.now() - Number(renderedAtRef.current || Date.now())),
          ...extra,
        });
      } catch {}
    };

    mark('route_first_paint', { stage: 'render_commit' });

    raf1 = window.requestAnimationFrame(() => {
      if (cancelled) return;
      mark('route_first_paint', { stage: 'raf_1' });
      raf2 = window.requestAnimationFrame(() => {
        if (cancelled || readyMarkedRef.current) return;
        readyMarkedRef.current = true;
        mark('route_first_interactive', { stage: 'raf_2' });
        mark('route_ui_ready', { stage: 'static_home_ready' });
      });
    });

    return () => {
      cancelled = true;
      try { window.cancelAnimationFrame(raf1); } catch {}
      try { window.cancelAnimationFrame(raf2); } catch {}
    };
  }, []);

  useEffect(() => {
    const update = () => setOnline(isOnlineNow());
    update();
    try { window.addEventListener('online', update, { passive: true }); } catch {}
    try { window.addEventListener('offline', update, { passive: true }); } catch {}
    try { document.addEventListener('visibilitychange', update, { passive: true }); } catch {}
    return () => {
      try { window.removeEventListener('online', update); } catch {}
      try { window.removeEventListener('offline', update); } catch {}
      try { document.removeEventListener('visibilitychange', update); } catch {}
    };
  }, []);

  const searchHref = useMemo(() => primarySearchHref(q), [q]);

  const submitSearch = (event) => {
    event?.preventDefault?.();
    const href = primarySearchHref(q);
    if (!href) return;
    router.push(href);
  };

  return (
    <main style={styles.wrap} data-home-fast-boot="v12" data-home-counts="placeholder">
      <section style={styles.header}>
        <div>
          <div style={styles.kicker}>TEPIHA</div>
          <h1 style={styles.title}>PANELI I PUNËS</h1>
        </div>
        <div style={styles.statusPill} data-online={online ? '1' : '0'}>
          <span style={{ ...styles.statusDot, background: online ? '#22c55e' : '#f59e0b' }} />
          {online ? 'ONLINE' : 'OFFLINE'}
        </div>
      </section>

      <form onSubmit={submitSearch} style={styles.searchBox}>
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="KËRKO KOD / EMËR / TEL"
          inputMode="search"
          autoComplete="off"
          style={styles.searchInput}
        />
        <button type="submit" style={styles.searchButton} disabled={!searchHref}>KËRKO</button>
      </form>

      <section style={styles.grid} aria-label="Modulet kryesore">
        {MAIN_MODULES.map((item) => (
          <Link key={item.href} href={item.href} prefetch={false} style={styles.card}>
            <span style={styles.cardTitle}>{item.title}</span>
            <span style={styles.cardSubtitle}>{item.subtitle}</span>
            <span style={styles.countLine}>COUNT: —</span>
          </Link>
        ))}
      </section>

      <section style={styles.footer}>
        <span>{APP_VERSION}</span>
        <span>{HOME_FAST_BOOT_VERSION}</span>
      </section>
    </main>
  );
}

const styles = {
  wrap: {
    minHeight: '100vh',
    boxSizing: 'border-box',
    padding: 'calc(18px + env(safe-area-inset-top, 0px)) 14px calc(18px + env(safe-area-inset-bottom, 0px))',
    background: 'radial-gradient(circle at top, rgba(37,99,235,.18), transparent 34%), #05070d',
    color: '#f8fafc',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 14,
  },
  kicker: {
    fontSize: 12,
    lineHeight: 1,
    letterSpacing: '0.18em',
    fontWeight: 1000,
    color: '#93c5fd',
  },
  title: {
    margin: '6px 0 0',
    fontSize: 27,
    lineHeight: 1.02,
    fontWeight: 1000,
    letterSpacing: '-0.03em',
  },
  statusPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '8px 10px',
    borderRadius: 999,
    border: '1px solid rgba(255,255,255,.12)',
    background: 'rgba(15,23,42,.78)',
    fontSize: 11,
    fontWeight: 1000,
    letterSpacing: '0.08em',
    whiteSpace: 'nowrap',
  },
  statusDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
    display: 'inline-block',
  },
  searchBox: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 8,
    margin: '10px 0 14px',
  },
  searchInput: {
    minWidth: 0,
    height: 48,
    borderRadius: 15,
    border: '1px solid rgba(255,255,255,.13)',
    background: 'rgba(255,255,255,.07)',
    color: '#fff',
    fontSize: 16,
    fontWeight: 900,
    padding: '0 13px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  searchButton: {
    height: 48,
    border: 0,
    borderRadius: 15,
    background: '#2563eb',
    color: '#fff',
    fontSize: 13,
    fontWeight: 1000,
    padding: '0 14px',
    letterSpacing: '0.06em',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 10,
  },
  card: {
    minHeight: 104,
    borderRadius: 19,
    border: '1px solid rgba(255,255,255,.11)',
    background: 'linear-gradient(180deg, rgba(255,255,255,.085), rgba(255,255,255,.045))',
    boxShadow: '0 16px 42px rgba(0,0,0,.24)',
    color: '#fff',
    textDecoration: 'none',
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    boxSizing: 'border-box',
  },
  cardTitle: {
    fontSize: 18,
    lineHeight: 1.08,
    fontWeight: 1000,
    letterSpacing: '-0.02em',
  },
  cardSubtitle: {
    marginTop: 6,
    fontSize: 11,
    color: 'rgba(226,232,240,.70)',
    fontWeight: 900,
    letterSpacing: '0.08em',
  },
  countLine: {
    marginTop: 10,
    fontSize: 11,
    color: '#fbbf24',
    fontWeight: 1000,
    letterSpacing: '0.06em',
  },
  footer: {
    marginTop: 14,
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
    color: 'rgba(203,213,225,.58)',
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: '0.04em',
  },
};
