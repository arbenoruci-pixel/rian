'use client';

import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { supabase, storageWithTimeout } from '@/lib/supabaseClient';
import { updateTransportOrderById } from '@/lib/transportOrdersDb';
import { ui } from '@/lib/transport/board/ui';
import { useRenderBatches } from '@/lib/renderBatching';
import { getName, getCode, getAddress, getTotals, formatTime, money, pickLatLng, haversine, openMap, callClient } from '@/lib/transport/board/shared';

const BOARD_RENDER_LIMIT = 50;
const ACTION_DEFER_MS = 300;
const STORAGE_DEFER_MS = 250;

function transportCode(raw) { const s = String(raw || '').trim().replace(/^#+/, ''); if (!s) return 'T—'; if (/^\d+$/.test(s)) return `#${s}`; return /^T/i.test(s) ? s.replace(/^T[-\s]*/i, 'T') : `T${s}`; }
function orderAssignedDriver(o) { return String(o?.actor || o?.data?.actor || o?.driver_name || o?.data?.driver_name || '').trim(); }
const transportCodeCircle = { width: 36, minWidth: 36, height: 36, marginRight: 6, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#39d86f', color: '#03140a', fontSize: 12, fontWeight: 1000, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 16px rgba(57,216,111,0.18)' };
const pillBase = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', borderRadius: 999, fontSize: 10, fontWeight: 900, letterSpacing: 0.5, textTransform: 'uppercase' };
const cardLabelStyle = { color: 'rgba(255,255,255,0.58)', fontSize: 10.5, fontWeight: 950, letterSpacing: 0.8, textTransform: 'uppercase' };
const cardAddressStyle = { color: '#f8fafc', fontSize: 13.5, fontWeight: 900, lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const cardFooterStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 2, flexWrap: 'wrap' };
const openPillStyle = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 76, height: 30, padding: '0 12px', borderRadius: 999, background: 'linear-gradient(180deg, rgba(59,130,246,0.26), rgba(37,99,235,0.18))', border: '1px solid rgba(96,165,250,0.30)', color: '#dbeafe', fontSize: 11, fontWeight: 950, letterSpacing: 0.2, boxShadow: '0 6px 16px rgba(30,64,175,0.24)', whiteSpace: 'nowrap' };
function cleanAddressLine(value) {
  const raw = String(value || '').trim();
  if (!raw || /pa adres|adresë jo e ruajtur|adrese jo e ruajtur/i.test(raw)) return '';
  return raw;
}

const BUCKET = 'tepiha-photos';

async function uploadPhoto(orderId, file) {
  try {
    if (!file) return null;
    const safe = String(file.name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `transport/return/${orderId}_${Date.now()}_${safe}`;
    const { data, error } = await storageWithTimeout(supabase.storage.from(BUCKET).upload(path, file, { upsert: true }), 9000, 'TRANSPORT_DORZIM_PHOTO_UPLOAD_TIMEOUT', { bucket: BUCKET, path });
    if (error) return null;
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
    return pub?.publicUrl || null;
  } catch {
    return null;
  }
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


function getPaySummary(row) {
  const data = row?.data || {};
  const totals = getTotals(row);
  const total = Number(totals?.total || data?.totals?.grandTotal || data?.pay?.euro || 0);
  const paid = Number(data?.pay?.paid || 0);
  const due = Math.max(0, Number((total - paid).toFixed(2)));
  return { total, paid, due };
}

// MODULE: DORËZIM (status: delivery)
function DorzimModule({ items, loading, selectedIds, setSelectedIds, gpsSort, setGpsSort, onBulkStatus, onOpenModal, onOpenSms, onOpenRack, onMarkSeen, getUnseenRowStyle, renderUnseenBadge }) {
  const [toolsRow, setToolsRow] = useState(null);
  const [showReturn, setShowReturn] = useState(false);
  const [retReason, setRetReason] = useState('');
  const [retPhoto, setRetPhoto] = useState(null);
  const [savingReturn, setSavingReturn] = useState(false);

  const RETURN_REASON_CHIPS = ['KLIENTI U ANKUA','KTHIM PËR RILARJE','NUK E PRANOI','TJETER'];

  function openReturn(row) {
    setToolsRow(row);
    setRetReason('');
    setRetPhoto(null);
    setShowReturn(true);
  }

  const [reminders, setReminders] = useState({});
  const [agreements, setAgreements] = useState({});
  const [noShowOpen, setNoShowOpen] = useState(false);
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

  const isSameDay = (ts) => {
    if (!ts) return false;
    try {
      const a = new Date(ts);
      const b = new Date();
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    } catch {
      return false;
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const timer = setTimeout(() => {
      try {
        const r = JSON.parse(localStorage.getItem('tp_delivery_reminders') || '{}') || {};
        const a = JSON.parse(localStorage.getItem('tp_delivery_agreements') || '{}') || {};
        setReminders(r);
        setAgreements(a);
      } catch {}
    }, 350);
    return () => clearTimeout(timer);
  }, []);

  function saveReminders(next) {
    setReminders(next);
    setTimeout(() => {
      try { localStorage.setItem('tp_delivery_reminders', JSON.stringify(next || {})); } catch {}
    }, STORAGE_DEFER_MS);
  }

  function saveAgreements(next) {
    setAgreements(next);
    setTimeout(() => {
      try { localStorage.setItem('tp_delivery_agreements', JSON.stringify(next || {})); } catch {}
    }, STORAGE_DEFER_MS);
  }

  function setReminder(rowId, minutes) {
    const ts = Date.now() + minutes * 60 * 1000;
    const next = { ...(reminders || {}), [rowId]: { ts, minutes, set_at: Date.now() } };
    saveReminders(next);
    alert(`Reminder u vendos: ${minutes} MIN`);
  }

  function clearReminder(rowId) {
    const next = { ...(reminders || {}) };
    delete next[rowId];
    saveReminders(next);
  }

  function setAgreement(rowId, label) {
    const next = { ...(agreements || {}), [rowId]: { label, ts: Date.now() } };
    saveAgreements(next);
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

  const actionLabel = 'DORËZUA';
  const actionStatus = 'done';

  return (
    <>
      <div style={ui.listContainer}>

        {loading && <div style={ui.centerMsg}>Duke ngarkuar...</div>}
        {!loading && sortedItems.length === 0 && <div style={ui.centerMsg}>S'ka porosi.</div>}

        {visibleItems.map((item) => {
          const t = getTotals(item);
          const pay = getPaySummary(item);
          const checked = selectedIds?.has(item.id);
          const r = reminders?.[item.id];
          const rActive = r?.ts && isSameDay(r.ts) && r.ts > Date.now();
          const a = agreements?.[item.id];
          const aActive = a?.ts && isSameDay(a.ts) && a?.label;
          const unseenStyle = getUnseenRowStyle ? getUnseenRowStyle(item) : null;
          const address = cleanAddressLine(getAddress(item));
          const paymentText = pay.due > 0 ? `PËR PAGESË: ${money(pay.due)} €` : 'PAGUAR ✓';

          return (
            <div
              key={item.id}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, marginBottom: 8, borderRadius: 16, border: '1px solid rgba(245,158,11,0.50)', background: 'linear-gradient(180deg, rgba(245,158,11,0.11), rgba(245,158,11,0.04))', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.22)', textAlign: 'left', cursor: 'pointer', ...(unseenStyle || null), ...(checked ? ui.rowSelected : null) }}
              onClick={() => {
                if (selectedCount > 0 || checked) { toggleSelect(item.id); return; }
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
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ffffff', fontSize: 15, fontWeight: 950, letterSpacing: 0.2 }}>{getName(item)}</span>
                    <span style={{ ...pillBase, background: 'rgba(59,130,246,0.16)', color: '#bfdbfe', border: '1px solid rgba(59,130,246,0.30)', whiteSpace: 'nowrap' }}>PËR DORËZIM</span>
                  </div>

                  <div style={cardLabelStyle}>ADRESA</div>
                  <div style={cardAddressStyle}>{address || 'PA ADRESË'}</div>

                  {aActive ? <div style={{ color: '#93c5fd', fontSize: 11, fontWeight: 900 }}>KONFIRMIM: {a.label}</div> : null}

                  <div style={cardFooterStyle}>
                    <span style={{ color: 'rgba(255,255,255,0.70)', fontSize: 12, fontWeight: 900 }}>{t.pieces} copë • {money(t.total)} €</span>
                    <span style={{ color: pay.due > 0 ? '#fbbf24' : '#86efac', fontSize: 12, fontWeight: 950 }}>{rActive ? '⏰ ' : ''}{paymentText}</span>
                    <span style={openPillStyle}>HAP ➔</span>
                  </div>
                </div>
              </div>

              <div style={ui.rowRight} onClick={(e) => e.stopPropagation()}>
                <button style={checked ? ui.checkOn : ui.checkOff} onClick={() => toggleSelect(item.id)} aria-label="select" title="select">
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
              setTimeout(() => { onOpenSms && onOpenSms(row, 'transport_dorzim'); }, ACTION_DEFER_MS);
            }}
          >
            💬 SMS
          </button>
          <button
            style={{ ...ui.bulkBtn, background: '#34C759' }}
            onClick={() => setTimeout(() => {
              const picked = sortedItems.filter((x) => (selectedIds || new Set()).has(x.id));
              const unpaid = picked.filter((x) => getPaySummary(x).due > 0);
              if (unpaid.length) {
                const first = unpaid[0];
                alert('PA U KRYER PAGESA, POROSIA NUK MUND TË DORËZOHET. HAPET PAGESA.');
                onOpenModal && onOpenModal(`/transport/pranimi?id=${encodeURIComponent(first.id)}&focus=pay`);
                return;
              }
              onBulkStatus && onBulkStatus(Array.from(selectedIds || []), actionStatus);
            }, ACTION_DEFER_MS)}
          >
            ✅ {actionLabel}
          </button>
        </div>
      )}

      {toolsRow && (
        <div style={{ ...ui.modalOverlay, justifyContent: 'center', alignItems: 'center', padding: 16 }} onClick={() => { setNoShowOpen(false); setToolsRow(null); }}>
          <div style={{ ...ui.toolsSheet, width: 'min(760px, 100%)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', borderRadius: 22 }} onClick={(e) => e.stopPropagation()}>
            <div style={ui.toolsHeader}>
              <div style={{ fontWeight: '900', fontSize: 18 }}>{getName(toolsRow)}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{getAddress(toolsRow)}</div>
            </div>
            <div style={ui.toolsGrid}>
              <button style={ui.toolBtnBig} onClick={() => openMap(toolsRow)}><span style={{ fontSize: 24 }}>📍</span><span style={{ fontSize: 14 }}>MAPS</span></button>
              <button style={ui.toolBtnBig} onClick={() => callClient(toolsRow)}><span style={{ fontSize: 24 }}>📞</span><span style={{ fontSize: 14 }}>THIRR</span></button>
              <button style={ui.toolBtnBig} onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onOpenSms && row && onOpenSms(row, 'transport_dorzim'); }, ACTION_DEFER_MS); }}><span style={{ fontSize: 24 }}>💬</span><span style={{ fontSize: 14 }}>SMS</span></button>
              <button
                style={{ ...ui.toolBtnBig, background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', color: '#34C759' }}
                onClick={() => { const row = toolsRow; setToolsRow(null); setTimeout(() => { onOpenRack && row && onOpenRack(row); }, ACTION_DEFER_MS); }}
              ><span style={{ fontSize: 24 }}>📍</span><span style={{ fontSize: 14 }}>RAFTI</span></button>
              <button
                style={{ ...ui.toolBtnBig, background: '#FF9F0A' }}
                onClick={() => openReturn(toolsRow)}
              >
                <span style={{ fontSize: 14, lineHeight: 1 }}>↩️</span>
                <span style={{ fontSize: 14 }}>KTHIM</span>
              </button>

              <button
                style={{ ...ui.toolBtnBig, background: '#34C759' }}
                onClick={() => {
                  const row = toolsRow;
                  const due = getPaySummary(row).due;
                  setToolsRow(null);
                  setTimeout(() => {
                    if (!row?.id) return;
                    if (due > 0) {
                      alert('PA U KRYER PAGESA, POROSIA NUK MUND TË MBYLLET. HAPET PAGESA.');
                      onOpenModal && onOpenModal(`/transport/pranimi?id=${encodeURIComponent(row.id)}&focus=pay`);
                      return;
                    }
                    onBulkStatus && onBulkStatus([row.id], actionStatus);
                  }, ACTION_DEFER_MS);
                }}
              >
                <span style={{ fontSize: 24 }}>✅</span>
                <span style={{ fontSize: 14 }}>{actionLabel}</span>
              </button>

              <button
                style={{ ...ui.toolBtnBig, background: '#222' }}
                onClick={() => {
                  const row = toolsRow;
                  setToolsRow(null);
                  setTimeout(() => { row && onOpenModal(`/transport/pranimi?id=${encodeURIComponent(row.id)}&focus=pay`); }, ACTION_DEFER_MS);
                }}
              >
                <span style={{ fontSize: 24 }}>💵</span>
                <span style={{ fontSize: 14 }}>PAGUJ</span>
              </button>

              <button
                style={{ ...ui.toolBtnBig, background: 'rgba(255,255,255,0.06)' }}
                onClick={() => {
                  const row = toolsRow;
                  setToolsRow(null);
                  setTimeout(() => { row && onOpenModal(`/transport/pranimi?id=${encodeURIComponent(row.id)}&edit=1`); }, ACTION_DEFER_MS);
                }}
              >
                <span style={{ fontSize: 24 }}>✏️</span>
                <span style={{ fontSize: 14 }}>EDIT</span>
              </button>
            </div>

            <div style={{ marginTop: 12, fontSize: 12, opacity: 0.76 }}>
              DORËZIMI FINAL kryhet vetëm pasi pagesa të jetë regjistruar. Nëse ka borxh, hapet PAGUAJ.
            </div>

            {noShowOpen && (
              <div style={{ marginTop: 10, padding: 10, borderRadius: 12, background: 'rgba(255,255,255,0.06)' }}>
                <div style={{ fontWeight: '800', marginBottom: 8 }}>PSE DESHTOI DORËZIMI?</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    style={ui.btnSmall}
                    onClick={() => {
                      setNoShowOpen(false);
                      sendMsg(toolsRow, 'noshow');
                      setTimeout(() => { onBulkStatus && onBulkStatus([toolsRow.id], 'gati'); }, ACTION_DEFER_MS);
                      setToolsRow(null);
                    }}
                  >NUK PËRGJIGJET</button>
                  <button
                    style={ui.btnSmall}
                    onClick={() => {
                      setNoShowOpen(false);
                      sendMsg(toolsRow, 'noshow');
                      setTimeout(() => { onBulkStatus && onBulkStatus([toolsRow.id], 'gati'); }, ACTION_DEFER_MS);
                      setToolsRow(null);
                    }}
                  >S'ESHT N'SHTEPI</button>
                  <button
                    style={ui.btnSmall}
                    onClick={() => {
                      setNoShowOpen(false);
                      sendMsg(toolsRow, 'noshow');
                      setTimeout(() => { onBulkStatus && onBulkStatus([toolsRow.id], 'gati'); }, ACTION_DEFER_MS);
                      setToolsRow(null);
                    }}
                  >ADRESA GABIM</button>
                  <button style={ui.btnSmall} onClick={() => setNoShowOpen(false)}>MSH</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showReturn && toolsRow && (
        <div style={{ ...ui.modalOverlay, justifyContent: 'center', alignItems: 'center', padding: 16 }} onClick={() => setShowReturn(false)}>
          <div style={{ ...ui.toolsSheet, width: 'min(760px, 100%)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', borderRadius: 22 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 6 }}>KTHIM NGA KLIENTI</div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 12 }}>{getName(toolsRow)} • {getCode(toolsRow)}</div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {RETURN_REASON_CHIPS.map((x) => (
                <button key={x} style={{ ...ui.chip, padding: '8px 10px', fontWeight: 900 }} onClick={() => setRetReason((p) => (p ? p + ' • ' + x : x))}>{x}</button>
              ))}
            </div>

            <div>
              <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 6 }}>ARSYEJA</div>
              <textarea value={retReason} onChange={(e) => setRetReason(e.target.value)} placeholder="p.sh. ANKESË — DUHET RILARJE" style={{ ...ui.input, height: 70, resize: 'none' }} />
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 6 }}>FOTO (opsionale)</div>
              <input type="file" accept="image/*" onChange={(e) => setRetPhoto(e.target.files?.[0] || null)} style={{ width: '100%' }} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                style={{ ...ui.btnPrimary, flex: 1, opacity: savingReturn ? 0.6 : 1 }}
                onClick={async () => {
                  try {
                    setSavingReturn(true);
                    const photoUrl = await uploadPhoto(toolsRow.id, retPhoto);
                    const prev = toolsRow?.data || {};
                    const nowIso = new Date().toISOString();
                    const nextData = {
                      ...prev,
                      status: 'loaded',
                      loaded_at: prev?.loaded_at || nowIso,
                      kthim: { at: Date.now(), from: 'delivery', reason: String(retReason || '').trim(), photo: photoUrl || null },
                    };
                    try {
                      await updateTransportOrderById(toolsRow.id, { status: 'loaded', updated_at: nowIso, data: nextData });
                    } catch (e) {
                      alert('Gabim: ' + String(e?.message || e));
                    }
                    setShowReturn(false);
                    setToolsRow(null);
                  } finally {
                    setSavingReturn(false);
                  }
                }}
              >KTHE NË NGARKUAR</button>
              <button style={{ ...ui.btnSecondary, flex: 1 }} onClick={() => setShowReturn(false)}>ANULO</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { DorzimModule };
