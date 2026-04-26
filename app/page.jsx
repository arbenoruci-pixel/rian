'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link, { useRouter } from '@/lib/routerCompat.jsx';
import { APP_VERSION } from '@/lib/appEpoch';
import useRouteAlive, { markRouteUiAlive } from '@/lib/routeAlive';
import { buildHomeSearchHref, searchHomeLocalFirst } from '@/lib/homeSearch';

const HOME_FAST_BOOT_VERSION = 'home-inline-search-v19';

function isOnlineNow() {
  try {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

function cleanSearch(value) {
  return String(value || '').trim();
}

function StatusPill({ online }) {
  return (
    <div className="status-pill" data-online={online ? '1' : '0'}>
      <span className="status-dot" />
      {online ? 'ONLINE' : 'OFFLINE'}
    </div>
  );
}

function ResultBadge({ kind }) {
  const safeKind = String(kind || '').toUpperCase() === 'TRANSPORT' ? 'TRANSPORT' : 'BASE';
  return <span className={`result-kind result-kind-${safeKind.toLowerCase()}`}>{safeKind}</span>;
}

export default function HomePage() {
  useRouteAlive('home_inline_search_v19');
  const router = useRouter();
  const renderedAtRef = useRef(Date.now());
  const readyMarkedRef = useRef(false);
  const debugHoldTimerRef = useRef(null);
  const searchTokenRef = useRef(0);
  const [online, setOnline] = useState(isOnlineNow);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [didSearch, setDidSearch] = useState(false);
  const [results, setResults] = useState([]);
  const [searchMessage, setSearchMessage] = useState('');

  useEffect(() => {
    try {
      window.__TEPIHA_HOME_FAST_BOOT_VERSION__ = HOME_FAST_BOOT_VERSION;
      window.__TEPIHA_HOME_STATIC_SHELL_RENDERED__ = true;
      window.__TEPIHA_HOME_COUNTS_MODE__ = 'no_blocking_counts_v19';
      window.__TEPIHA_HOME_INTERACTIVE__ = true;
      window.__TEPIHA_HOME_INTERACTIVE_AT__ = Date.now();
      document?.documentElement?.setAttribute?.('data-home-ui-alive', '1');
      document?.body?.setAttribute?.('data-home-ui-alive', '1');
      window.dispatchEvent(new CustomEvent('tepiha:home-interactive', {
        detail: { version: HOME_FAST_BOOT_VERSION, at: Date.now(), restoredDesign: true, inlineSearch: true },
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
          sourceLayer: 'home_inline_search_v19',
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

  const hasQuery = useMemo(() => cleanSearch(q).length > 0, [q]);

  const submitSearch = async (event) => {
    event?.preventDefault?.();
    const query = cleanSearch(q);
    if (!query || searching) return;
    const token = Date.now();
    searchTokenRef.current = token;
    setSearching(true);
    setDidSearch(true);
    setSearchMessage('');
    try {
      const response = await searchHomeLocalFirst(query);
      if (searchTokenRef.current !== token) return;
      const nextResults = Array.isArray(response?.results) ? response.results : [];
      setResults(nextResults);
      if (!nextResults.length) {
        setSearchMessage('Nuk u gjet asnjë porosi lokale. Provo me emër, tel, kod ose T-code.');
      }
    } catch (error) {
      if (searchTokenRef.current !== token) return;
      setResults([]);
      setSearchMessage(String(error?.message || error || 'Kërkimi lokal nuk u krye. Provo përsëri.'));
    } finally {
      if (searchTokenRef.current === token) setSearching(false);
    }
  };

  const clearSearch = () => {
    searchTokenRef.current = Date.now();
    setQ('');
    setResults([]);
    setDidSearch(false);
    setSearchMessage('');
    setSearching(false);
  };

  const openSearchResult = (result) => {
    const href = buildHomeSearchHref(result);
    if (!href) return;
    router.push(href);
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
    <div className="home-wrap" data-home-fast-boot="v19" data-home-design="restored">
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
              setQ(event.target.value);
              if (!String(event.target.value || '').trim()) clearSearch();
            }}
            placeholder="Shkruaj kodin, emrin ose telefonin"
            inputMode="text"
            autoComplete="off"
          />
          {hasQuery ? (
            <button className="search-clear" type="button" onClick={clearSearch} aria-label="Pastro kërkimin">×</button>
          ) : null}
          <button className="search-btn" type="submit" disabled={!hasQuery || searching}>
            {searching ? '...' : 'KËRKO'}
          </button>
        </form>

        {(didSearch || results.length > 0 || searchMessage) ? (
          <div className="inline-search-panel">
            {searching ? <div className="search-note">Duke kërkuar lokalisht...</div> : null}
            {!searching && searchMessage ? <div className="search-note search-empty">{searchMessage}</div> : null}
            {!searching && results.length ? (
              <div className="search-results">
                {results.map((result, index) => (
                  <div className="search-result-row" key={`${result.kind || 'BASE'}-${result.id || result.code || index}-${index}`}>
                    <div className="result-main">
                      <div className="result-topline">
                        <ResultBadge kind={result.kind} />
                        <span className="result-code">{result.code || '—'}</span>
                        {result.status ? <span className="result-status">{String(result.status).toUpperCase()}</span> : null}
                      </div>
                      <div className="result-name">{result.name || 'Pa emër'}</div>
                      <div className="result-meta">
                        {result.phone ? <span>📞 {result.phone}</span> : null}
                        {result.pieces ? <span>📦 {result.pieces} copë</span> : null}
                      </div>
                    </div>
                    <button className="open-result-btn" type="button" onClick={() => openSearchResult(result)}>HAP</button>
                  </div>
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
        .search-box { display: flex; gap: 8px; align-items: stretch; }
        .search-input { flex: 1; min-width: 0; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 14px 16px; color: #fff; font-size: 16px; font-weight: 700; outline: none; transition: 0.2s; box-sizing: border-box; }
        .search-input:focus { border-color: #3b82f6; background: rgba(59,130,246,0.05); }
        .search-btn { background: #3b82f6; color: #fff; border: none; border-radius: 14px; padding: 0 18px; font-weight: 900; font-size: 14px; letter-spacing: 0.5px; cursor: pointer; min-width: 82px; }
        .search-btn:disabled { opacity: 0.45; cursor: default; }
        .search-clear { width: 44px; border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; background: rgba(255,255,255,0.06); color: #e5e7eb; font-size: 24px; font-weight: 900; }

        .inline-search-panel { margin-top: 10px; border: 1px solid rgba(59,130,246,0.28); border-radius: 16px; background: rgba(10,16,31,0.96); padding: 10px; box-shadow: 0 12px 28px rgba(0,0,0,0.25); }
        .search-note { color: rgba(226,232,240,0.82); font-size: 12px; font-weight: 800; line-height: 1.35; padding: 8px; }
        .search-empty { color: #fbbf24; }
        .search-results { display: flex; flex-direction: column; gap: 8px; }
        .search-result-row { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 10px; border-radius: 14px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); }
        .result-main { min-width: 0; flex: 1; }
        .result-topline { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
        .result-kind { font-size: 9px; font-weight: 1000; letter-spacing: 0.08em; padding: 3px 6px; border-radius: 999px; }
        .result-kind-base { background: rgba(59,130,246,0.16); color: #93c5fd; border: 1px solid rgba(59,130,246,0.28); }
        .result-kind-transport { background: rgba(168,85,247,0.16); color: #d8b4fe; border: 1px solid rgba(168,85,247,0.28); }
        .result-code { font-size: 14px; font-weight: 1000; color: #fff; }
        .result-status { font-size: 9px; font-weight: 900; color: rgba(255,255,255,0.58); }
        .result-name { font-size: 14px; font-weight: 950; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .result-meta { display: flex; gap: 8px; flex-wrap: wrap; color: rgba(226,232,240,0.64); font-size: 11px; font-weight: 800; margin-top: 2px; }
        .open-result-btn { border: 0; border-radius: 12px; background: #2563eb; color: #fff; font-size: 12px; font-weight: 1000; padding: 10px 13px; }

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
