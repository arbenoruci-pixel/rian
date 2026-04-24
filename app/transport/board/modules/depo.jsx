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

function choiceBadge(item) {
  const choice = String(item?.data?.tracking_choice || '').trim().toLowerCase();
  if (choice === 'resend') {
    return {
      text: '🔄 KËRKON RISJELLJE (+5€)',
      style: { background: 'rgba(10,132,255,0.16)', color: '#0A84FF', border: '1px solid rgba(10,132,255,0.35)' },
    };
  }
  if (choice === 'pickup') {
    return {
      text: '📍 VJEN E MERR VETË',
      style: { background: 'rgba(52,199,89,0.15)', color: '#34C759', border: '1px solid rgba(52,199,89,0.30)' },
    };
  }
  return {
    text: '⚠️ NË PRITJE TË ZGJEDHJES...',
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
          const assignedDriver = orderAssignedDriver(item);
          const rackLabel = String(item?.data?.ready_note || item?.data?.ready_location || '').trim();
          return (
            <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: 10, marginBottom: 8, borderRadius: 16, border: '1px solid rgba(245,158,11,0.55)', background: 'linear-gradient(180deg, rgba(245,158,11,0.12), rgba(245,158,11,0.04))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.22)', cursor: 'pointer', ...(unseenStyle || null) }} onClick={() => { setTimeout(() => { onMarkSeen && onMarkSeen(item?.id); setToolsRow(item); }, ACTION_DEFER_MS); }}>
              <div style={transportCodeCircle}>{transportCode(getCode(item))}</div>
              <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ffffff', fontSize: 15, fontWeight: 900, letterSpacing: 0.2 }}>{getName(item)}</span>
                    {unseenStyle ? <span style={pillStyle('rgba(245,158,11,0.18)', '#fbbf24', '1px solid rgba(245,158,11,0.35)')}>NEW</span> : null}
                    <span style={pillStyle('rgba(255,59,48,0.16)', '#ff5f57', '1px solid rgba(255,95,87,0.25)')}>🏢 DEPO</span>
                    {renderUnseenBadge ? renderUnseenBadge(item) : null}
                  </div>
                  <span style={{ color: 'rgba(255,255,255,0.48)', fontSize: 11, fontWeight: 900, whiteSpace: 'nowrap', flexShrink: 0 }}>{formatTime(item.updated_at || item.created_at)}</span>
                </div>

                <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getAddress(item) || 'Pa adresë'}</div>

                <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 12, fontWeight: 800 }}>{t.pieces} copë • {money(t.total)} €</div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', borderRadius: 12, fontSize: 11, fontWeight: 900, letterSpacing: 0.3, ...badge.style }}>{badge.text}</span>
                </div>

                {rackLabel ? (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifySelf: 'start', borderRadius: 12, padding: '4px 8px', background: 'rgba(19,108,53,0.45)', border: '1px solid rgba(52,199,89,0.35)', color: '#86efac', fontSize: 11, fontWeight: 900, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    📍 {rackLabel}
                  </div>
                ) : null}

                {assignedDriver ? (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifySelf: 'start', borderRadius: 12, padding: '4px 8px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: '#93c5fd', fontSize: 11, fontWeight: 900, marginTop: 4 }}>
                    👷‍♂️ {assignedDriver}
                  </div>
                ) : null}

                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 80, height: 32, padding: '0 12px', borderRadius: 999, background: 'linear-gradient(180deg, rgba(59,130,246,0.26), rgba(37,99,235,0.18))', border: '1px solid rgba(96,165,250,0.30)', color: '#dbeafe', fontSize: 11, fontWeight: 900, letterSpacing: 0.3, boxShadow: '0 6px 16px rgba(30,64,175,0.24)' }}>
                    HAP ➔
                  </span>
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
