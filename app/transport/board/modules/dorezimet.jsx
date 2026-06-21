'use client';

import React, { useDeferredValue, useMemo, useState } from 'react';
import { ui } from '@/lib/transport/board/ui';
import { useRenderBatches } from '@/lib/renderBatching';
import { getName, getCode, getAddress, getTotals, formatTime, money, openMap, callClient } from '@/lib/transport/board/shared';

const BOARD_RENDER_LIMIT = 50;
const ACTION_DEFER_MS = 300;

function transportCode(raw) {
  const s = String(raw || '').trim().replace(/^#+/, '');
  if (!s) return 'T—';
  if (/^\d+$/.test(s)) return `#${s}`;
  return /^T/i.test(s) ? s.replace(/^T[-\s]*/i, 'T') : `T${s}`;
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
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 16px rgba(57,216,111,0.18)',
};

const pillBase = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '4px 8px',
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 900,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
};

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

function getPaySummary(row) {
  const data = row?.data || {};
  const t = getTotals(row);
  const total = Number(t?.total || data?.totals?.grandTotal || data?.pay?.euro || 0);
  const paid = Number(data?.pay?.paid || 0);
  const due = Math.max(0, Number((total - paid).toFixed(2)));
  return { total, paid, due };
}

function deliveredAt(row) {
  return row?.data?.delivered_at || row?.updated_at || row?.created_at || null;
}

function safeDeliveredTs(row) {
  try {
    const ts = new Date(deliveredAt(row)).getTime();
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

function DeliveredModule({ items, loading, onOpenModal, onMarkSeen, getUnseenRowStyle, renderUnseenBadge }) {
  const [toolsRow, setToolsRow] = useState(null);
  const deferredItems = useDeferredValue(items);
  const sortedItems = useMemo(() => Array.isArray(deferredItems) ? deferredItems.slice(0, BOARD_RENDER_LIMIT).sort((a, b) => safeDeliveredTs(b) - safeDeliveredTs(a)) : [], [deferredItems]);
  const { visibleItems, remainingCount, renderMore } = useRenderBatches(sortedItems, { initial: 12, step: 10, pulseMs: 80, limit: BOARD_RENDER_LIMIT });

  return (
    <>
      <div style={ui.listContainer}>
        {loading && <div style={ui.centerMsg}>Duke ngarkuar...</div>}
        {!loading && sortedItems.length === 0 && <div style={ui.centerMsg}>S'ka dorëzime për këtë ditë.</div>}

        {visibleItems.map((item) => {
          const t = getTotals(item);
          const pay = getPaySummary(item);
          const unseenStyle = getUnseenRowStyle ? getUnseenRowStyle(item) : null;
          const payLabel = pay.due > 0 ? `BORXH: ${money(pay.due)} €` : `PAGUAR: ${money(pay.paid || pay.total)} €`;
          return (
            <div
              key={item.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: 10, marginBottom: 8, borderRadius: 16,
                border: '1px solid rgba(52,199,89,0.45)', background: 'linear-gradient(180deg, rgba(52,199,89,0.10), rgba(52,199,89,0.04))',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.22)', textAlign: 'left', cursor: 'pointer', ...(unseenStyle || null),
              }}
              onClick={() => {
                setTimeout(() => {
                  onMarkSeen && onMarkSeen(item?.id);
                  setToolsRow(item);
                }, ACTION_DEFER_MS);
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0, flex: 1 }}>
                <div style={transportCodeCircle}>{transportCode(getCode(item))}</div>
                <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ffffff', fontSize: 15, fontWeight: 950 }}>{getName(item)}</span>
                    <span style={{ ...pillBase, background: 'rgba(52,199,89,0.18)', color: '#86efac', border: '1px solid rgba(52,199,89,0.35)', whiteSpace: 'nowrap' }}>DORËZUAR ✓</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: '#fbbf24', fontWeight: 950, fontSize: 12 }}>{t.pieces} copë • {money(t.total)} €</span>
                    <span style={{ color: pay.due > 0 ? '#fbbf24' : '#86efac', fontWeight: 950, fontSize: 12 }}>{payLabel}</span>
                  </div>
                  <div style={{ color: 'rgba(255,255,255,0.62)', fontSize: 11.5, fontWeight: 900 }}>ORA: {formatTime(deliveredAt(item))}</div>
                  <div style={{ color: 'rgba(255,255,255,0.42)', fontSize: 11, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getAddress(item)}</div>
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
              <button style={ui.toolBtnBig} onClick={() => openMap(toolsRow)}><span style={{ fontSize: 24 }}>📍</span><span style={{ fontSize: 14 }}>MAPS</span></button>
              <button style={ui.toolBtnBig} onClick={() => callClient(toolsRow)}><span style={{ fontSize: 24 }}>📞</span><span style={{ fontSize: 14 }}>THIRR</span></button>
              <button style={{ ...ui.toolBtnBig, background: '#222' }} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { row && onOpenModal(`/transport/pranimi?id=${encodeURIComponent(row.id)}&focus=pay`); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>💵</span><span style={{ fontSize: 14 }}>PAGUJ</span></button>
              <button style={{ ...ui.toolBtnBig, background: 'rgba(255,255,255,0.06)' }} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { row && onOpenModal(`/transport/pranimi?id=${encodeURIComponent(row.id)}&edit=1`); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>✏️</span><span style={{ fontSize: 14 }}>EDIT</span></button>
            </div>
            <div style={{ marginTop: 12, fontSize: 12, opacity: 0.76 }}>Lista e dorëzimeve të kryera për ditën e zgjedhur.</div>
          </div>
        </div>
      )}
    </>
  );
}

export { DeliveredModule };
