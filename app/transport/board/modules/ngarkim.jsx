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

function orderRackLabel(o) {
  return String(o?.data?.ready_note || o?.data?.ready_location || o?.data?.rack_label || '').trim();
}

const transportCodeCircle = { width: 36, minWidth: 36, height: 36, marginRight: 6, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#39d86f', color: '#03140a', fontSize: 12, fontWeight: 1000, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 16px rgba(57,216,111,0.18)' };
const pillBase = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', borderRadius: 999, fontSize: 10, fontWeight: 900, letterSpacing: 0.5, textTransform: 'uppercase' };


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

// MODULE: NGARKIM (status: loaded)
function NgarkimModule({ items, loading, selectedIds, setSelectedIds, gpsSort, setGpsSort, onBulkStatus, onGoRiplan, onOpenModal, onOpenSms, onMarkSeen, getUnseenRowStyle, renderUnseenBadge }) {
  const [toolsRow, setToolsRow] = useState(null);
  const selectedCount = selectedIds?.size || 0;

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev || []);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function clearSelect() { setSelectedIds(new Set()); }

  function selectAll(list) {
    const next = new Set((Array.isArray(list) ? list : []).map((x) => x.id).filter(Boolean));
    setSelectedIds(next);
  }

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

  async function askGpsSort() {
    if (!navigator?.geolocation) {
      alert('GPS nuk eshte i disponueshem ne kete pajisje.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setGpsSort({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert("S'u lejua GPS. Hap Settings > Location."),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  const actionLabel = 'SHKARKO NË BAZË';
  const actionStatus = 'pastrim';

  return (
    <>
      <div style={ui.listContainer}>
        <div style={ui.subTabsWrap}>
          {selectedCount === 0 ? (
            <button style={ui.miniBtnMid} onClick={() => selectAll(sortedItems)}>
              SELECT ALL
            </button>
          ) : (
            <button style={ui.miniBtnMid} onClick={clearSelect}>
              FSHi ({selectedCount})
            </button>
          )}
        </div>

        {loading && <div style={ui.centerMsg}>Duke ngarkuar...</div>}
        {!loading && sortedItems.length === 0 && <div style={ui.centerMsg}>S'ka porosi.</div>}

        {visibleItems.map((item) => {
          const t = getTotals(item);
          const checked = selectedIds?.has(item.id);
          const unseenStyle = getUnseenRowStyle ? getUnseenRowStyle(item) : null;
          const assignedDriver = orderAssignedDriver(item);
          const rackLabel = orderRackLabel(item);

          return (
            <div
              key={item.id}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, marginBottom: 8, borderRadius: 16, border: '1px solid rgba(245,158,11,0.50)', background: 'linear-gradient(180deg, rgba(245,158,11,0.11), rgba(245,158,11,0.04))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.22)', textAlign: 'left', cursor: 'pointer', ...(unseenStyle || null), ...(checked ? ui.rowSelected : null) }}
              onClick={() => { setTimeout(() => { onMarkSeen && onMarkSeen(item?.id); setToolsRow(item); }, ACTION_DEFER_MS); }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
                <div style={transportCodeCircle}>{transportCode(getCode(item))}</div>
                <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ffffff', fontSize: 15, fontWeight: 900, letterSpacing: 0.2 }}>{getName(item)}</span>
                      {unseenStyle ? <span style={{ ...pillBase, background: 'rgba(245,158,11,0.18)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.35)' }}>NEW</span> : null}
                      <span style={{ ...pillBase, background: 'rgba(59,130,246,0.16)', color: '#7dd3fc', border: '1px solid rgba(59,130,246,0.30)' }}>🚚 RRUGA</span>
                      {renderUnseenBadge ? renderUnseenBadge(item) : null}
                    </div>
                    <span style={{ color: 'rgba(255,255,255,0.48)', fontSize: 11, fontWeight: 900, whiteSpace: 'nowrap', flexShrink: 0 }}>{formatTime(item.created_at)}</span>
                  </div>

                  <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getAddress(item) || 'Pa adresë'}</div>

                  <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 12, fontWeight: 800 }}>{t.pieces} copë • {money(t.total)} €</div>

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

              <div style={ui.rowRight} onClick={(e) => e.stopPropagation()}>
                <button style={checked ? ui.checkOn : ui.checkOff} onClick={() => toggleSelect(item.id)} aria-label='select' title='select'>
                  {checked ? '✓' : ''}
                </button>
              </div>
            </div>
          );
        })}

        {renderBatchHint(remainingCount, renderMore)}

        <div style={{ height: 140 }} />
      </div>

      {selectedCount > 0 && (
        <div style={ui.bulkBar}>
          <button style={ui.bulkBtn} onClick={askGpsSort}>📍 GPS</button>
          <button
            style={ui.bulkBtn}
            onClick={() => {
              const firstId = Array.from(selectedIds || [])[0];
              const row = sortedItems.find((x) => x.id === firstId);
              if (!row) return;
              setTimeout(() => { onOpenSms && onOpenSms(row, 'transport_pikap_konfirmim'); }, ACTION_DEFER_MS);
            }}
          >
            💬 SMS
          </button>
          <button
            style={{ ...ui.bulkBtn, background: '#0A84FF' }}
            onClick={() => setTimeout(() => { onBulkStatus && onBulkStatus(Array.from(selectedIds || []), actionStatus); }, ACTION_DEFER_MS)}
          >
            ✅ {actionLabel}
          </button>
        </div>
      )}

      {toolsRow && (
        <div style={ui.modalOverlay} onClick={() => setToolsRow(null)}>
          <div style={ui.toolsSheet} onClick={(e) => e.stopPropagation()}>
            <div style={ui.toolsHeader}>
              <div style={{ fontWeight: '900', fontSize: 18 }}>{getName(toolsRow)}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{getAddress(toolsRow)}</div>
            </div>
            <div style={ui.toolsGrid}>
              <button style={ui.toolBtnBig} onClick={() => openMap(toolsRow)}><span style={{ fontSize: 24 }}>📍</span><span style={{ fontSize: 14 }}>MAPS</span></button>
              <button style={ui.toolBtnBig} onClick={() => callClient(toolsRow)}><span style={{ fontSize: 24 }}>📞</span><span style={{ fontSize: 14 }}>THIRR</span></button>
              <button style={ui.toolBtnBig} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onOpenSms && row && onOpenSms(row, 'transport_pikap_konfirmim'); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>💬</span><span style={{ fontSize: 14 }}>SMS</span></button>
              <button
                style={{ border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.15)', color: '#34C759', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 800, cursor: 'pointer', marginTop: 6 }}
                onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onOpenRack && row && onOpenRack(row); }, ACTION_DEFER_MS); }}
              >
                📍 RAFTI / DEPO
              </button>
              <button style={{ ...ui.toolBtnBig, background: 'rgba(255,255,255,0.06)' }} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onOpenModal && row && onOpenModal(`/transport/pranimi?id=${encodeURIComponent(row.id)}&edit=1`); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>✏️</span><span style={{ fontSize: 14 }}>EDIT</span></button>
              <button
                style={ui.toolBtnBig}
                onClick={() => {
                  const row = toolsRow;
                  setToolsRow(null);
                  setTimeout(() => {
                    if (row?.id) onBulkStatus && onBulkStatus([row.id], 'riplan');
                    onGoRiplan && onGoRiplan();
                  }, ACTION_DEFER_MS);
                }}
              >
                <span style={{ fontSize: 24 }}>⏰</span>
                <span style={{ fontSize: 14 }}>RIPLANIFIKO</span>
              </button>
              <button
                style={{ ...ui.toolBtnBig, background: '#0A84FF' }}
                onClick={() => {
                  const row = toolsRow;
                  setToolsRow(null);
                  setTimeout(() => { if (row?.id) onBulkStatus && onBulkStatus([row.id], actionStatus); }, ACTION_DEFER_MS);
                }}
              >
                <span style={{ fontSize: 24 }}>⬇️</span>
                <span style={{ fontSize: 14 }}>{actionLabel}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { NgarkimModule };