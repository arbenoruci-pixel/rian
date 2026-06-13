'use client';

import { useEffect, useMemo, useRef } from 'react';
import { buildSmartSmsLinks } from '../lib/smartSms';

export default function SmartSmsModal({ isOpen = false, onClose, onAction, phone = '', messageText = '' }) {
  const links = useMemo(() => buildSmartSmsLinks(phone, messageText), [phone, messageText]);
  const lockRef = useRef(null);

  const messageLines = useMemo(() => {
    const text = String(messageText || '').trim();
    if (!text) return [];
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }, [messageText]);

  const codeBadge = useMemo(() => {
    const text = String(messageText || '');
    const match = text.match(/\bT\d+\b/i) || text.match(/\b#?\d{1,5}\b/);
    return match?.[0] ? String(match[0]).replace(/^#/, '').toUpperCase() : '';
  }, [messageText]);

  const clientCount = useMemo(() => {
    const explicit = String(messageText || '').match(/(\d+)\s*klient[ëe]?/i);
    if (explicit?.[1]) return Number(explicit[1]);
    const codeMatches = String(messageText || '').match(/\bT\d+\b/gi);
    if (codeMatches?.length) return codeMatches.length;
    return String(phone || '').trim() ? 1 : 0;
  }, [messageText, phone]);

  useEffect(() => {
    if (!isOpen) return undefined;
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;

    const body = document.body;
    const html = document.documentElement;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    const previous = {
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
      bodyOverflow: body.style.overflow,
      bodyOverscrollBehavior: body.style.overscrollBehavior,
      htmlOverflow: html.style.overflow,
      htmlOverscrollBehavior: html.style.overscrollBehavior,
    };

    lockRef.current = { scrollY, previous };

    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
    html.style.overflow = 'hidden';
    html.style.overscrollBehavior = 'none';

    return () => {
      const saved = lockRef.current || { scrollY, previous };
      const prev = saved.previous || previous;
      body.style.position = prev.bodyPosition || '';
      body.style.top = prev.bodyTop || '';
      body.style.left = prev.bodyLeft || '';
      body.style.right = prev.bodyRight || '';
      body.style.width = prev.bodyWidth || '';
      body.style.overflow = prev.bodyOverflow || '';
      body.style.overscrollBehavior = prev.bodyOverscrollBehavior || '';
      html.style.overflow = prev.htmlOverflow || '';
      html.style.overscrollBehavior = prev.htmlOverscrollBehavior || '';
      try { window.scrollTo(0, saved.scrollY || 0); } catch {}
      lockRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  function openHref(href) {
    if (!href) return;
    try { window.location.href = href; } catch {}
  }

  function openWhatsApp(event) {
    event?.preventDefault?.();
    try { onAction?.('whatsapp'); } catch {}
    const appHref = String(links?.whatsappApp || '').trim();
    const webHref = String(links?.whatsapp || '').trim();
    const target = appHref || webHref;
    if (!target) {
      alert('Nuk ka numër valid për WhatsApp.');
      return;
    }

    let fallbackCancelled = false;
    const fallbackTimer = window.setTimeout(() => {
      if (fallbackCancelled) return;
      if (webHref && webHref !== target) openHref(webHref);
    }, 900);

    const stopFallback = () => {
      fallbackCancelled = true;
      try { window.clearTimeout(fallbackTimer); } catch {}
      try { document.removeEventListener('visibilitychange', handleVisibility, true); } catch {}
      try { window.removeEventListener('pagehide', stopFallback, true); } catch {}
      try { window.removeEventListener('blur', stopFallback, true); } catch {}
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') stopFallback();
    };

    try { document.addEventListener('visibilitychange', handleVisibility, true); } catch {}
    try { window.addEventListener('pagehide', stopFallback, true); } catch {}
    try { window.addEventListener('blur', stopFallback, true); } catch {}

    openHref(target);
  }

  function openViber(event) {
    event?.preventDefault?.();
    try { onAction?.('viber'); } catch {}
    try { navigator.clipboard?.writeText(String(messageText || '').trim()); } catch {}
    const href = String(links?.viber || '').trim();
    if (!href) {
      alert('Nuk u ndërtua linku për Viber.');
      return;
    }
    openHref(href);
  }

  function openSms(event) {
    event?.preventDefault?.();
    try { onAction?.('sms'); } catch {}
    const href = String(links?.sms || '').trim();
    if (!href) {
      alert('Nuk ka numër valid për SMS.');
      return;
    }
    openHref(href);
  }

  const overlayStyle = {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    background: 'rgba(2,6,23,0.76)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    padding: '10px 10px max(10px, env(safe-area-inset-bottom))',
    overflow: 'hidden',
    overscrollBehavior: 'contain',
    touchAction: 'none',
  };

  const sheetStyle = {
    width: 'min(100%, 560px)',
    height: 'min(88dvh, 88vh)',
    maxHeight: 'min(88dvh, 88vh)',
    borderRadius: '26px 26px 18px 18px',
    border: '1px solid rgba(148,163,184,0.22)',
    background: 'linear-gradient(180deg, rgba(15,23,42,0.99), rgba(3,7,18,0.99))',
    boxShadow: '0 -18px 60px rgba(0,0,0,0.50)',
    color: '#f8fafc',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    overscrollBehavior: 'contain',
    touchAction: 'auto',
  };

  const dragHandleStyle = {
    width: 46,
    height: 5,
    borderRadius: 999,
    background: 'rgba(148,163,184,0.42)',
    margin: '9px auto 3px',
    flex: '0 0 auto',
  };

  const headerStyle = {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'grid',
    gridTemplateColumns: '92px 1fr 78px',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px 12px',
    borderBottom: '1px solid rgba(148,163,184,0.16)',
    background: 'linear-gradient(180deg, rgba(15,23,42,0.99), rgba(15,23,42,0.94))',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    flex: '0 0 auto',
  };

  const closeBtnStyle = {
    border: '1px solid rgba(148,163,184,0.24)',
    background: 'rgba(15,23,42,0.92)',
    color: '#f8fafc',
    borderRadius: 14,
    padding: '10px 9px',
    minHeight: 42,
    fontSize: 13,
    fontWeight: 1000,
    cursor: 'pointer',
  };

  const titleWrapStyle = {
    textAlign: 'center',
    minWidth: 0,
  };

  const titleStyle = {
    margin: 0,
    fontSize: 14,
    fontWeight: 1000,
    letterSpacing: 0.7,
    color: '#f8fafc',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const countStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 5,
    borderRadius: 999,
    border: '1px solid rgba(96,165,250,0.28)',
    background: 'rgba(37,99,235,0.16)',
    color: '#bfdbfe',
    padding: '4px 9px',
    fontSize: 11,
    fontWeight: 1000,
  };

  const codeStyle = {
    justifySelf: 'end',
    maxWidth: 76,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    borderRadius: 999,
    border: '1px solid rgba(34,197,94,0.28)',
    background: 'rgba(22,163,74,0.13)',
    color: '#bbf7d0',
    padding: '7px 9px',
    fontSize: 12,
    fontWeight: 1000,
  };

  const bodyStyle = {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    overscrollBehavior: 'contain',
    touchAction: 'pan-y',
    padding: '12px 12px max(18px, env(safe-area-inset-bottom))',
    display: 'grid',
    gap: 12,
  };

  const previewStyle = {
    borderRadius: 18,
    border: '1px solid rgba(148,163,184,0.16)',
    background: 'rgba(15,23,42,0.72)',
    padding: 12,
    display: 'grid',
    gap: 7,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
  };

  const lineStyle = {
    color: 'rgba(248,250,252,0.94)',
    fontSize: 14,
    lineHeight: 1.35,
    wordBreak: 'break-word',
  };

  const emptyPreviewStyle = {
    ...lineStyle,
    color: 'rgba(226,232,240,0.72)',
  };

  const hintStyle = {
    borderRadius: 16,
    border: '1px solid rgba(148,163,184,0.12)',
    background: 'rgba(255,255,255,0.04)',
    color: 'rgba(226,232,240,0.76)',
    fontSize: 12,
    lineHeight: 1.35,
    padding: '10px 12px',
  };

  const actionsStyle = {
    display: 'grid',
    gap: 10,
  };

  const baseBtn = {
    width: '100%',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 16,
    padding: '14px 16px',
    color: '#ffffff',
    fontSize: 15,
    fontWeight: 1000,
    letterSpacing: 0.3,
    cursor: 'pointer',
    boxShadow: '0 12px 24px rgba(0,0,0,0.20)',
    minHeight: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div style={overlayStyle} onTouchMove={(event) => event.preventDefault()}>
      <div
        style={sheetStyle}
        onClick={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
      >
        <div style={dragHandleStyle} />
        <div style={headerStyle}>
          <button type="button" style={closeBtnStyle} onClick={onClose}>
            × Mbylle
          </button>
          <div style={titleWrapStyle}>
            <h3 style={titleStyle}>SMS KONFIRMIMI</h3>
            <div style={countStyle}>{clientCount} {clientCount === 1 ? 'klient' : 'klientë'}</div>
          </div>
          {codeBadge ? <div style={codeStyle}>{codeBadge}</div> : <div />}
        </div>

        <div style={bodyStyle}>
          <div style={previewStyle}>
            {messageLines.length ? messageLines.map((line, index) => (
              <div key={`${line}-${index}`} style={lineStyle}>{line}</div>
            )) : (
              <div style={emptyPreviewStyle}>Nuk ka tekst për dërgim.</div>
            )}
          </div>

          <div style={hintStyle}>
            WhatsApp hapet direkt me numrin e klientit. Viber e hap me tekst të gatshëm dhe mesazhi kopjohet automatikisht.
          </div>

          <div style={actionsStyle}>
            <button
              type="button"
              onClick={openWhatsApp}
              style={{ ...baseBtn, background: 'linear-gradient(180deg, rgba(34,197,94,0.36), rgba(22,163,74,0.28))' }}
            >
              WHATSAPP
            </button>

            <button
              type="button"
              onClick={openViber}
              style={{ ...baseBtn, background: 'linear-gradient(180deg, rgba(168,85,247,0.36), rgba(126,34,206,0.26))' }}
            >
              VIBER
            </button>

            <button
              type="button"
              onClick={openSms}
              style={{ ...baseBtn, background: 'linear-gradient(180deg, rgba(59,130,246,0.38), rgba(29,78,216,0.30))' }}
            >
              SMS NORMAL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
