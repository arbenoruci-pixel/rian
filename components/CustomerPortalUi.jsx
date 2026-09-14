import React from 'react';

// Small, consistent outline icons; no platform-dependent emoji or external assets.
export function CustomerIcon({ name, size = 20, ...props }) {
  const paths = {
    rug: <><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 8h6v8H9zM8 2v2m4-2v2m4-2v2M8 20v2m4-2v2m4-2v2"/></>,
    family: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/></>,
    pin: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></>,
    phone: <path d="m8 3 2 5-3 2a15 15 0 0 0 7 7l2-3 5 2v3a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    truck: <><path d="M3 6h11v12H3zM14 10h4l3 4v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></>,
    wash: <><path d="M12 3c-2 4-7 8-7 12a7 7 0 0 0 14 0c0-4-5-8-7-12Z"/><path d="M9 15a3 3 0 0 0 3 3"/></>,
    box: <><path d="m3 7 9-4 9 4v10l-9 4-9-4Z M3 7l9 4 9-4M12 11v10M8 5l9 4"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    chevron: <path d="m9 5 7 7-7 7"/>,
    alert: <><path d="m12 3 10 18H2Z M12 9v5m0 3h.01"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }} {...props}>{paths[name] || paths.pin}</svg>;
}

export const portal = {
  card: { background: '#fff', border: '1px solid #dde5ec', borderRadius: 18, padding: 20, marginBottom: 14, boxShadow: '0 3px 12px rgba(24,47,68,.035)', minWidth: 0 },
  heading: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 },
  icon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, flexShrink: 0, borderRadius: 12, background: '#e7f4f0', color: '#087969' },
  title: { margin: 0, color: '#19334a', fontSize: 17, lineHeight: 1.3, fontWeight: 650 },
  copy: { margin: '0 0 16px', color: '#506477', fontSize: 14, lineHeight: 1.6, fontWeight: 400 },
  button: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 9, boxSizing: 'border-box', width: '100%', minHeight: 48, padding: '12px 16px', borderRadius: 12, border: '1px solid #087969', background: '#087969', color: '#fff', fontSize: 15, fontWeight: 600, lineHeight: 1.35, textDecoration: 'none', cursor: 'pointer' },
  secondary: { background: '#f3f7fa', color: '#234761', borderColor: '#d5e0e9' },
  input: { display: 'block', width: '100%', minWidth: 0, boxSizing: 'border-box', marginTop: 7, minHeight: 48, padding: '11px 12px', borderRadius: 10, border: '1px solid #cbd8e2', background: '#fff', color: '#19334a', fontSize: 16, fontWeight: 400 },
  success: { display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 0', color: '#08715f', fontSize: 14, lineHeight: 1.45 },
  error: { margin: '12px 0 0', color: '#a53131', fontSize: 14, lineHeight: 1.45 },
};

export function CustomerPortalStyles() {
  return <style>{`
    .customer-portal, .customer-portal * { box-sizing:border-box; }
    .customer-portal { color-scheme:light; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-weight:400; }
    .customer-portal button, .customer-portal input { font-family:inherit; }
    .customer-portal button:disabled { opacity:.6; cursor:wait; }
    .customer-portal :is(button,a,input,summary):focus-visible { outline:3px solid #74cbbc; outline-offset:3px; }
    .customer-portal summary { list-style:none; cursor:pointer; }
    .customer-portal summary::-webkit-details-marker { display:none; }
    .customer-portal details[open] > summary .portal-chevron { transform:rotate(90deg); }
    .customer-family-form label { color:#40596c; font-size:13px; font-weight:500; }
    .customer-family-form input { background:#fff !important; color:#19334a !important; border-color:#cbd8e2 !important; margin-top:6px; }
    .customer-family-form button { background:#f3f7fa !important; color:#234761 !important; border-color:#d5e0e9 !important; font-size:14px; }
    .customer-family-form button[type=submit] { background:#087969 !important; color:#fff !important; border-color:#087969 !important; }
    .customer-family-form [role=alert] { color:#a53131 !important; }
    @media (max-width:360px) { .customer-portal .portal-card { padding:16px !important; } }
  `}</style>;
}
