'use client';

import React, { useState } from 'react';
import { ui } from '@/lib/transport/board/ui';
import { getName, getCode, getAddress, getTotals, formatTime, money, openMap, callClient, sendMsg } from '@/lib/transport/board/shared';

// MODULE: TË REJA (dispatched + pickup)
function InboxModule({ items, loading, onOpenModal }) {
  const [toolsRow, setToolsRow] = useState(null);

  return (
    <>
      <div style={ui.listContainer}>
        {loading && <div style={ui.centerMsg}>Duke ngarkuar...</div>}
        {!loading && (items?.length || 0) === 0 && <div style={ui.centerMsg}>S'ka porosi.</div>}

        {(items || []).map((item) => {
          const t = getTotals(item);
          return (
            <div key={item.id} style={ui.row} onClick={() => setToolsRow(item)}>
              <div style={ui.rowLeft}><div style={ui.circleAvatar}>{getCode(item)}</div></div>
              <div style={ui.rowMiddle}>
                <div style={ui.rowHeader}>
                  <span style={ui.clientName}>{getName(item)}</span>
                  <span style={ui.timeStamp}>{formatTime(item.created_at)}</span>
                </div>
                <div style={ui.subjectLine}>{getAddress(item) || 'Pa adresë'}</div>
                <div style={ui.previewText}>{t.pieces} copë • {money(t.total)} €</div>
              </div>
            </div>
          );
        })}

        <div style={{ height: 140 }} />
      </div>

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
              <button style={{ ...ui.toolBtnBig, background: '#34C759' }} onClick={() => { setToolsRow(null); onOpenModal(`/transport/pranimi?id=${encodeURIComponent(toolsRow.id)}`); }}>
                <span style={{ fontSize: 24 }}>🚛</span><span style={{ fontSize: 14 }}>PRANO</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { InboxModule };
