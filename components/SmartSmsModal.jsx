'use client';

import { useMemo } from 'react';
import { buildSmartSmsLinks } from '../lib/smartSms';

export default function SmartSmsModal({ isOpen = false, onClose, onAction, phone = '', messageText = '' }) {
  const links = useMemo(() => buildSmartSmsLinks(phone, messageText), [phone, messageText]);

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
    background: 'rgba(2,6,23,0.68)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  };

  const cardStyle = {
    width: 'min(100%, 520px)',
    borderRadius: 26,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.05))',
    boxShadow: '0 22px 60px rgba(0,0,0,0.34)',
    overflow: 'hidden',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
  };

  const headerStyle = {
    padding: '18px 18px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  };

  const titleStyle = {
    margin: 0,
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: 900,
    letterSpacing: 0.3,
  };

  const closeBtnStyle = {
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.06)',
    color: '#f8fafc',
    borderRadius: 14,
    padding: '10px 12px',
    fontWeight: 900,
    cursor: 'pointer',
  };

  const bodyStyle = {
    padding: 18,
    display: 'grid',
    gap: 14,
  };

  const previewStyle = {
    borderRadius: 20,
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.05)',
    color: 'rgba(255,255,255,0.92)',
    padding: 16,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 15,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
    overflowY: 'auto',
    maxHeight: '45vh',
  };

  const actionsStyle = {
    display: 'grid',
    gap: 12,
  };

  const baseBtn = {
    width: '100%',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 18,
    padding: '16px 18px',
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 900,
    letterSpacing: 0.3,
    cursor: 'pointer',
    boxShadow: '0 12px 24px rgba(0,0,0,0.20)',
  };

  return (
    <div style={overlayStyle}>
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h3 style={titleStyle}>SMART SMS MENU</h3>
          <button type="button" style={closeBtnStyle} onClick={onClose}>
            MBYLLE
          </button>
        </div>

        <div style={bodyStyle}>
          <div style={previewStyle}>{messageText || 'Nuk ka tekst për dërgim.'}</div>

          <div style={{ color: 'rgba(255,255,255,0.62)', fontSize: 12, lineHeight: 1.45 }}>
            WhatsApp hapet direkt me numrin e klientit. Viber e hap me tekst të gatshëm dhe mesazhi kopjohet automatikisht.
          </div>

          <div style={actionsStyle}>
            <button
              type="button"
              onClick={openWhatsApp}
              style={{ ...baseBtn, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(180deg, rgba(34,197,94,0.34), rgba(22,163,74,0.26))' }}
            >
              🟩 WHATSAPP
            </button>

            <button
              type="button"
              onClick={openViber}
              style={{ ...baseBtn, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(180deg, rgba(168,85,247,0.34), rgba(126,34,206,0.24))' }}
            >
              🟪 VIBER
            </button>

            <button
              type="button"
              onClick={openSms}
              style={{ ...baseBtn, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(180deg, rgba(59,130,246,0.34), rgba(29,78,216,0.24))' }}
            >
              🟦 SMS NORMAL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
