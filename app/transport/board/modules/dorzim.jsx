'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { updateTransportOrderById } from '@/lib/transportOrdersDb';
import { ui } from '@/lib/transport/board/ui';
import { getName, getCode, getAddress, getTotals, formatTime, money, pickLatLng, haversine, openMap, callClient, sendMsg } from '@/lib/transport/board/shared';

const BUCKET = 'tepiha-photos';

async function uploadPhoto(orderId, file) {
  try {
    if (!file) return null;
    const safe = String(file.name || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `transport/return/${orderId}_${Date.now()}_${safe}`;
    const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true });
    if (error) return null;
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
    return pub?.publicUrl || null;
  } catch {
    return null;
  }
}

// MODULE: DORËZIM (status: delivery)
function DorzimModule({ items, loading, selectedIds, setSelectedIds, gpsSort, setGpsSort, onBulkStatus, onOpenModal }) {
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
    try {
      const r = JSON.parse(localStorage.getItem('tp_delivery_reminders') || '{}') || {};
      const a = JSON.parse(localStorage.getItem('tp_delivery_agreements') || '{}') || {};
      setReminders(r);
      setAgreements(a);
    } catch {}
  }, []);

  function saveReminders(next) {
    setReminders(next);
    try { localStorage.setItem('tp_delivery_reminders', JSON.stringify(next || {})); } catch {}
  }

  function saveAgreements(next) {
    setAgreements(next);
    try { localStorage.setItem('tp_delivery_agreements', JSON.stringify(next || {})); } catch {}
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

  const actionLabel = 'DORËZUA';
  const actionStatus = 'done';

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
          const r = reminders?.[item.id];
          const rActive = r?.ts && isSameDay(r.ts) && r.ts > Date.now();
          const a = agreements?.[item.id];
          const aActive = a?.ts && isSameDay(a.ts) && a?.label;

          return (
            <div
              key={item.id}
              style={{ ...ui.row, ...(checked ? ui.rowSelected : null) }}
              onClick={() => {
                if (selectedCount > 0 || checked) { toggleSelect(item.id); return; }
                setToolsRow(item);
              }}
            >
              <div style={ui.rowLeft}><div style={ui.circleAvatar}>{getCode(item)}</div></div>

              <div style={ui.rowMiddle}>
                <div style={ui.rowHeader}>
                  <span style={ui.clientName}>{getName(item)}</span>
                  <span style={ui.timeStamp}>
                    {rActive ? '⏰ ' : ''}{formatTime(item.created_at)}
                  </span>
                </div>
                <div style={ui.subjectLine}>{getAddress(item) || 'Pa adresë'}</div>
                <div style={ui.previewText}>
                  {t.pieces} copë • {money(t.total)} €
                  {aActive ? ` • ${a.label}` : ''}
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
            style={{ ...ui.bulkBtn, background: '#34C759' }}
            onClick={() => onBulkStatus(Array.from(selectedIds || []), actionStatus)}
          >
            ✅ {actionLabel}
          </button>
        </div>
      )}

      {toolsRow && (
        <div style={ui.modalOverlay} onClick={() => { setNoShowOpen(false); setToolsRow(null); }}>
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
                style={{ ...ui.toolBtnBig, background: '#FF9F0A' }}
                onClick={() => openReturn(toolsRow)}
              >
                <span style={{ fontSize: 24, lineHeight: 1 }}>↩️</span>
                <span style={{ fontSize: 14 }}>KTHIM</span>
              </button>

              <button
                style={{ ...ui.toolBtnBig, background: '#34C759' }}
                onClick={() => {
                  setToolsRow(null);
                  onBulkStatus([toolsRow.id], actionStatus);
                }}
              >
                <span style={{ fontSize: 24 }}>✅</span>
                <span style={{ fontSize: 14 }}>{actionLabel}</span>
              </button>

              <button
                style={{ ...ui.toolBtnBig, background: '#222' }}
                onClick={() => {
                  setToolsRow(null);
                  onOpenModal(`/transport/pranimi?id=${encodeURIComponent(toolsRow.id)}&focus=pay`);
                }}
              >
                <span style={{ fontSize: 24 }}>💵</span>
                <span style={{ fontSize: 14 }}>PAGUJ</span>
              </button>

              <button
                style={{ ...ui.toolBtnBig, background: 'rgba(255,255,255,0.06)' }}
                onClick={() => {
                  setToolsRow(null);
                  onOpenModal(`/transport/pranimi?id=${encodeURIComponent(toolsRow.id)}&edit=1`);
                }}
              >
                <span style={{ fontSize: 24 }}>✏️</span>
                <span style={{ fontSize: 14 }}>EDIT</span>
              </button>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button style={ui.btnSmall} onClick={() => sendMsg(toolsRow, 'eta30')}>30 MIN</button>
              <button style={ui.btnSmall} onClick={() => sendMsg(toolsRow, 'eta20')}>20 MIN</button>
              <button style={ui.btnSmall} onClick={() => sendMsg(toolsRow, 'eta10')}>10 MIN</button>
              <button style={ui.btnSmall} onClick={() => sendMsg(toolsRow, 'door')}>TEK DERA</button>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button style={ui.btnSmall} onClick={() => setReminder(toolsRow.id, 10)}>⏰ 10</button>
              <button style={ui.btnSmall} onClick={() => setReminder(toolsRow.id, 30)}>⏰ 30</button>
              <button style={ui.btnSmall} onClick={() => clearReminder(toolsRow.id)}>⏰ HIQ</button>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button style={ui.btnSmall} onClick={() => { setAgreement(toolsRow.id, 'VJEN POSHTË'); }}>VJEN POSHTË</button>
              <button style={ui.btnSmall} onClick={() => { setAgreement(toolsRow.id, 'TEK DERA'); }}>TEK DERA</button>
              <button style={ui.btnSmall} onClick={() => { setAgreement(toolsRow.id, 'S\'ESHT N\'SHTËPI'); }}>S'ESHT</button>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button style={ui.btnSmall} onClick={() => sendMsg(toolsRow, 'wait5')}>PRIT 5</button>
              <button style={ui.btnSmall} onClick={() => sendMsg(toolsRow, 'wait10')}>PRIT 10</button>
              <button style={{ ...ui.btnSmall, background: 'rgba(255,59,48,0.18)', borderColor: 'rgba(255,59,48,0.35)' }} onClick={() => setNoShowOpen(true)}>NO-SHOW</button>
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
                      onBulkStatus([toolsRow.id], 'gati');
                      setToolsRow(null);
                    }}
                  >NUK PËRGJIGJET</button>
                  <button
                    style={ui.btnSmall}
                    onClick={() => {
                      setNoShowOpen(false);
                      sendMsg(toolsRow, 'noshow');
                      onBulkStatus([toolsRow.id], 'gati');
                      setToolsRow(null);
                    }}
                  >S'ESHT N'SHTEPI</button>
                  <button
                    style={ui.btnSmall}
                    onClick={() => {
                      setNoShowOpen(false);
                      sendMsg(toolsRow, 'noshow');
                      onBulkStatus([toolsRow.id], 'gati');
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
        <div style={ui.modalOverlay} onClick={() => setShowReturn(false)}>
          <div style={{ ...ui.toolsSheet, margin: 'auto', maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
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
                    const nextData = { ...prev, kthim: { at: Date.now(), from: 'delivery', reason: String(retReason || '').trim(), photo: photoUrl || null } };
                    try {
                      await updateTransportOrderById(toolsRow.id, { status: 'loaded', data: nextData });
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
