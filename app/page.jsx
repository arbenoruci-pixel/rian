'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link, { useRouter } from '@/lib/routerCompat.jsx';
import { APP_DATA_EPOCH, APP_VERSION } from '@/lib/appEpoch';
import { searchHomeLocal } from '@/lib/homeSearch';
import useRouteAlive, { markRouteUiAlive } from '@/lib/routeAlive';

const HOME_FAST_BOOT_VERSION = 'home-fast-boot-design-restore-v13';

function isOnlineNow() {
  try {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

function StatusPill({ online }) {
  return (
    <div className="status-pill" data-online={online ? '1' : '0'}>
      <span className="status-dot" />
      {online ? 'ONLINE' : 'OFFLINE'}
    </div>
  );
}

export default function HomePage() {
  useRouteAlive('home_fast_boot_design_restore_v13');
  const router = useRouter();
  const renderedAtRef = useRef(Date.now());
  const readyMarkedRef = useRef(false);
  const debugHoldTimerRef = useRef(null);
  const searchSeqRef = useRef(0);
  const [online, setOnline] = useState(isOnlineNow);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchMeta, setSearchMeta] = useState(null);
  const [searchError, setSearchError] = useState('');

  useEffect(() => {
    try {
      window.__TEPIHA_HOME_FAST_BOOT_VERSION__ = HOME_FAST_BOOT_VERSION;
      window.__TEPIHA_HOME_STATIC_SHELL_RENDERED__ = true;
      window.__TEPIHA_HOME_COUNTS_MODE__ = 'no_blocking_counts_v13';
      window.__TEPIHA_HOME_INTERACTIVE__ = true;
      window.__TEPIHA_HOME_INTERACTIVE_AT__ = Date.now();
      document?.documentElement?.setAttribute?.('data-home-ui-alive', '1');
      document?.body?.setAttribute?.('data-home-ui-alive', '1');
      window.dispatchEvent(new CustomEvent('tepiha:home-interactive', {
        detail: { version: HOME_FAST_BOOT_VERSION, at: Date.now(), restoredDesign: true },
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
          sourceLayer: 'home_fast_boot_design_restore_v13',
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
        mark('route_ui_ready', { stage: 'restored_static_home_ready' });
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
      try { if (debugHoldTimerRef.current) window.clearTimeout(debugHoldTimerRef.current); } catch {}
    };
  }, []);

  const queryReady = useMemo(() => String(q || '').trim().length > 0, [q]);

  const clearSearch = () => {
    setQ('');
    setSearchSubmitted(false);
    setSearchResults([]);
    setSearchMeta(null);
    setSearchError('');
  };

  const openSearchResult = (result) => {
    const href = String(result?.href || '').trim();
    if (!href) return;
    router.push(href);
  };

  const submitSearch = async (event) => {
    event?.preventDefault?.();
    const raw = String(q || '').trim();
    if (!raw || searching) return;

    const seq = searchSeqRef.current + 1;
    searchSeqRef.current = seq;
    setSearching(true);
    setSearchSubmitted(true);
    setSearchError('');

    try {
      const result = await searchHomeLocal(raw, {
        appVersion: APP_VERSION,
        epoch: APP_DATA_EPOCH,
        limit: 12,
      });
      if (searchSeqRef.current !== seq) return;
      const rows = Array.isArray(result?.results) ? result.results : [];
      setSearchResults(rows);
      setSearchMeta(result || null);
      // H1 inline search: keep results visible on Home.
      // Navigation happens only after the worker taps HAP.
    } catch (error) {
      if (searchSeqRef.current !== seq) return;
      setSearchResults([]);
      setSearchMeta(null);
      setSearchError('Kërkimi lokal nuk u krye. Provo përsëri.');
      try {
        window.localStorage.setItem('tepiha_home_search_last_v1', JSON.stringify({
          query: raw,
          normalizedQuery: null,
          timestamp: new Date().toISOString(),
          baseLocalCount: 0,
          transportLocalCount: 0,
          resultsCount: 0,
          error: String(error?.message || error),
          online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
          appVersion: APP_VERSION,
          epoch: APP_DATA_EPOCH,
        }));
      } catch {}
    } finally {
      if (searchSeqRef.current === seq) setSearching(false);
    }
  };

  const openGatiSafe = () => {
    router.push('/gati');
  };

  const startDebugHiddenPress = () => {
    try {
      if (debugHoldTimerRef.current) window.clearTimeout(debugHoldTimerRef.current);
      debugHoldTimerRef.current = window.setTimeout(() => {
        router.push('/diag-raw');
      }, 1200);
    } catch {}
  };

  const cancelDebugHiddenPress = () => {
    try {
      if (debugHoldTimerRef.current) window.clearTimeout(debugHoldTimerRef.current);
      debugHoldTimerRef.current = null;
    } catch {}
  };

  return (
    <div className="home-wrap" data-home-fast-boot="v13" data-home-design="restored">
      <header className="header-pro">
        <div className="header-text">
          <h1
            className="title"
            onTouchStart={startDebugHiddenPress}
            onTouchEnd={cancelDebugHiddenPress}
            onTouchCancel={cancelDebugHiddenPress}
            onPointerDown={startDebugHiddenPress}
            onPointerUp={cancelDebugHiddenPress}
            onPointerLeave={cancelDebugHiddenPress}
            onContextMenu={(event) => event.preventDefault()}
            style={{ cursor: 'default' }}
          >TEPIHA <span style={{ color: '#3b82f6' }}>PRO</span></h1>
        </div>
        <StatusPill online={online} />
      </header>

      <section className="search-section">
        <h2 className="section-title">🔍 KËRKO POROSINË</h2>
        <form className="search-box" onSubmit={submitSearch}>
          <input
            className="search-input"
            value={q}
            onChange={(event) => {
              const next = event.target.value;
              setQ(next);
              if (!String(next || '').trim()) {
                setSearchSubmitted(false);
                setSearchResults([]);
                setSearchMeta(null);
                setSearchError('');
              }
            }}
            placeholder="Shkruaj kodin, emrin ose telefonin"
            inputMode="text"
            autoComplete="off"
          />
          {q ? (
            <button className="search-clear" type="button" onClick={clearSearch} aria-label="Pastro kërkimin">×</button>
          ) : null}
          <button className="search-btn" type="submit" disabled={!queryReady || searching}>{searching ? '...' : 'KËRKO'}</button>
        </form>

        {searchSubmitted ? (
          <div className="search-results-panel">
            <div className="search-results-head">
              <span>{searching ? 'DUKE KËRKUAR LOKALISHT…' : `${searchResults.length} REZULTAT${searchResults.length === 1 ? '' : 'E'}`}</span>
              <span className="search-source-badge">LOCAL</span>
            </div>

            {searchError ? <div className="search-empty">{searchError}</div> : null}

            {!searching && !searchError && searchResults.length === 0 ? (
              <div className="search-empty">
                Nuk u gjet asnjë porosi lokale. Provo me emër, tel, kod ose T-code.
                {searchMeta ? (
                  <span className="search-counts">BASE {searchMeta.baseLocalCount || 0} • TRANSPORT {searchMeta.transportLocalCount || 0}</span>
                ) : null}
              </div>
            ) : null}

            {searchResults.length > 0 ? (
              <div className="search-results-list">
                {searchResults.map((item, index) => (
                  <button
                    key={`${item.kind}-${item.id || item.code || index}`}
                    className="search-result-row"
                    type="button"
                    onClick={() => openSearchResult(item)}
                  >
                    <span className={`result-kind ${item.kind === 'TRANSPORT' ? 'transport' : 'base'}`}>{item.kind}</span>
                    <span className="result-main">
                      <span className="result-title">{item.code || '—'} • {String(item.name || 'PA EMËR').toUpperCase()}</span>
                      <span className="result-sub">{item.phone ? `${item.phone} • ` : ''}{String(item.status || '').toUpperCase()}</span>
                    </span>
                    <span className="result-open">HAP</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="modules-section">
        <h2 className="section-title">⚙️ ZGJEDH MODULIN</h2>

        <div className="modules-grid">
          <Link href="/pranimi?fresh=1" prefetch={false} className="mod-card">
            <div className="mod-icon icon-pranimi">🧾</div>
            <div className="mod-info">
              <div className="mod-title">PRANIMI</div>
              <div className="mod-sub">Regjistro klientin</div>
            </div>
          </Link>

          <Link href="/pastrimi" prefetch={false} className="mod-card">
            <div className="mod-icon icon-pastrimi">🧼</div>
            <div className="mod-info">
              <div className="mod-title">PASTRIMI</div>
              <div className="mod-sub">Lista e larjes</div>
            </div>
          </Link>

          <div
            className="mod-card"
            role="link"
            tabIndex={0}
            aria-label="GATI"
            onClick={openGatiSafe}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openGatiSafe();
              }
            }}
          >
            <div className="mod-icon icon-gati">✅</div>
            <div className="mod-info">
              <div className="mod-title">GATI</div>
              <div className="mod-sub">Gati për dorëzim</div>
            </div>
          </div>

          <Link href="/marrje-sot" prefetch={false} className="mod-card">
            <div className="mod-icon icon-marrje">📦</div>
            <div className="mod-info">
              <div className="mod-title">MARRJE SOT</div>
              <div className="mod-sub">Porositë e sotme</div>
            </div>
          </Link>

          <Link href="/transport" prefetch={false} className="mod-card">
            <div className="mod-icon icon-transport">🚚</div>
            <div className="mod-info">
              <div className="mod-title">TRANSPORT</div>
              <div className="mod-sub">Porositë (T-kode)</div>
            </div>
          </Link>

          <Link href="/arka" prefetch={false} className="mod-card">
            <div className="mod-icon icon-arka">💰</div>
            <div className="mod-info">
              <div className="mod-title">ARKA</div>
              <div className="mod-sub">Mbyllja e ditës</div>
            </div>
          </Link>

          <Link href="/llogaria-ime" prefetch={false} className="mod-card account-card">
            <div className="mod-icon account-icon">👤</div>
            <div className="mod-info">
              <div className="mod-title">LLOGARIA IME</div>
              <div className="mod-sub">Rroga, avanset, borxhet dhe cash-i yt</div>
            </div>
          </Link>

          <Link href="/fletore" prefetch={false} className="mod-card fletore-card">
            <div className="mod-icon icon-fletore">📒</div>
            <div className="mod-info">
              <div className="mod-title">FLETORJA</div>
              <div className="mod-sub">Arkiva e plotë e porosive dhe detajet</div>
            </div>
          </Link>
        </div>
      </section>

      <div className="version-foot">{APP_VERSION}</div>

      <style jsx>{`
        .home-wrap { padding: 16px 14px 40px; background: #070b14; min-height: 100vh; color: #fff; font-family: system-ui, -apple-system, sans-serif; box-sizing: border-box; }

        .header-pro { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 24px; }
        .header-text .title { font-size: 26px; font-weight: 1000; letter-spacing: -0.5px; margin: 0; line-height: 1.1; }
        .status-pill { display: inline-flex; align-items: center; gap: 7px; padding: 7px 9px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.045); color: rgba(255,255,255,0.74); font-size: 10px; font-weight: 900; letter-spacing: 0.08em; white-space: nowrap; }
        .status-dot { width: 8px; height: 8px; border-radius: 999px; background: #f59e0b; display: inline-block; }
        .status-pill[data-online="1"] .status-dot { background: #22c55e; }

        .section-title { font-size: 13px; font-weight: 900; letter-spacing: 1px; color: rgba(255,255,255,0.5); margin-bottom: 12px; margin-left: 4px; }

        .search-section { margin-bottom: 28px; }
        .search-box { display: flex; gap: 8px; }
        .search-input { flex: 1; min-width: 0; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 14px 16px; color: #fff; font-size: 16px; font-weight: 700; outline: none; transition: 0.2s; box-sizing: border-box; }
        .search-input:focus { border-color: #3b82f6; background: rgba(59,130,246,0.05); }
        .search-btn { background: #3b82f6; color: #fff; border: none; border-radius: 14px; padding: 0 20px; font-weight: 900; font-size: 14px; letter-spacing: 0.5px; cursor: pointer; min-width: 78px; }
        .search-btn:disabled { opacity: 0.45; cursor: default; }
        .search-clear { width: 42px; min-width: 42px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.72); border-radius: 14px; font-size: 24px; line-height: 1; font-weight: 900; cursor: pointer; }
        .search-results-panel { margin-top: 10px; border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; background: rgba(15,23,42,0.78); padding: 10px; box-shadow: 0 14px 36px rgba(0,0,0,0.22); box-sizing: border-box; max-width: 100%; overflow: hidden; }
        .search-results-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: rgba(255,255,255,0.58); font-size: 10px; font-weight: 1000; letter-spacing: 0.08em; margin-bottom: 8px; }
        .search-source-badge { color: #bbf7d0; background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.22); border-radius: 999px; padding: 4px 7px; white-space: nowrap; }
        .search-empty { color: rgba(255,255,255,0.76); font-size: 13px; font-weight: 750; line-height: 1.35; padding: 6px 2px 2px; }
        .search-counts { display: block; color: rgba(255,255,255,0.42); font-size: 10px; font-weight: 900; letter-spacing: 0.04em; margin-top: 6px; }
        .search-results-list { display: grid; gap: 7px; }
        .search-result-row { width: 100%; display: flex; align-items: center; gap: 9px; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; background: rgba(255,255,255,0.045); color: #fff; padding: 9px; text-align: left; cursor: pointer; box-sizing: border-box; }
        .search-result-row:active { transform: scale(0.99); background: rgba(255,255,255,0.07); }
        .result-kind { width: 76px; min-width: 76px; text-align: center; border-radius: 999px; padding: 5px 6px; font-size: 9px; font-weight: 1000; letter-spacing: 0.06em; box-sizing: border-box; }
        .result-kind.base { background: rgba(59,130,246,0.14); color: #bfdbfe; border: 1px solid rgba(96,165,250,0.22); }
        .result-kind.transport { background: rgba(239,68,68,0.14); color: #fecaca; border: 1px solid rgba(248,113,113,0.24); }
        .result-main { min-width: 0; flex: 1; display: grid; gap: 2px; }
        .result-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #fff; font-size: 13px; font-weight: 950; }
        .result-sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(255,255,255,0.5); font-size: 11px; font-weight: 800; }
        .result-open { color: #93c5fd; font-size: 10px; font-weight: 1000; letter-spacing: 0.06em; white-space: nowrap; }
        @media (max-width: 380px) {
          .search-box { gap: 6px; }
          .search-input { padding: 13px 12px; font-size: 15px; }
          .search-btn { min-width: 70px; padding: 0 12px; }
          .result-kind { width: 68px; min-width: 68px; font-size: 8px; }
          .result-open { display: none; }
        }

        .modules-section { margin-top: 10px; }
        .modules-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .mod-card { background: linear-gradient(145deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border: 1px solid rgba(255,255,255,0.08); border-radius: 20px; padding: 16px; text-decoration: none; color: #fff; display: flex; flex-direction: column; gap: 14px; transition: transform 0.1s, border-color 0.2s; outline: none; min-height: 112px; box-sizing: border-box; }
        .mod-card:active { transform: scale(0.96); border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); }
        .mod-card:focus-visible { border-color: rgba(96,165,250,0.7); }
        .mod-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; }
        .icon-pranimi { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
        .icon-pastrimi { background: rgba(16, 185, 129, 0.15); color: #34d399; }
        .icon-gati { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
        .icon-marrje { background: rgba(239, 68, 68, 0.15); color: #f87171; }
        .icon-transport { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }
        .icon-arka { background: rgba(236, 72, 153, 0.15); color: #f472b6; }
        .icon-fletore { background: rgba(255, 255, 255, 0.1); color: #e2e8f0; }
        .mod-info { display: flex; flex-direction: column; gap: 4px; }
        .mod-title { font-weight: 900; font-size: 14px; letter-spacing: 0.5px; }
        .mod-sub { font-size: 11px; font-weight: 600; opacity: 0.5; line-height: 1.3; }
        .account-card { background: linear-gradient(145deg, rgba(24,24,38,0.98) 0%, rgba(34,33,58,0.98) 48%, rgba(59,130,246,0.18) 100%); border: 1px solid rgba(99,102,241,0.26); box-shadow: 0 10px 28px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.04); }
        .account-card:active { background: linear-gradient(145deg, rgba(30,30,46,1) 0%, rgba(40,39,70,1) 52%, rgba(59,130,246,0.24) 100%); border-color: rgba(129,140,248,0.42); }
        .account-icon { background: linear-gradient(180deg, rgba(99,102,241,0.24), rgba(59,130,246,0.18)); color: #dbeafe; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08); }
        .fletore-card { grid-column: 1 / -1; min-height: 96px; }
        .version-foot { margin-top: 14px; color: rgba(203,213,225,0.42); font-size: 9px; font-weight: 800; letter-spacing: 0.04em; text-align: right; }
      `}</style>
    </div>
  );
}
