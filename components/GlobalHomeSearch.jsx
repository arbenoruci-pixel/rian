'use client';

import React from 'react';
import { usePathname, useRouter } from '@/lib/routerCompat.jsx';
import { buildHomeSearchHref, cleanVisiblePersonName, searchHomeLocalFirst } from '@/lib/homeSearch';

function safeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function cleanSearch(value) {
  return String(value || '').trim();
}

function isBaseResult(result) {
  return String(result?.kind || '').toUpperCase() !== 'TRANSPORT';
}

function isTransportResult(result) {
  return String(result?.kind || '').toUpperCase() === 'TRANSPORT';
}

function cleanClientCode(value) {
  return String(value || '').replace(/^#+/, '').trim();
}

function resultCodeLabel(result) {
  if (isBaseResult(result)) {
    const orderId = safeText(result?.orderId || result?.id);
    const code = cleanClientCode(result?.clientCode || result?.code || '');
    if (orderId && code && orderId !== code) return `Order ID ${orderId} / Code ${code}`;
    if (orderId) return `Order ID ${orderId}`;
    if (code) return `Code ${code}`;
  }
  return safeText(result?.code, '—');
}


const FAB_STORAGE_KEY = 'tepiha_global_search_fab_position_v1';
const FAB_SIZE = 48;
const FAB_MARGIN = 12;
const FAB_DRAG_THRESHOLD = 8;
const FAB_LONG_PRESS_MS = 650;
const FAB_DOUBLE_TAP_MS = 300;
const FAB_SNAP_MARGIN = 18;
let fabSafeAreaInsetsCache = null;

function isTransportFabPath(pathname) {
  const path = String(pathname || '/');
  return path === '/transport' || path.startsWith('/transport/');
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(value, min, max) {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? Math.max(max, safeMin) : safeMin;
  return Math.min(Math.max(finiteNumber(value, safeMin), safeMin), safeMax);
}

function parseCssPx(value) {
  const n = Number.parseFloat(String(value || '0'));
  return Number.isFinite(n) ? n : 0;
}

function clearSafeAreaInsetsCache() {
  fabSafeAreaInsetsCache = null;
}

function readSafeAreaInsets() {
  if (fabSafeAreaInsetsCache) return fabSafeAreaInsetsCache;
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
  try {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = [
      'position:fixed',
      'visibility:hidden',
      'pointer-events:none',
      'z-index:-1',
      'top:0',
      'left:0',
      'padding-top:env(safe-area-inset-top)',
      'padding-right:env(safe-area-inset-right)',
      'padding-bottom:env(safe-area-inset-bottom)',
      'padding-left:env(safe-area-inset-left)',
    ].join(';');
    document.body.appendChild(probe);
    const style = window.getComputedStyle(probe);
    const insets = {
      top: parseCssPx(style.paddingTop),
      right: parseCssPx(style.paddingRight),
      bottom: parseCssPx(style.paddingBottom),
      left: parseCssPx(style.paddingLeft),
    };
    probe.remove();
    fabSafeAreaInsetsCache = insets;
    return insets;
  } catch {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }
}

function getViewportRect() {
  if (typeof window === 'undefined') {
    return { width: 390, height: 720, offsetLeft: 0, offsetTop: 0 };
  }
  const visual = window.visualViewport;
  const width = Math.max(240, finiteNumber(visual?.width, window.innerWidth || document?.documentElement?.clientWidth || 390));
  const height = Math.max(320, finiteNumber(visual?.height, window.innerHeight || document?.documentElement?.clientHeight || 720));
  return {
    width,
    height,
    offsetLeft: finiteNumber(visual?.offsetLeft, 0),
    offsetTop: finiteNumber(visual?.offsetTop, 0),
  };
}

function getFabBounds(pathname) {
  const viewport = getViewportRect();
  const safe = readSafeAreaInsets();
  const transportPage = isTransportFabPath(pathname);
  const bottomReserved = transportPage ? 116 : 96;
  const leftInset = Math.max(FAB_MARGIN, safe.left + FAB_MARGIN);
  const rightInset = Math.max(FAB_MARGIN, safe.right + FAB_MARGIN);
  const topInset = Math.max(FAB_MARGIN, safe.top + FAB_MARGIN);
  const bottomInset = Math.max(74, safe.bottom + bottomReserved);
  const minX = viewport.offsetLeft + leftInset;
  const maxX = viewport.offsetLeft + viewport.width - FAB_SIZE - rightInset;
  const minY = viewport.offsetTop + topInset;
  const maxY = viewport.offsetTop + viewport.height - FAB_SIZE - bottomInset;
  return {
    minX,
    maxX: Math.max(maxX, minX),
    minY,
    maxY: Math.max(maxY, minY),
  };
}

function clampFabPosition(position, pathname) {
  const bounds = getFabBounds(pathname);
  return {
    x: clampNumber(position?.x, bounds.minX, bounds.maxX),
    y: clampNumber(position?.y, bounds.minY, bounds.maxY),
  };
}

function snapFabPosition(position, pathname) {
  const bounds = getFabBounds(pathname);
  const clamped = clampFabPosition(position, pathname);
  let x = clamped.x;
  let y = clamped.y;
  if (x <= bounds.minX + FAB_SNAP_MARGIN) x = bounds.minX;
  if (x >= bounds.maxX - FAB_SNAP_MARGIN) x = bounds.maxX;
  if (y <= bounds.minY + FAB_SNAP_MARGIN) y = bounds.minY;
  if (y >= bounds.maxY - FAB_SNAP_MARGIN) y = bounds.maxY;
  return { x, y };
}

function getDefaultFabPosition(pathname) {
  const bounds = getFabBounds(pathname);
  return {
    x: bounds.maxX,
    y: bounds.maxY,
  };
}

function loadStoredFabPosition(pathname) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage?.getItem?.(FAB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(Number(parsed?.x)) || !Number.isFinite(Number(parsed?.y))) return null;
    return clampFabPosition({ x: Number(parsed.x), y: Number(parsed.y) }, pathname);
  } catch {
    return null;
  }
}

function saveStoredFabPosition(position) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem?.(FAB_STORAGE_KEY, JSON.stringify({
      x: Math.round(finiteNumber(position?.x, 0)),
      y: Math.round(finiteNumber(position?.y, 0)),
      updatedAt: new Date().toISOString(),
    }));
  } catch {}
}

function shouldHideGlobalSearch(pathname) {
  const path = String(pathname || '/');
  if (path === '/') return true;
  if (path === '/login' || path.startsWith('/login/')) return true;
  if (path === '/transport/login' || path.startsWith('/transport/login/')) return true;
  if (path === '/offline' || path.startsWith('/offline/')) return true;
  if (path === '/porosit' || path.startsWith('/porosit/')) return true;
  if (path === '/restore' || path.startsWith('/restore/')) return true;
  if (path === '/nxirr-local' || path.startsWith('/nxirr-local/')) return true;
  if (path === '/k' || path.startsWith('/k/')) return true;
  if (path.startsWith('/debug')) return true;
  if (path.startsWith('/diag')) return true;
  return false;
}

function getStatusStyle(status) {
  const safe = String(status || '').toLowerCase();
  if (safe === 'gati') return 'ready';
  if (safe === 'pastrim' || safe === 'pastrimi' || safe === 'pranim' || safe === 'pickup') return 'active';
  if (safe === 'dorzim' || safe === 'dorzuar' || safe === 'dorezim' || safe === 'dorezuar' || safe === 'delivered') return 'delivery';
  return 'neutral';
}

function ResultKindBadge({ result }) {
  const kind = isTransportResult(result) ? 'TRANSPORT' : 'BASE';
  return <span className={`ghs-kind ghs-kind-${kind.toLowerCase()}`}>{kind}</span>;
}

export default function GlobalHomeSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = React.useRef(null);
  const searchTokenRef = React.useRef(0);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const [didSearch, setDidSearch] = React.useState(false);
  const [results, setResults] = React.useState([]);
  const [message, setMessage] = React.useState('');
  const [fabPosition, setFabPosition] = React.useState(null);
  const [fabDragging, setFabDragging] = React.useState(false);

  const fabPositionRef = React.useRef(null);
  const fabDragRef = React.useRef(null);
  const fabLongPressTimerRef = React.useRef(null);
  const fabTapOpenTimerRef = React.useRef(null);
  const fabLastTapRef = React.useRef(0);

  const hidden = shouldHideGlobalSearch(pathname);
  const hasQuery = cleanSearch(query).length > 0;

  const clearFabLongPressTimer = React.useCallback(() => {
    try {
      if (fabLongPressTimerRef.current) window.clearTimeout(fabLongPressTimerRef.current);
    } catch {}
    fabLongPressTimerRef.current = null;
  }, []);

  const clearFabTapOpenTimer = React.useCallback(() => {
    try {
      if (fabTapOpenTimerRef.current) window.clearTimeout(fabTapOpenTimerRef.current);
    } catch {}
    fabTapOpenTimerRef.current = null;
  }, []);

  const applyFabPosition = React.useCallback((position, options = {}) => {
    const next = options?.snap ? snapFabPosition(position, pathname) : clampFabPosition(position, pathname);
    fabPositionRef.current = next;
    setFabPosition(next);
    if (options?.persist) saveStoredFabPosition(next);
    return next;
  }, [pathname]);

  const resetFabPosition = React.useCallback(() => {
    clearFabTapOpenTimer();
    fabLastTapRef.current = 0;
    const next = getDefaultFabPosition(pathname);
    applyFabPosition(next, { persist: true });
    try { window.navigator?.vibrate?.(18); } catch {}
  }, [applyFabPosition, clearFabTapOpenTimer, pathname]);

  const scheduleFabTapOpen = React.useCallback(() => {
    clearFabTapOpenTimer();
    fabTapOpenTimerRef.current = window.setTimeout(() => {
      fabTapOpenTimerRef.current = null;
      setOpen(true);
    }, FAB_DOUBLE_TAP_MS);
  }, [clearFabTapOpenTimer]);

  React.useEffect(() => {
    fabPositionRef.current = fabPosition;
  }, [fabPosition]);

  React.useEffect(() => {
    if (hidden) return undefined;

    const initial = loadStoredFabPosition(pathname) || getDefaultFabPosition(pathname);
    applyFabPosition(initial, { persist: false });

    const clampCurrentPosition = () => {
      clearSafeAreaInsetsCache();
      const current = fabPositionRef.current || loadStoredFabPosition(pathname) || getDefaultFabPosition(pathname);
      applyFabPosition(current, { persist: false });
    };

    try { window.addEventListener('resize', clampCurrentPosition, { passive: true }); } catch {}
    try { window.addEventListener('orientationchange', clampCurrentPosition, { passive: true }); } catch {}
    try { window.visualViewport?.addEventListener?.('resize', clampCurrentPosition, { passive: true }); } catch {}
    try { window.visualViewport?.addEventListener?.('scroll', clampCurrentPosition, { passive: true }); } catch {}

    return () => {
      try { window.removeEventListener('resize', clampCurrentPosition); } catch {}
      try { window.removeEventListener('orientationchange', clampCurrentPosition); } catch {}
      try { window.visualViewport?.removeEventListener?.('resize', clampCurrentPosition); } catch {}
      try { window.visualViewport?.removeEventListener?.('scroll', clampCurrentPosition); } catch {}
    };
  }, [applyFabPosition, hidden, pathname]);

  React.useEffect(() => () => {
    clearFabLongPressTimer();
    clearFabTapOpenTimer();
  }, [clearFabLongPressTimer, clearFabTapOpenTimer]);

  const handleFabPointerDown = React.useCallback((event) => {
    if (open) return;
    if (event?.isPrimary === false) return;
    if (event?.pointerType === 'mouse' && event?.button !== 0) return;

    clearFabLongPressTimer();
    clearFabTapOpenTimer();

    const rect = event.currentTarget?.getBoundingClientRect?.();
    const current = fabPositionRef.current || clampFabPosition({ x: rect?.left || 0, y: rect?.top || 0 }, pathname);
    fabDragRef.current = {
      pointerId: event.pointerId,
      startX: finiteNumber(event.clientX, 0),
      startY: finiteNumber(event.clientY, 0),
      originX: finiteNumber(current.x, 0),
      originY: finiteNumber(current.y, 0),
      dragging: false,
      moved: false,
      resetTriggered: false,
    };

    try { event.currentTarget?.setPointerCapture?.(event.pointerId); } catch {}
    try { event.preventDefault?.(); } catch {}

    fabLongPressTimerRef.current = window.setTimeout(() => {
      const state = fabDragRef.current;
      if (!state || state.pointerId !== event.pointerId || state.dragging || state.moved) return;
      state.resetTriggered = true;
      resetFabPosition();
    }, FAB_LONG_PRESS_MS);
  }, [clearFabLongPressTimer, clearFabTapOpenTimer, open, pathname, resetFabPosition]);

  const handleFabPointerMove = React.useCallback((event) => {
    const state = fabDragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    const dx = finiteNumber(event.clientX, state.startX) - state.startX;
    const dy = finiteNumber(event.clientY, state.startY) - state.startY;
    const distance = Math.hypot(dx, dy);

    if (distance > FAB_DRAG_THRESHOLD) {
      state.dragging = true;
      state.moved = true;
      clearFabLongPressTimer();
      setFabDragging(true);
    }

    if (!state.dragging) return;
    try { event.preventDefault?.(); } catch {}
    applyFabPosition({ x: state.originX + dx, y: state.originY + dy }, { persist: false });
  }, [applyFabPosition, clearFabLongPressTimer]);

  const finishFabPointer = React.useCallback((event, cancelled = false) => {
    const state = fabDragRef.current;
    if (!state || state.pointerId !== event.pointerId) return;

    clearFabLongPressTimer();
    fabDragRef.current = null;
    setFabDragging(false);
    try { event.currentTarget?.releasePointerCapture?.(event.pointerId); } catch {}
    try { event.preventDefault?.(); } catch {}

    if (state.dragging || state.moved) {
      const finalPosition = fabPositionRef.current || { x: state.originX, y: state.originY };
      applyFabPosition(finalPosition, { persist: true, snap: true });
      return;
    }

    if (cancelled || state.resetTriggered) return;

    const now = Date.now();
    if (now - fabLastTapRef.current <= FAB_DOUBLE_TAP_MS) {
      clearFabTapOpenTimer();
      fabLastTapRef.current = 0;
      resetFabPosition();
      return;
    }

    fabLastTapRef.current = now;
    scheduleFabTapOpen();
  }, [applyFabPosition, clearFabLongPressTimer, clearFabTapOpenTimer, resetFabPosition, scheduleFabTapOpen]);

  const handleFabKeyDown = React.useCallback((event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    } else if (event.key?.toLowerCase?.() === 'r') {
      event.preventDefault();
      resetFabPosition();
    }
  }, [resetFabPosition]);

  React.useEffect(() => {
    if (!open) return undefined;
    const previousBodyOverflow = document?.body?.style?.overflow || '';
    const previousHtmlOverflow = document?.documentElement?.style?.overflow || '';
    try { document.body.style.overflow = 'hidden'; } catch {}
    try { document.documentElement.style.overflow = 'hidden'; } catch {}
    const focusTimer = window.setTimeout(() => {
      try { inputRef.current?.focus?.(); } catch {}
    }, 80);
    return () => {
      try { window.clearTimeout(focusTimer); } catch {}
      try { document.body.style.overflow = previousBodyOverflow; } catch {}
      try { document.documentElement.style.overflow = previousHtmlOverflow; } catch {}
    };
  }, [open]);

  React.useEffect(() => {
    if (hidden && open) setOpen(false);
  }, [hidden, open]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event?.key === 'Escape') {
        event.preventDefault();
        closeModal();
      }
    };
    try { window.addEventListener('keydown', onKeyDown, true); } catch {}
    return () => {
      try { window.removeEventListener('keydown', onKeyDown, true); } catch {}
    };
  }, [open]);

  const resetSearch = React.useCallback(() => {
    searchTokenRef.current = Date.now();
    setQuery('');
    setSearching(false);
    setDidSearch(false);
    setResults([]);
    setMessage('');
    try { inputRef.current?.focus?.(); } catch {}
  }, []);

  const closeModal = React.useCallback(() => {
    searchTokenRef.current = Date.now();
    setOpen(false);
    setSearching(false);
    setDidSearch(false);
    setMessage('');
    setResults([]);
  }, []);

  const submitSearch = React.useCallback(async (event) => {
    event?.preventDefault?.();
    const nextQuery = cleanSearch(query);
    if (!nextQuery || searching) return;

    const token = Date.now();
    searchTokenRef.current = token;
    setSearching(true);
    setDidSearch(true);
    setMessage('');

    try {
      const response = await searchHomeLocalFirst(nextQuery);
      if (searchTokenRef.current !== token) return;
      const nextResults = Array.isArray(response?.results) ? response.results : [];
      setResults(nextResults);
      if (!nextResults.length) {
        setMessage('Nuk u gjet asnjë porosi. Provo me kod, emër, telefon ose T-code.');
      }
    } catch (error) {
      if (searchTokenRef.current !== token) return;
      setResults([]);
      setMessage(String(error?.message || error || 'Kërkimi lokal nuk u krye. Provo përsëri.'));
    } finally {
      if (searchTokenRef.current === token) setSearching(false);
    }
  }, [query, searching]);

  const openSearchResult = React.useCallback((result) => {
    const href = buildHomeSearchHref(result);
    if (!href) return;
    closeModal();
    router.push(href);
  }, [closeModal, router]);

  const createNewForClient = React.useCallback((result, event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!isBaseResult(result)) return;

    const name = safeText(result?.name);
    const phone = safeText(result?.phone);
    const code = cleanClientCode(result?.clientCode || result?.code || '');
    const handoff = {
      source: 'global_home_search',
      clientId: result?.clientId || result?.id || null,
      lastOrderId: result?.id || null,
      clientCode: code,
      code,
      code_n: Number(code) || null,
      name,
      phone,
      lastStatus: safeText(result?.status),
      createdAt: Date.now(),
    };

    try { window.sessionStorage?.setItem('tepiha_existing_client_handoff_v1', JSON.stringify(handoff)); } catch {}

    const params = new URLSearchParams();
    if (name) params.set('name', name);
    if (phone) params.set('phone', phone);
    if (code) params.set('code', code);
    params.set('from', 'global_home_search');
    params.set('existingClient', '1');

    closeModal();
    router.push(`/pranimi?${params.toString()}`);
  }, [closeModal, router]);

  if (hidden) return null;

  return (
    <>
      <button
        type="button"
        className={`ghs-floating-btn ${fabDragging ? 'ghs-floating-btn-dragging' : ''}`}
        aria-label="Kërko porosi"
        title="Kërko — zvarrite për ta lëvizur, long press/double tap për reset"
        style={{
          left: fabPosition ? `${Math.round(fabPosition.x)}px` : '-999px',
          top: fabPosition ? `${Math.round(fabPosition.y)}px` : '-999px',
          opacity: fabPosition ? 1 : 0,
          pointerEvents: fabPosition ? 'auto' : 'none',
        }}
        onPointerDown={handleFabPointerDown}
        onPointerMove={handleFabPointerMove}
        onPointerUp={(event) => finishFabPointer(event, false)}
        onPointerCancel={(event) => finishFabPointer(event, true)}
        onLostPointerCapture={(event) => finishFabPointer(event, true)}
        onKeyDown={handleFabKeyDown}
        onContextMenu={(event) => event.preventDefault()}
      >
        🔍
      </button>

      {open ? (
        <div className="ghs-overlay" role="dialog" aria-modal="true" aria-label="Kërko porosi">
          <button type="button" className="ghs-backdrop" aria-label="Mbylle kërkimin" onClick={closeModal} />

          <section className="ghs-sheet">
            <div className="ghs-grabber" />
            <header className="ghs-header">
              <div>
                <div className="ghs-eyebrow">GLOBAL SEARCH</div>
                <h2>Kërko porosi</h2>
              </div>
              <button type="button" className="ghs-close-btn" onClick={closeModal}>MBYLLE</button>
            </header>

            <form className="ghs-form" onSubmit={submitSearch}>
              <input
                ref={inputRef}
                className="ghs-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Kërko kod, emër, telefon ose T-code"
                autoComplete="off"
                inputMode="search"
              />
              {hasQuery ? (
                <button type="button" className="ghs-clear-btn" onClick={resetSearch} aria-label="Pastro kërkimin">×</button>
              ) : null}
              <button type="submit" className="ghs-search-btn" disabled={!hasQuery || searching}>
                {searching ? '...' : 'KËRKO'}
              </button>
            </form>

            <div className="ghs-results-wrap">
              {searching ? <div className="ghs-note">Duke kërkuar lokalisht...</div> : null}
              {!searching && message ? <div className="ghs-note ghs-empty">{message}</div> : null}
              {!searching && didSearch && !message && !results.length ? (
                <div className="ghs-note ghs-empty">Nuk u gjet asnjë porosi. Provo me kod, emër, telefon ose T-code.</div>
              ) : null}

              {!searching && results.length ? (
                <div className="ghs-results">
                  {results.map((result, index) => {
                    const transport = isTransportResult(result);
                    const measurements = Array.isArray(result?.measurements) ? result.measurements.filter(Boolean) : [];
                    const broughtByText = cleanVisiblePersonName(result?.broughtBy || result?.transporter) || '';
                    const status = safeText(result?.status, transport ? 'TRANSPORT' : 'PA STATUS');
                    return (
                      <article
                        className="ghs-card"
                        key={`${result?.kind || 'BASE'}-${result?.id || result?.code || index}-${index}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => openSearchResult(result)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openSearchResult(result);
                          }
                        }}
                      >
                        <div className="ghs-card-top">
                          <div className="ghs-card-badges">
                            <span className={`ghs-code ${transport ? 'ghs-code-transport' : ''}`}>{resultCodeLabel(result)}</span>
                            <span className={`ghs-status ghs-status-${getStatusStyle(status)}`}>{status.toUpperCase()}</span>
                            <ResultKindBadge result={result} />
                          </div>
                          <span className="ghs-pieces">📦 {Number(result?.pieces || 0) || 0} copë</span>
                        </div>

                        <div className="ghs-client-name">{safeText(result?.name, 'Klient i panjohur')}</div>
                        {result?.phone ? <div className="ghs-client-phone">📞 {safeText(result.phone)}</div> : null}

                        <div className="ghs-card-meta">
                          {result?.createdBy ? <div>👤 <span>SJELLË NGA:</span> {safeText(result.createdBy)}</div> : null}
                          {!transport && result?.transporter ? <div>🚚 <span>PRU NGA:</span> {safeText(result.transporter).toUpperCase()}</div> : null}
                          {transport && broughtByText ? <div>🚚 <span>E KA PRU:</span> {broughtByText}</div> : null}
                        </div>

                        {transport ? (
                          <div className="ghs-transport-box">
                            <span>MASAT:</span>
                            {measurements.length ? (
                              <div className="ghs-measures">
                                {measurements.map((item, itemIndex) => (
                                  <span className="ghs-measure-chip" key={`${result?.id || result?.code || 't'}-${itemIndex}`}>{String(item)}</span>
                                ))}
                              </div>
                            ) : (
                              <strong>PA MASA NË CACHE</strong>
                            )}
                          </div>
                        ) : null}

                        <div className="ghs-actions">
                          {isBaseResult(result) ? (
                            <button type="button" className="ghs-new-order" onClick={(event) => createNewForClient(result, event)}>
                              KRIJO POROSI TË RE PËR KËTË KLIENT
                            </button>
                          ) : null}
                          <button type="button" className="ghs-open-result" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openSearchResult(result); }}>
                            HAP ➔
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      <style jsx>{`
        .ghs-floating-btn {
          position: fixed;
          width: ${FAB_SIZE}px;
          height: ${FAB_SIZE}px;
          border: 1px solid rgba(255,255,255,0.18);
          border-radius: 999px;
          background: rgba(8,13,24,0.78);
          color: #fff;
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          box-shadow: 0 12px 28px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.10);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          line-height: 1;
          z-index: 1200;
          cursor: grab;
          touch-action: none;
          user-select: none;
          -webkit-user-select: none;
          -webkit-touch-callout: none;
          transition: opacity 0.16s ease, background 0.16s ease, box-shadow 0.16s ease, transform 0.12s ease;
        }
        .ghs-floating-btn:active { transform: scale(0.96); background: rgba(20,30,52,0.92); }
        .ghs-floating-btn-dragging {
          cursor: grabbing;
          transform: scale(1.03);
          background: rgba(30,41,59,0.94);
          box-shadow: 0 18px 36px rgba(0,0,0,0.42), 0 0 0 5px rgba(59,130,246,0.18), inset 0 1px 0 rgba(255,255,255,0.12);
        }

        .ghs-overlay {
          position: fixed;
          inset: 0;
          z-index: 2400;
          display: flex;
          align-items: flex-end;
          justify-content: center;
          padding: 0 10px max(10px, env(safe-area-inset-bottom));
          box-sizing: border-box;
        }
        .ghs-backdrop {
          position: absolute;
          inset: 0;
          border: 0;
          background: rgba(0,0,0,0.58);
          backdrop-filter: blur(3px);
          -webkit-backdrop-filter: blur(3px);
        }
        .ghs-sheet {
          position: relative;
          width: min(100%, 620px);
          max-height: min(86vh, 760px);
          overflow: hidden;
          border: 1px solid rgba(148,163,184,0.22);
          border-radius: 26px 26px 20px 20px;
          background: linear-gradient(180deg, rgba(13,20,36,0.99), rgba(7,11,20,0.99));
          box-shadow: 0 -18px 48px rgba(0,0,0,0.56), inset 0 1px 0 rgba(255,255,255,0.08);
          color: #fff;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif;
          display: flex;
          flex-direction: column;
        }
        .ghs-grabber {
          width: 46px;
          height: 5px;
          border-radius: 999px;
          background: rgba(255,255,255,0.22);
          margin: 10px auto 4px;
          flex: 0 0 auto;
        }
        .ghs-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 14px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
          flex: 0 0 auto;
        }
        .ghs-eyebrow {
          color: rgba(147,197,253,0.92);
          font-size: 10px;
          font-weight: 1000;
          letter-spacing: 0.12em;
        }
        .ghs-header h2 {
          margin: 3px 0 0;
          font-size: 20px;
          line-height: 1.1;
          font-weight: 1000;
          letter-spacing: -0.02em;
        }
        .ghs-close-btn {
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 14px;
          background: rgba(255,255,255,0.07);
          color: rgba(255,255,255,0.92);
          padding: 10px 12px;
          font-size: 12px;
          font-weight: 1000;
          letter-spacing: 0.04em;
        }
        .ghs-form {
          display: flex;
          align-items: stretch;
          gap: 8px;
          padding: 12px 14px 10px;
          flex: 0 0 auto;
        }
        .ghs-input {
          min-width: 0;
          flex: 1;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 16px;
          background: rgba(255,255,255,0.06);
          color: #fff;
          outline: none;
          padding: 0 13px;
          min-height: 46px;
          font-size: 15px;
          font-weight: 850;
          box-sizing: border-box;
        }
        .ghs-input::placeholder { color: rgba(226,232,240,0.46); }
        .ghs-input:focus { border-color: rgba(96,165,250,0.74); background: rgba(59,130,246,0.08); }
        .ghs-clear-btn {
          width: 46px;
          min-width: 46px;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 16px;
          background: rgba(255,255,255,0.07);
          color: #e5e7eb;
          font-size: 25px;
          font-weight: 950;
          line-height: 1;
        }
        .ghs-search-btn {
          min-width: 84px;
          border: 0;
          border-radius: 16px;
          background: #2563eb;
          color: #fff;
          font-size: 13px;
          font-weight: 1000;
          letter-spacing: 0.05em;
        }
        .ghs-search-btn:disabled { opacity: 0.42; }
        .ghs-results-wrap {
          overflow: auto;
          -webkit-overflow-scrolling: touch;
          padding: 0 14px 16px;
          flex: 1 1 auto;
        }
        .ghs-note {
          margin-top: 4px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.045);
          color: rgba(226,232,240,0.84);
          padding: 12px;
          font-size: 13px;
          line-height: 1.35;
          font-weight: 850;
        }
        .ghs-empty { color: #fbbf24; border-color: rgba(251,191,36,0.24); background: rgba(120,53,15,0.16); }
        .ghs-results { display: flex; flex-direction: column; gap: 11px; padding-top: 5px; }
        .ghs-card {
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 19px;
          background: linear-gradient(145deg, rgba(255,255,255,0.065), rgba(255,255,255,0.025));
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          outline: none;
          cursor: pointer;
        }
        .ghs-card:active { transform: scale(0.99); background: rgba(255,255,255,0.08); }
        .ghs-card-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .ghs-card-badges { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
        .ghs-code {
          background: #10b981;
          color: #03130c;
          font-size: 18px;
          line-height: 1;
          font-weight: 1000;
          padding: 6px 11px;
          border-radius: 10px;
          letter-spacing: 0.02em;
        }
        .ghs-code-transport { background: #8b5cf6; color: #fff; }
        .ghs-status {
          border-radius: 999px;
          padding: 5px 9px;
          font-size: 10px;
          line-height: 1;
          font-weight: 1000;
          letter-spacing: 0.06em;
        }
        .ghs-status-ready { background: rgba(16,185,129,0.16); color: #4ade80; border: 1px solid rgba(16,185,129,0.30); }
        .ghs-status-active { background: rgba(59,130,246,0.16); color: #60a5fa; border: 1px solid rgba(59,130,246,0.30); }
        .ghs-status-delivery { background: rgba(245,158,11,0.16); color: #fbbf24; border: 1px solid rgba(245,158,11,0.30); }
        .ghs-status-neutral { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.68); border: 1px solid rgba(255,255,255,0.10); }
        .ghs-kind {
          border-radius: 999px;
          padding: 5px 8px;
          font-size: 9px;
          line-height: 1;
          font-weight: 1000;
          letter-spacing: 0.08em;
        }
        .ghs-kind-base { background: rgba(59,130,246,0.15); color: #bfdbfe; border: 1px solid rgba(59,130,246,0.28); }
        .ghs-kind-transport { background: rgba(168,85,247,0.15); color: #e9d5ff; border: 1px solid rgba(168,85,247,0.28); }
        .ghs-pieces {
          white-space: nowrap;
          border-radius: 10px;
          background: rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.88);
          padding: 5px 8px;
          font-size: 12px;
          font-weight: 950;
        }
        .ghs-client-name { font-size: 17px; line-height: 1.18; font-weight: 950; color: #fff; word-break: break-word; }
        .ghs-client-phone { font-size: 13px; font-weight: 800; color: rgba(226,232,240,0.68); }
        .ghs-card-meta {
          display: flex;
          flex-direction: column;
          gap: 4px;
          color: #93c5fd;
          font-size: 11px;
          font-weight: 850;
        }
        .ghs-card-meta span { color: rgba(255,255,255,0.62); }
        .ghs-transport-box {
          display: flex;
          flex-direction: column;
          gap: 7px;
          border-radius: 14px;
          border: 1px solid rgba(167,139,250,0.22);
          background: rgba(139,92,246,0.10);
          padding: 10px;
          color: rgba(255,255,255,0.90);
          font-size: 11px;
          font-weight: 950;
        }
        .ghs-transport-box > span { color: rgba(255,255,255,0.66); letter-spacing: 0.06em; }
        .ghs-transport-box strong { color: #fbbf24; font-size: 10px; }
        .ghs-measures { display: flex; flex-wrap: wrap; gap: 6px; }
        .ghs-measure-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1px solid rgba(196,181,253,0.36);
          background: rgba(139,92,246,0.20);
          color: #f5f3ff;
          min-height: 22px;
          padding: 3px 8px;
          font-size: 11px;
          font-weight: 1000;
        }
        .ghs-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          align-items: stretch;
          flex-wrap: wrap;
          border-top: 1px solid rgba(255,255,255,0.06);
          padding-top: 10px;
        }
        .ghs-new-order {
          flex: 1 1 210px;
          border: 1px solid rgba(16,185,129,0.42);
          border-radius: 13px;
          background: linear-gradient(180deg, rgba(16,185,129,0.22), rgba(16,185,129,0.11));
          color: #d1fae5;
          padding: 10px 11px;
          font-size: 11px;
          font-weight: 1000;
          letter-spacing: 0.02em;
        }
        .ghs-open-result {
          flex: 0 0 auto;
          border: 0;
          border-radius: 13px;
          background: #2563eb;
          color: #fff;
          padding: 10px 15px;
          font-size: 13px;
          font-weight: 1000;
        }
        @media (max-width: 460px) {
          .ghs-overlay { padding-left: 0; padding-right: 0; padding-bottom: 0; }
          .ghs-sheet { width: 100%; max-height: 88vh; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
          .ghs-form { gap: 7px; }
          .ghs-search-btn { min-width: 76px; }
          .ghs-card-top { align-items: flex-start; }
          .ghs-pieces { margin-top: 2px; }
          .ghs-actions { flex-direction: column; }
          .ghs-new-order, .ghs-open-result { width: 100%; flex-basis: auto; }
        }
      `}</style>
    </>
  );
}
