'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { updateTransportOrderById } from '@/lib/transportOrdersDb';
import { ui } from '@/lib/transport/board/ui';
import { getName, getCode, getAddress, getPhone, getTotals, formatTime, money, pickLatLng, haversine, openMap, sendMsg } from '@/lib/transport/board/shared';

function toLocalDateValue(d) {
  try {
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    const yyyy = x.getFullYear();
    const mm = String(x.getMonth() + 1).padStart(2, '0');
    const dd = String(x.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return '';
  }
}

function toLocalTimeValue(d) {
  try {
    const x = new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    const hh = String(x.getHours()).padStart(2, '0');
    const mi = String(x.getMinutes()).padStart(2, '0');
    return `${hh}:${mi}`;
  } catch {
    return '';
  }
}

function getReadyAt(row) {
  const d = row?.data || row?.order || row || {};
  return row?.ready_at || d?.ready_at || row?.updated_at || d?.updated_at || null;
}

function ageDaysSince(d) {
  try {
    if (!d) return 0;
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return 0;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = 24 * 60 * 60 * 1000;
    const when = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
    return Math.max(0, Math.floor((start - when) / day));
  } catch {
    return 0;
  }
}

function rowAgingStyle(row) {
  const days = ageDaysSince(getReadyAt(row));
  // Day0 green, Day1 orange, Day2+ red
  if (days <= 0) return { background: "rgba(0, 200, 0, 0.18)" };
  if (days === 1) return { background: "rgba(255, 165, 0, 0.22)" };
  return { background: "rgba(255, 0, 0, 0.18)" };
}

function getRiplanAt(row) {
  const d = row?.data || row?.order || row || {};
  
  const routeTotals = useMemo(() => {
    const list = Array.isArray(routeItems) ? routeItems : [];
    return list.reduce((acc, it) => {
      const t = getTotals(it);
      acc.count += 1;
      acc.pieces += Number(t.pieces || 0);
      acc.m2 += Number(t.m2 || 0);
      acc.total += Number(t.total || 0);
      return acc;
    }, { count: 0, pieces: 0, m2: 0, total: 0 });
  }, [routeItems]);

  const zoneSummary = useMemo(() => {
    const list = Array.isArray(routeItems) ? routeItems : [];
    const map = {};
    for (const it of list) {
      const z = parseZone(getAddress(it));
      const t = getTotals(it);
      if (!map[z]) map[z] = { count: 0, m2: 0 };
      map[z].count += 1;
      map[z].m2 += Number(t.m2 || 0);
    }
    return Object.entries(map).sort((a, b) => b[1].count - a[1].count);
  }, [routeItems]);

return (
    row?.riplan_at ||
    row?.reschedule_at ||
    d?.riplan_at ||
    d?.reschedule_at ||
    d?.riplan?.at ||
    d?.schedule_at ||
    null
  );
}

function getRiplanNote(row) {
  const d = row?.data || row?.order || row || {};
  return String(row?.riplan_note || d?.riplan_note || d?.reschedule_note || d?.riplan?.note || '').trim();
}

function ReadyView({ items, loading, geo, onOpenModal, onBulkStatus, onGoDorzo }) {
  const [selectionMode, setSelectionMode] = useState(false);

  const sortedItems = useMemo(() => {
    const list = Array.isArray(items) ? [...items] : [];
    // newest-ready first? We prefer oldest-ready first to clear backlog
    list.sort((a, b) => {
      const da = new Date(getReadyAt(a) || 0).getTime();
      const db = new Date(getReadyAt(b) || 0).getTime();
      return da - db;
    });
    return list;
  }, [items]);

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showRoute, setShowRoute] = useState(false);
  const [gpsOrigin, setGpsOrigin] = useState(null);
  const [capM2, setCapM2] = useState(35); // default capacity

  const [showBulk, setShowBulk] = useState(false);
  const [routeItems, setRouteItems] = useState([]);
  const [toolsRow, setToolsRow] = useState(null);
  const [showRiplan, setShowRiplan] = useState(false);
  const [rDate, setRDate] = useState('');
  const [rTime, setRTime] = useState('');
  const [rNote, setRNote] = useState('');
  const [rRemind30, setRRemind30] = useState(true);

  const [showKthim, setShowKthim] = useState(false);
  const [kReason, setKReason] = useState('');
  const [kPhoto, setKPhoto] = useState('');
  const [savingKthim, setSavingKthim] = useState(false);
  const [savingRiplan, setSavingRiplan] = useState(false);

  const riplanInputStyle = {
    width: '100%',
    padding: '12px 12px',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.06)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.12)',
    outline: 'none',
    fontWeight: 800,
    fontSize: 12,
    textTransform: 'uppercase'
  };

  const riplanBtnGhost = {
    flex: 1,
    padding: '12px 12px',
    borderRadius: 14,
    background: 'rgba(255,255,255,0.06)',
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.10)',
    fontWeight: 900,
    textTransform: 'uppercase',
    fontSize: 12
  };

  const riplanBtn = {
    flex: 1,
    padding: '12px 12px',
    borderRadius: 14,
    background: 'rgba(10,132,255,0.25)',
    color: '#fff',
    border: '1px solid rgba(10,132,255,0.55)',
    fontWeight: 900,
    textTransform: 'uppercase',
    fontSize: 12
  };

  useEffect(() => {
    if (!selectionMode) setSelectedIds(new Set());
  }, [items?.length, selectionMode]);

  function toggleSelection(id) {
    const next = new Set(selectedIds || []);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  }

  function selectAll() {
    const ids = Array.isArray(items) ? items.map(r => r.id).filter(Boolean) : [];
    setSelectedIds(new Set(ids));
  }

  function prepareActionItems() {
    let target = [];
    if ((selectedIds?.size || 0) > 0) target = (items || []).filter(i => selectedIds.has(i.id));
    else target = [...(items || [])];

    if (geo) {
      target.sort((a, b) => haversine(geo, pickLatLng(a)) - haversine(geo, pickLatLng(b)));
    }
    setRouteItems(target);
  }

    async function askGpsOrigin() {
    if (!navigator?.geolocation) {
      alert('GPS nuk eshte i disponueshem ne kete pajisje.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setGpsOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert("S'u lejua GPS. Hap Settings > Location."),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  function parseZone(addr) {
    const s = String(addr || '').trim();
    if (!s) return 'PA ADRESË';
    const parts = s.split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2) return (parts[parts.length - 2] || parts[parts.length - 1] || 'PA ADRESË').toUpperCase();
    return (parts[0] || 'PA ADRESË').toUpperCase();
  }

  function autoSortRoute() {
    // Nearest-neighbor from gpsOrigin (or first item)
    const list = Array.isArray(routeItems) ? [...routeItems] : [];
    if (list.length <= 2) return;
    const start = gpsOrigin || pickLatLng(list[0]) || null;
    if (!start) return;

    const remaining = [...list];
    const ordered = [];
    let cur = start;

    while (remaining.length) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const ll = pickLatLng(remaining[i]);
        if (!ll) continue;
        const d = haversine(cur, ll);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      const next = remaining.splice(bestIdx, 1)[0];
      ordered.push(next);
      const ll = pickLatLng(next);
      if (ll) cur = ll;
    }

    setRouteItems(ordered);
  }

function openRouteBuilder() { prepareActionItems(); setShowRoute(true); }
  function openBulkMsg() { prepareActionItems(); setShowBulk(true); }

  function openRiplanModal(row) {
    const at = getRiplanAt(row);
    setRDate(toLocalDateValue(at) || toLocalDateValue(new Date()));
    setRTime(toLocalTimeValue(at) || '10:00');
    setRNote(getRiplanNote(row) || '');
    setShowRiplan(true);
  }

  function setRDateOffset(days) {
    try {
      const d = new Date();
      d.setDate(d.getDate() + days);
      setRDate(toLocalDateValue(d));
    } catch {}
  }

  function applyQuickTime(hhmm) {
    try { setRTime(hhmm); } catch {}
  }

  function bumpMinutes(mins) {
    try {
      const base = new Date(`${rDate || toLocalDateValue(new Date())}T${rTime || '10:00'}:00`);
      base.setMinutes(base.getMinutes() + mins);
      setRDate(toLocalDateValue(base));
      setRTime(toLocalTimeValue(base));
    } catch {}
  }

  function addReasonToNote(reason) {
    const tag = String(reason || '').trim();
    if (!tag) return;
    const base = (rNote || '').trim();
    if (!base) return setRNote(tag);
    if (base.toLowerCase().includes(tag.toLowerCase())) return;
    setRNote(base + ' • ' + tag);
  }

  async function saveRiplan(row) {
    if (!row?.id) return;
    if (!rDate || !rTime) return alert('Zgjedh datën dhe orën.');
    let iso = '';
    try {
      iso = new Date(`${rDate}T${rTime}:00`).toISOString();
    } catch {
      return alert('Data/Ora jo valide.');
    }

    setSavingRiplan(true);
    try {
      await updateTransportOrderById(row.id, {
        reschedule_at: iso,
        reschedule_note:
          (((rRemind30 ? '[KUJTO 30] ' : '') + (rNote || '').trim()).trim() || null),
      });

      try { window.dispatchEvent(new CustomEvent('transport:refresh')); } catch {}
      setShowRiplan(false);
    } catch (e) {
      alert('Gabim: ' + (e?.message || e));
    } finally {
      setSavingRiplan(false);
    }
  }

  function moveItem(index, direction) {
    const newItems = [...(routeItems || [])];
    if (direction === -1 && index > 0) [newItems[index], newItems[index - 1]] = [newItems[index - 1], newItems[index]];
    else if (direction === 1 && index < newItems.length - 1) [newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]];
    setRouteItems(newItems);
  }

  return (
    <>
      <div style={{ padding: '0 16px 10px', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        {selectionMode ? (
          <>
            <button style={ui.btnSmall} onClick={() => { setSelectionMode(false); setSelectedIds(new Set()); }}>Anulo</button>
            <button style={ui.btnSmall} onClick={selectAll}>Zgjedh Krejt</button>
          </>
        ) : (
          <button style={ui.btnSmall} onClick={() => setSelectionMode(true)}>Selekto</button>
        )}
      </div>

      <div style={ui.listContainer}>
        {loading && <div style={ui.centerMsg}>Duke ngarkuar...</div>}
        {!loading && (items?.length || 0) === 0 && <div style={ui.centerMsg}>S'ka porosi gati.</div>}

        {(sortedItems || []).map((item) => {
          const t = getTotals(item);
          const isSelected = selectedIds?.has(item.id);
          return (
            <div key={item.id} style={{ ...ui.row, ...rowAgingStyle(item) }} onClick={() => { if (selectionMode) toggleSelection(item.id); else setToolsRow(item); }}>
              {selectionMode && (
                <div style={{ marginRight: 12 }}>
                  <div style={isSelected ? ui.checkboxSelected : ui.checkboxEmpty}>{isSelected && '✓'}</div>
                </div>
              )}
              <div style={ui.rowLeft}><div style={ui.circleAvatar}>{getCode(item)}</div></div>
              <div style={ui.rowMiddle}>
                <div style={ui.rowHeader}>
                  <span style={ui.clientName}>{getName(item)}</span>
                  <span style={ui.timeStamp}>{formatTime(item.created_at)}</span>
                </div>
                <div style={ui.subjectLine}>{getAddress(item) || "Pa adresë"}</div>
                <div style={ui.previewText}>{t.pieces} copë • {money(t.total)} €</div>
              </div>
            </div>
          );
        })}
        <div style={{ height: 140 }} />
      </div>

      <div style={ui.floatingBar}>
        <button style={ui.floatBtn} onClick={openRouteBuilder}><span style={{ fontSize: 20 }}>🚛</span><span style={{ fontSize: 10 }}>Ngarko</span></button>
        <button style={ui.floatBtn} onClick={openBulkMsg}><span style={{ fontSize: 20 }}>💬</span><span style={{ fontSize: 10 }}>Njofto</span></button>
        <Link href="/transport/menu" style={ui.floatBtnLink}><span style={{ fontSize: 20 }}>☰</span><span style={{ fontSize: 10 }}>Menu</span></Link>
      </div>

      {toolsRow && (
        <div style={{ ...ui.modalOverlay, justifyContent: 'center', alignItems: 'center', padding: 16 }} onClick={() => setToolsRow(null)}>
          <div style={ui.toolsSheet} onClick={e => e.stopPropagation()}>
            <div style={ui.toolsHeader}>
              <div style={{ fontWeight: '900', fontSize: 18 }}>{getName(toolsRow)}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{getAddress(toolsRow)}</div>
            </div>
            <div style={ui.toolsGrid}>
              <button style={ui.toolBtnBig} onClick={() => openMap(toolsRow)}><span style={{ fontSize: 22 }}>📍</span><span>MAPS</span></button>
              <button style={ui.toolBtnBig} onClick={() => sendMsg(toolsRow, 'gati')}><span style={{ fontSize: 22 }}>💬</span><span>GATI</span></button>
              
              <button
                style={{ ...ui.toolBtnBig, background: 'rgba(255,255,255,0.06)' }}
                onClick={() => openRiplanModal(toolsRow)}
              >
                <span style={{ fontSize: 22 }}>🕒</span><span>RIPLAN</span>
              </button>

              <button
                style={{ ...ui.toolBtnBig, background: 'rgba(255,149,0,0.18)' }}
                onClick={() => { setKReason(''); setKPhoto(''); setShowKthim(true); }}
              >
                <span style={{ fontSize: 22 }}>↩️</span><span>KTHIM</span>
              </button>

              <button style={{ ...ui.toolBtnBig, background: '#222' }} onClick={() => { setToolsRow(null); onOpenModal(`/transport/pranimi?id=${encodeURIComponent(toolsRow.id)}&focus=pay`); }}>
                <span style={{ fontSize: 22 }}>💵</span><span>PAGUJ</span>
              </button>
              
              <button
                style={{ ...ui.toolBtnBig, background: '#34C759' }}
                onClick={async () => {
                  try {
                    if (onBulkStatus) await onBulkStatus([toolsRow.id], 'delivery');
                  } finally {
                    setToolsRow(null);
                    if (onGoDorzo) onGoDorzo();
                  }
                }}
              >
                <span style={{ fontSize: 22 }}>🚚</span><span>NGARKO</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showRiplan && toolsRow && (
        <div style={ui.modalOverlay} onClick={() => setShowRiplan(false)}>
          <div style={{ ...ui.toolsSheet, margin: 'auto', maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 4 }}>RIPLANIFIKO</div>
                <div style={{ fontSize: 13, opacity: 0.85 }}>{getName(toolsRow)} • {getCode(toolsRow)}</div>
              </div>
              <button style={riplanBtnGhost} onClick={() => setShowRiplan(false)}>✕</button>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>SHPEJT</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button style={ui.chip} onClick={() => setRDateOffset(0)}>SOT</button>
                <button style={ui.chip} onClick={() => setRDateOffset(1)}>NESËR</button>
                <button style={ui.chip} onClick={() => setRDateOffset(2)}>PASNESËR</button>
                <button style={{ ...ui.chip, background: rRemind30 ? 'rgba(52,199,89,0.18)' : 'rgba(255,255,255,0.06)' }} onClick={() => setRRemind30((v) => !v)}>
                  {rRemind30 ? 'MË KUJTO 30 MIN ✓' : 'MË KUJTO 30 MIN'}
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              <div>
                <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>DATA</div>
                <input type="date" value={rDate} onChange={(e) => setRDate(e.target.value)} style={riplanInputStyle} />
              </div>
              <div>
                <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>ORA</div>
                <input type="time" value={rTime} onChange={(e) => setRTime(e.target.value)} style={riplanInputStyle} />
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>ORA SHPEJT</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {['09:00','11:00','13:00','16:00','19:00'].map((hhmm) => (
                  <button key={hhmm} style={ui.chip} onClick={() => applyQuickTime(hhmm)}>{hhmm}</button>
                ))}
                <button style={ui.chip} onClick={() => bumpMinutes(30)}>+30 MIN</button>
                <button style={ui.chip} onClick={() => bumpMinutes(60)}>+1 ORË</button>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>ARSYE (opsional)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {["NUK PËRGJIGJET", "S’ËSHT N’SHTEPI", "ADRESA GABIM", "S’ISHTE GATI"].map((x) => (
                  <button key={x} style={{ ...ui.chip, padding: '10px 10px', fontWeight: 900 }} onClick={() => addReasonToNote(x)}>{x}</button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>SHËNIM</div>
              <input
                type="text"
                placeholder="p.sh. THIRR NË ORËN 16:30 • DEL TE HYRJA 2"
                value={rNote}
                onChange={(e) => setRNote(e.target.value)}
                style={riplanInputStyle}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button style={riplanBtnGhost} onClick={() => setShowRiplan(false)}>ANULO</button>
              <button
                style={{ ...riplanBtn, opacity: savingRiplan ? 0.6 : 1 }}
                disabled={savingRiplan}
                onClick={() => saveRiplan(toolsRow)}
              >
                {savingRiplan ? 'DUKE RUAJTUR…' : 'RUAJ'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showKthim && toolsRow && (
        <div style={ui.modalOverlay} onClick={() => setShowKthim(false)}>
          <div style={{ ...ui.toolsSheet, margin: 'auto', maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 4 }}>KTHIM NË BAZË</div>
            <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12 }}>{getName(toolsRow)} • {getCode(toolsRow)}</div>

            <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>ARSYE</div>
            <input
              type="text"
              placeholder="p.sh. klienti e ktheu / problem / kërkon ripastrim"
              value={kReason}
              onChange={(e) => setKReason(e.target.value)}
              style={riplanInputStyle}
            />

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>FOTO (opsionale)</div>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => { try { setKPhoto(String(reader.result || '')); } catch {} };
                  reader.readAsDataURL(f);
                }}
                style={{ width: '100%', fontSize: 12, color: '#ddd' }}
              />
              {kPhoto ? (
                <div style={{ marginTop: 8, borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.12)' }}>
                  <img src={kPhoto} alt="KTHIM" style={{ width: '100%', display: 'block' }} />
                </div>
              ) : null}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button style={riplanBtnGhost} onClick={() => setShowKthim(false)}>ANULO</button>
              <button
                style={{ ...riplanBtn, opacity: savingKthim ? 0.6 : 1 }}
                disabled={savingKthim}
                onClick={async () => {
                  if (!toolsRow?.id) return;
                  setSavingKthim(true);
                  try {
                    const prevData = (toolsRow?.data && typeof toolsRow.data === 'object') ? toolsRow.data : {};
                    const nextData = {
                      ...prevData,
                      kthim: {
                        at: new Date().toISOString(),
                        reason: (kReason || '').trim() || null,
                        photo: kPhoto || null,
                      },
                    };
                    await updateTransportOrderById(toolsRow.id, { status: 'pastrim', data: nextData });
                    try { window.dispatchEvent(new CustomEvent('transport:refresh')); } catch {}
                    setShowKthim(false);
                    setToolsRow(null);
                  } catch (e) {
                    alert('Gabim: ' + (e?.message || e));
                  } finally {
                    setSavingKthim(false);
                  }
                }}
              >
                {savingKthim ? 'DUKE RUAJTUR…' : 'KTHE NË PASTRIM'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showRoute && (
        <div style={ui.modalOverlay}>
          <div style={ui.modalShell}>
            <div style={ui.modalTop}>
              <button style={ui.btnCloseModal} onClick={() => setShowRoute(false)}>✕ Mbylle</button>
              <div style={{ textAlign: 'center', fontWeight: 800 }}>SMART LOADING</div>
              <div style={{ width: 60 }} />
            </div>
            <div style={{ padding: 12, background: '#000', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
                <button style={ui.miniBtnMid} onClick={askGpsOrigin}>📍 MERRE GPS</button>
                <button style={ui.miniBtnMid} onClick={autoSortRoute}>⚡ AUTO SORT</button>
                <button style={ui.miniBtnMid} onClick={() => setGpsOrigin(null)}>↩︎ RESET GPS</button>
              </div>

              <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                <div style={{ fontSize:12, opacity:.85 }}>KAPACITETI (m²)</div>
                <input
                  value={capM2}
                  onChange={(e) => setCapM2(Number(e.target.value) || 0)}
                  inputMode="numeric"
                  style={{ width: 110, padding:'10px 10px', borderRadius:12, background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.12)', color:'#fff', fontWeight:900 }}
                />
                <div style={{ fontSize:12, opacity:.9 }}>
                  TOTAL: <span style={{ fontWeight:900 }}>{routeTotals.count}</span> klientë • <span style={{ fontWeight:900 }}>{Math.round(routeTotals.m2 || 0)}</span> m² • <span style={{ fontWeight:900 }}>{routeTotals.pieces}</span> copë
                </div>
              </div>

              {capM2 > 0 && routeTotals.m2 > capM2 && (
                <div style={{ marginTop:10, padding:10, borderRadius:12, background:'rgba(255,0,0,0.12)', border:'1px solid rgba(255,0,0,0.25)', fontWeight:900 }}>
                  ⚠️ TEJKALON KAPACITETIN: {Math.round(routeTotals.m2 || 0)} m² &gt; {capM2} m²
                </div>
              )}

              {zoneSummary.length > 0 && (
                <div style={{ marginTop:10, display:'flex', gap:8, flexWrap:'wrap' }}>
                  {zoneSummary.slice(0, 6).map(([z, v]) => (
                    <div key={z} style={{ padding:'6px 10px', borderRadius:999, background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.10)', fontSize:11, fontWeight:900 }}>
                      {z} • {v.count}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop:12, display:'flex', gap:10 }}>
                <button
                  style={{ ...ui.bulkBtn, background: '#0A84FF', flex: 1, fontWeight: 900 }}
                  onClick={async () => {
                    const ids = (routeItems || []).map(x => x.id).filter(Boolean);
                    if (!ids.length) return;
                    // set NGARKIM (loaded)
                    if (onBulkStatus) await onBulkStatus(ids, 'loaded');
                    setShowRoute(false);
                  }}
                >
                  ✅ SET NGARKIM
                </button>
                <button style={{ ...ui.bulkBtn, flex: 1 }} onClick={() => setShowRoute(false)}>✕ MBYLL</button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, background: '#000' }}>
              {(routeItems || []).map((item, idx) => (
                <div key={item.id} style={ui.routeRow}>
                  <div style={ui.routeIndex}>{idx + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '700' }}>{getName(item)}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>{getAddress(item)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={ui.btnIcon} onClick={() => moveItem(idx, -1)}>▲</button>
                    <button style={ui.btnIcon} onClick={() => moveItem(idx, 1)}>▼</button>
                    <button style={ui.btnMapIcon} onClick={() => openMap(item)}>📍</button>
                  </div>
                </div>
              ))}
              <div style={{ height: 60 }} />
            </div>
          </div>
        </div>
      )}

      {showBulk && (
        <div style={ui.modalOverlay}>
          <div style={ui.modalShell}>
            <div style={ui.modalTop}>
              <button style={ui.btnCloseModal} onClick={() => setShowBulk(false)}>✕ Mbylle</button>
              <span style={{ fontWeight: 600 }}>Dërgo Njoftimet</span>
              <div style={{ width: 60 }} />
            </div>
            <div style={{ padding: 16, flex: 1, overflowY: 'auto' }}>
              {(routeItems || []).map((item) => {
                const t = getTotals(item);
                return (
                  <div key={item.id} style={ui.msgRow}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 'bold' }}>{getName(item)}</div>
                      <div style={{ fontSize: 12, color: '#AAA' }}>{money(t.total)}€ • {getPhone(item)}</div>
                    </div>
                    <button style={ui.btnSend} onClick={(e) => { sendMsg(item, 'gati'); e.currentTarget.style.background = '#333'; e.currentTarget.innerText = 'U Dërgua'; }}>
                      DËRGO 💬
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export { ReadyView as GatiModule };
