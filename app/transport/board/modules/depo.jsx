'use client';


import React, { useDeferredValue, useMemo, useState } from 'react';
import { ui } from '@/lib/transport/board/ui';
import { useRenderBatches } from '@/lib/renderBatching';
import { getName, getCode, getAddress, getTotals, formatTime, money, pickLatLng, haversine, openMap, callClient } from '@/lib/transport/board/shared';

const BOARD_RENDER_LIMIT = 50;
const ACTION_DEFER_MS = 300;

function transportCode(raw) {
  const s = String(raw || '').trim().replace(/^#+/, '');
  if (!s) return 'T—';
  if (/^\d+$/.test(s)) return `#${s}`;
  return /^T/i.test(s) ? s.replace(/^T[-\s]*/i, 'T') : `T${s}`;
}

function orderAssignedDriver(o) {
  return String(o?.actor || o?.data?.actor || o?.driver_name || o?.data?.driver_name || '').trim();
}

const transportCodeCircle = {
  width: 36,
  minWidth: 36,
  height: 36,
  marginRight: 6,
  borderRadius: 999,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#39d86f',
  color: '#03140a',
  fontSize: 12,
  fontWeight: 1000,
  letterSpacing: 0.2,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 16px rgba(57,216,111,0.18)',
};

function pillStyle(bg, color, border) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '7px 12px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 950,
    letterSpacing: 0.5,
    background: bg,
    color,
    border,
    textTransform: 'uppercase',
  };
}

function cleanAddressLine(value) {
  const raw = String(value || '').trim();
  if (!raw || /pa adres|adresë jo e ruajtur|adrese jo e ruajtur/i.test(raw)) return '';
  return raw;
}

function depoRiplanLabel(item) {
  const d = item?.data || {};
  const raw = item?.riplan_at || item?.reschedule_at || d?.riplan_at || d?.reschedule_at || d?.riplan?.at || d?.schedule_at || '';
  if (!raw) return '';
  try {
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return '';
    return `RIPLAN: ${dt.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    return '';
  }
}

const cardLabelStyle = { color: 'rgba(255,255,255,0.58)', fontSize: 10.5, fontWeight: 950, letterSpacing: 0.8, textTransform: 'uppercase' };
const cardValueStyle = { color: '#f8fafc', fontSize: 13.5, fontWeight: 900, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const cardFooterStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 2, flexWrap: 'wrap' };
const openPillStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 76, height: 30, padding: '0 12px', borderRadius: 999, background: 'linear-gradient(180deg, rgba(59,130,246,0.26), rgba(37,99,235,0.18))', border: '1px solid rgba(96,165,250,0.30)', color: '#dbeafe', fontSize: 11, fontWeight: 950, letterSpacing: 0.2, boxShadow: '0 6px 16px rgba(30,64,175,0.24)', whiteSpace: 'nowrap' };

function choiceBadge(item) {
  const choice = String(item?.data?.tracking_choice || '').trim().toLowerCase();
  if (choice === 'resend') {
    return {
      text: 'Kërkon risjellje +5€',
      style: { background: 'rgba(10,132,255,0.16)', color: '#0A84FF', border: '1px solid rgba(10,132,255,0.35)' },
    };
  }
  if (choice === 'pickup') {
    return {
      text: 'Vjen e merr vetë',
      style: { background: 'rgba(52,199,89,0.15)', color: '#34C759', border: '1px solid rgba(52,199,89,0.30)' },
    };
  }
  return {
    text: 'Në pritje',
    style: { background: 'rgba(255,159,10,0.15)', color: '#FF9F0A', border: '1px solid rgba(255,159,10,0.30)' },
  };
}


function renderBatchHint(remainingCount, onMore) {
  if (!(remainingCount > 0)) return null;
  return (
    <button
      type="button"
      onClick={onMore}
      style={{
        width: '100%',
        marginTop: 10,
        minHeight: 42,
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(255,255,255,0.05)',
        color: 'rgba(255,255,255,0.88)',
        fontSize: 12,
        fontWeight: 900,
        letterSpacing: 0.6,
      }}
    >
      SHFAQ +{remainingCount} TJERA
    </button>
  );
}

function DepoModule({ items, loading, geo, onOpenModal, onBulkStatus, onOpenSms, onOpenRack, onGoGati, onGoDorzo, onMarkSeen, getUnseenRowStyle, renderUnseenBadge }) {
  const [toolsRow, setToolsRow] = useState(null);
  const [gpsSort, setGpsSort] = useState(null);

  const deferredItems = useDeferredValue(items);

  const sortedItems = useMemo(() => {
    const list = Array.isArray(deferredItems) ? deferredItems.slice(0, BOARD_RENDER_LIMIT) : [];
    if (!gpsSort) return list;
    const me = gpsSort;
    return [...list].sort((x, y) => {
      const a = pickLatLng(x);
      const b = pickLatLng(y);
      if (!a && !b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return haversine(me, a) - haversine(me, b);
    });
  }, [deferredItems, gpsSort]);

  const { visibleItems, remainingCount, renderMore } = useRenderBatches(sortedItems, { initial: 12, step: 10, pulseMs: 80, limit: BOARD_RENDER_LIMIT });

  function askGpsSort() {
    if (!navigator?.geolocation) {
      alert('GPS nuk është i disponueshëm në këtë pajisje.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setGpsSort({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert("S’u lejua GPS. Hap Settings > Location."),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  return (
    <>
      <div style={ui.listContainer}>
        <div style={ui.subTabsWrap}>
          <button style={ui.miniBtnMid} onClick={askGpsSort}>📍 GPS</button>
          <button style={ui.miniBtnMid} onClick={() => onGoGati && onGoGati()}>📦 GATI</button>
          <button style={ui.miniBtnMid} onClick={() => onGoDorzo && onGoDorzo()}>🚚 RRUGA</button>
        </div>

        {loading && <div style={ui.centerMsg}>Duke ngarkuar...</div>}
        {!loading && sortedItems.length === 0 && <div style={ui.centerMsg}>S'ka porosi në depo.</div>}

        {visibleItems.map((item) => {
          const t = getTotals(item);
          const badge = choiceBadge(item);
          const unseenStyle = getUnseenRowStyle ? getUnseenRowStyle(item) : null;
          const address = cleanAddressLine(getAddress(item));
          const riplanLabel = depoRiplanLabel(item);
          return (
            <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 10, marginBottom: 8, borderRadius: 16, border: '1px solid rgba(245,158,11,0.55)', background: 'linear-gradient(180deg, rgba(245,158,11,0.12), rgba(245,158,11,0.04))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.22)', cursor: 'pointer', ...(unseenStyle || null) }} onClick={() => { setTimeout(() => { onMarkSeen && onMarkSeen(item?.id); setToolsRow(item); }, ACTION_DEFER_MS); }}>
              <div style={transportCodeCircle}>{transportCode(getCode(item))}</div>
              <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ffffff', fontSize: 15, fontWeight: 950, letterSpacing: 0.2 }}>{getName(item)}</span>
                  <span style={pillStyle('rgba(255,59,48,0.16)', '#ffb4ab', '1px solid rgba(255,95,87,0.25)')}>DEPO</span>
                </div>

                <div style={cardLabelStyle}>ARSYE / ZGJEDHJE</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px 9px', borderRadius: 12, fontSize: 11, fontWeight: 950, letterSpacing: 0.3, ...badge.style }}>{badge.text}</span>
                  {riplanLabel ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '5px 9px', borderRadius: 12, fontSize: 11, fontWeight: 950, letterSpacing: 0.3, background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.30)', color: '#93c5fd' }}>{riplanLabel}</span> : null}
                </div>

                <div style={cardLabelStyle}>ADRESA</div>
                <div style={cardValueStyle}>{address || 'PA ADRESË'}</div>

                <div style={cardFooterStyle}>
                  <span style={{ color: 'rgba(255,255,255,0.70)', fontSize: 12, fontWeight: 900 }}>{t.pieces} copë • {money(t.total)} €</span>
                  <span style={openPillStyle}>HAP ➔</span>
                </div>
              </div>
            </div>
          );
        })}

        {renderBatchHint(remainingCount, renderMore)}

        <div style={{ height: 140 }} />
      </div>

      {toolsRow && (
        <div style={{ ...ui.modalOverlay, justifyContent: 'center', alignItems: 'center', padding: 16 }} onClick={() => setToolsRow(null)}>
          <div style={{ ...ui.toolsSheet, width: 'min(760px, 100%)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', borderRadius: 22 }} onClick={(e) => e.stopPropagation()}>
            <div style={ui.toolsHeader}>
              <div style={{ fontWeight: '900', fontSize: 18 }}>{getName(toolsRow)}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{getAddress(toolsRow)}</div>
            </div>
            <div style={ui.toolsGrid}>
              <button style={ui.toolBtnBig} onClick={() => { const row = toolsRow; setTimeout(() => { onOpenModal && row && onOpenModal(`/transport/item?id=${encodeURIComponent(row.id)}`); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>✏️</span><span style={{ fontSize: 14 }}>EDIT</span></button>
              <button style={{ ...ui.toolBtnBig, background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', color: '#34C759' }} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onOpenRack && row && onOpenRack(row); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>📍</span><span style={{ fontSize: 14 }}>RAFTI</span></button>
              <button style={{ ...ui.toolBtnBig, background: '#34C759' }} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onBulkStatus && row && onBulkStatus([row.id], 'gati'); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>📦</span><span style={{ fontSize: 14 }}>KTHE NË GATI</span></button>
              <button style={{ ...ui.toolBtnBig, background: '#0A84FF' }} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onBulkStatus && row && onBulkStatus([row.id], 'loaded'); onGoDorzo && onGoDorzo(); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>🚚</span><span style={{ fontSize: 14 }}>NGARKO PËR RRUGË</span></button>
              <button style={ui.toolBtnBig} onClick={() => openMap(toolsRow)}><span style={{ fontSize: 24 }}>🗺️</span><span style={{ fontSize: 14 }}>MAPS</span></button>
              <button style={ui.toolBtnBig} onClick={() => callClient(toolsRow)}><span style={{ fontSize: 24 }}>📞</span><span style={{ fontSize: 14 }}>THIRR</span></button>
              <button style={ui.toolBtnBig} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onOpenSms && row && onOpenSms(row, 'transport_konfirmim'); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>💬</span><span style={{ fontSize: 14 }}>SMS</span></button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { DepoModule };
