'use client';

import React, { useMemo, useState } from 'react';
import { ui } from '@/lib/transport/board/ui';
import { getName, getCode, getAddress, getTotals, formatTime, money, pickLatLng, haversine, openMap, callClient, sendMsg } from '@/lib/transport/board/shared';

// MODULE: NGARKIM (status: loaded)
function NgarkimModule({ items, loading, selectedIds, setSelectedIds, gpsSort, setGpsSort, onBulkStatus, onGoRiplan }) {
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

  const sortedItems = useMemo(() => {
    const list = Array.isArray(items) ? items : [];
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
  }, [items, gpsSort]);

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

        {sortedItems.map((item) => {
          const t = getTotals(item);
          const checked = selectedIds?.has(item.id);

          return (
            <div
              key={item.id}
              style={{ ...ui.row, ...(checked ? ui.rowSelected : null) }}
              onClick={() => setToolsRow(item)}
            >
              <div style={ui.rowLeft}><div style={ui.circleAvatar}>{getCode(item)}</div></div>

              <div style={ui.rowMiddle}>
                <div style={ui.rowHeader}>
                  <span style={ui.clientName}>{getName(item)}</span>
                  <span style={ui.timeStamp}>{formatTime(item.created_at)}</span>
                </div>
                <div style={ui.subjectLine}>{getAddress(item) || 'Pa adresë'}</div>
                <div style={ui.previewText}>{t.pieces} copë • {money(t.total)} €</div>
              </div>

              <div style={ui.rowRight} onClick={(e) => e.stopPropagation()}>
                <button style={checked ? ui.checkOn : ui.checkOff} onClick={() => toggleSelect(item.id)} aria-label='select' title='select'>
                  {checked ? '✓' : ''}
                </button>
              </div>
            </div>
          );
        })}

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
              sendMsg(row, 'delivery');
            }}
          >
            💬 SMS
          </button>
          <button
            style={{ ...ui.bulkBtn, background: '#0A84FF' }}
            onClick={() => onBulkStatus(Array.from(selectedIds || []), actionStatus)}
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
              <button style={ui.toolBtnBig} onClick={() => { setToolsRow(null); sendMsg(toolsRow, 'delivery'); }}><span style={{ fontSize: 24 }}>💬</span><span style={{ fontSize: 14 }}>SMS</span></button>
              <button
                style={ui.toolBtnBig}
                onClick={() => {
                  setToolsRow(null);
                  onBulkStatus([toolsRow.id], 'riplan');
                  onGoRiplan && onGoRiplan();
                }}
              >
                <span style={{ fontSize: 24 }}>⏰</span>
                <span style={{ fontSize: 14 }}>RIPLANIFIKO</span>
              </button>
              <button
                style={{ ...ui.toolBtnBig, background: '#0A84FF' }}
                onClick={() => {
                  setToolsRow(null);
                  onBulkStatus([toolsRow.id], actionStatus);
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