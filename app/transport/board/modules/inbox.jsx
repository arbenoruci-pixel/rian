'use client';

import React, { useState } from 'react';
import { ui } from '@/lib/transport/board/ui';
import { getName, getCode, getAddress, getTotals, formatTime, money, openMap, callClient, sendMsg } from '@/lib/transport/board/shared';

// MODULE: TË REJA (dispatched + pickup)
function InboxModule({ items, loading, onOpenModal, actorRole, transportUsers, onAssign }) {
  const [toolsRow, setToolsRow] = useState(null);
  const [assignPin, setAssignPin] = useState('');

  const canAssign = String(actorRole || '').toUpperCase() === 'ADMIN' || String(actorRole || '').toUpperCase() === 'DISPATCH';

  function pickUserByPin(pin) {
    const p = String(pin || '').trim();
    return (transportUsers || []).find((u) => String(u?.pin || '').trim() === p) || null;
  }

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

            {canAssign && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, opacity: 0.7, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase' }}>
                  CAKTO TE TRANSPORTUSI
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <select
                    value={assignPin}
                    onChange={(e) => setAssignPin(e.target.value)}
                    style={{ flex: 1, padding: 10, borderRadius: 10, background: 'rgba(0,0,0,.35)', color: '#fff', border: '1px solid rgba(255,255,255,.14)' }}
                  >
                    <option value="">ZGJIDH TRANSPORTUSIN…</option>
                    {(transportUsers || []).map((u) => (
                      <option key={u.id || u.pin} value={String(u.pin || '')}>
                        {String(u.name || 'TRANSPORT').toUpperCase()}
                      </option>
                    ))}
                  </select>
                  <button
                    style={{ ...ui.btnPrimary, padding: '10px 12px', borderRadius: 10, fontWeight: 900 }}
                    onClick={() => {
                      const u = pickUserByPin(assignPin);
                      if (!u) return;
                      try { onAssign && onAssign(toolsRow, u); } catch {}
                      setToolsRow(null);
                      setAssignPin('');
                    }}
                  >
                    CAKTO
                  </button>
                </div>
                <div style={{ marginTop: 6, fontSize: 11, opacity: 0.6, textTransform: 'uppercase' }}>
                  (PIN NUK SHFAQET — VETËM EMRI)
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export { InboxModule };
