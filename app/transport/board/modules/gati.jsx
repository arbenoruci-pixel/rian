'use client';

import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { updateTransportOrderById } from '@/lib/transportOrdersDb';
import { supabase } from '@/lib/supabaseClient';
import { ui } from '@/lib/transport/board/ui';
import { useRenderBatches } from '@/lib/renderBatching';
import { getName, getCode, getAddress, getTotals, formatTime, money, pickLatLng, haversine, openMap } from '@/lib/transport/board/shared';

const ACTION_DEFER_MS = 80;
const BUCKET = 'tepiha-photos';

function deferAction(fn, ms = ACTION_DEFER_MS) {
  try {
    return window.setTimeout(() => {
      try { fn(); } catch {}
    }, ms);
  } catch {
    try { fn(); } catch {}
    return 0;
  }
}

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

async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const rawExt = String(file?.name || '').split('.').pop();
  const ext = String(rawExt || 'jpg').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'jpg';
  const safeKey = String(key || 'photo').replace(/[^a-zA-Z0-9_-]/g, '_');
  const path = `photos/${oid}/${safeKey}_${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true,
    cacheControl: '0',
  });
  if (error) throw error;

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

function getReadyAt(row) {
  const d = row?.data || row?.order || row || {};
  return row?.ready_at || d?.ready_at || row?.updated_at || d?.updated_at || null;
}

function orderAssignedDriver(o) {
  return String(o?.actor || o?.data?.actor || o?.driver_name || o?.data?.driver_name || '').trim();
}

function orderRackLabel(o) {
  return String(o?.data?.ready_note || o?.data?.ready_location || o?.data?.rack_label || '').trim();
}

function safeTs(value) {
  if (!value) return 0;
  try {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : 0;
  } catch {
    return 0;
  }
}

function startOfDayTsFromTs(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  try {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  } catch {
    return 0;
  }
}

function rowGeoCache(row) {
  const latLng = pickLatLng(row);
  return {
    latLng,
    lat: Number.isFinite(latLng?.lat) ? latLng.lat : null,
    lng: Number.isFinite(latLng?.lng) ? latLng.lng : null,
  };
}

function haversineFromCoords(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return Infinity;
  return haversine({ lat: aLat, lng: aLng }, { lat: bLat, lng: bLng });
}

function ageDaysSinceTs(ts, nowStartTs) {
  if (!Number.isFinite(ts) || !Number.isFinite(nowStartTs)) return 0;
  const day = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor((nowStartTs - ts) / day));
}

function agingStyleFromDays(days) {
  if (days <= 0) return { background: 'rgba(0, 200, 0, 0.18)' };
  if (days === 1) return { background: 'rgba(255, 165, 0, 0.22)' };
  return { background: 'rgba(255, 0, 0, 0.18)' };
}

function getRiplanAt(row) {
  const d = row?.data || row?.order || row || {};
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

function StrikeDots({ count }) {
  const safeCount = Math.max(0, Math.min(3, Number(count) || 0));
  const dots = [0, 1, 2].map((idx) => idx < safeCount);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, justifyContent: 'flex-end' }}>
      {dots.map((isOn, idx) => (
        <span
          key={idx}
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            display: 'inline-block',
            background: isOn ? '#34C759' : 'transparent',
            border: `1.5px solid ${isOn ? '#34C759' : 'rgba(255,255,255,0.45)'}`,
            boxShadow: isOn ? '0 0 0 2px rgba(52,199,89,0.14)' : 'none',
          }}
        />
      ))}
    </div>
  );
}

function ReadyView({
  items,
  loading,
  geo,
  onOpenModal,
  onBulkStatus,
  onGoDorzo,
  onOpenSms,
  getSmsCount,
  onOpenRack,
}) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showRoute, setShowRoute] = useState(false);
  const [gpsOrigin, setGpsOrigin] = useState(null);
  const [capM2, setCapM2] = useState(35);
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
  const [kPhotoFile, setKPhotoFile] = useState(null);
  const kthimPhotoObjectUrlRef = useRef('');
  const [savingKthim, setSavingKthim] = useState(false);
  const [savingRiplan, setSavingRiplan] = useState(false);
  const deferTimersRef = useRef([]);

  useEffect(() => {
    return () => {
      for (const id of deferTimersRef.current) {
        try { clearTimeout(id); } catch {}
      }
      deferTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    return () => {
      if (kthimPhotoObjectUrlRef.current) {
        try { URL.revokeObjectURL(kthimPhotoObjectUrlRef.current); } catch {}
        kthimPhotoObjectUrlRef.current = '';
      }
    };
  }, []);

  const runDeferred = useCallback((fn, ms = ACTION_DEFER_MS) => {
    let timerId = 0;
    const wrapped = () => {
      try { fn(); } finally {
        deferTimersRef.current = (deferTimersRef.current || []).filter((x) => x !== timerId);
      }
    };
    timerId = deferAction(wrapped, ms);
    if (timerId) deferTimersRef.current.push(timerId);
  }, []);

  const deferredItems = useDeferredValue(items);

  const itemView = useMemo(() => {
    const list = Array.isArray(deferredItems) ? deferredItems : [];
    const now = new Date();
    const startOfTodayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const mapped = list.map((row) => {
      const readyAt = getReadyAt(row);
      const readyTs = safeTs(readyAt);
      const readyDayTs = startOfDayTsFromTs(readyTs);
      const days = ageDaysSinceTs(readyDayTs, startOfTodayTs);
      const totals = getTotals(row);
      const geoCache = rowGeoCache(row);
      return {
        row,
        id: row?.id,
        name: getName(row),
        code: getCode(row),
        address: getAddress(row) || 'Pa adresë',
        createdAtLabel: formatTime(row?.created_at),
        totals,
        readyAt,
        readyTs,
        readyDayTs,
        ageDays: days,
        agingStyle: agingStyleFromDays(days),
        latLng: geoCache.latLng,
        lat: geoCache.lat,
        lng: geoCache.lng,
        smsCount: getSmsCount ? getSmsCount(row) : Number(row?.data?.sms_count || 0),
      };
    });
    mapped.sort((a, b) => a.readyTs - b.readyTs);
    return mapped;
  }, [deferredItems, getSmsCount]);

  const { visibleItems: visibleReadyItems, remainingCount: remainingReadyCount, renderMore: renderMoreReady } = useRenderBatches(itemView, { initial: 14, step: 10, pulseMs: 80, limit: 60 });

  useEffect(() => {
    if (!selectionMode) setSelectedIds(new Set());
  }, [itemView.length, selectionMode]);

  const itemViewById = useMemo(() => {
    const map = new Map();
    for (const item of itemView) {
      if (item?.id) map.set(item.id, item);
    }
    return map;
  }, [itemView]);

  const routeItemsView = useMemo(() => {
    const list = Array.isArray(routeItems) ? routeItems : [];
    return list.map((row) => {
      const cached = itemViewById.get(row?.id);
      if (cached) return cached;
      const totals = getTotals(row);
      const geoCache = rowGeoCache(row);
      const readyAt = getReadyAt(row);
      const readyTs = safeTs(readyAt);
      const readyDayTs = startOfDayTsFromTs(readyTs);
      const now = new Date();
      const startOfTodayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const ageDays = ageDaysSinceTs(readyDayTs, startOfTodayTs);
      return {
        row,
        id: row?.id,
        name: getName(row),
        code: getCode(row),
        address: getAddress(row) || 'Pa adresë',
        createdAtLabel: formatTime(row?.created_at),
        totals,
        readyAt,
        readyTs,
        readyDayTs,
        ageDays,
        agingStyle: agingStyleFromDays(ageDays),
        latLng: geoCache.latLng,
        lat: geoCache.lat,
        lng: geoCache.lng,
        rackLabel: orderRackLabel(row),
        assignedDriver: orderAssignedDriver(row),
        smsCount: getSmsCount ? getSmsCount(row) : Number(row?.data?.sms_count || 0),
      };
    });
  }, [routeItems, itemViewById, getSmsCount]);

  const routeTotals = useMemo(() => {
    return routeItemsView.reduce((acc, it) => {
      acc.count += 1;
      acc.pieces += Number(it.totals?.pieces || 0);
      acc.m2 += Number(it.totals?.m2 || 0);
      acc.total += Number(it.totals?.total || 0);
      return acc;
    }, { count: 0, pieces: 0, m2: 0, total: 0 });
  }, [routeItemsView]);

  const zoneSummary = useMemo(() => {
    const map = {};
    for (const it of routeItemsView) {
      const s = String(it.address || '').trim();
      const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
      const zone = parts.length >= 2 ? (parts[parts.length - 2] || parts[parts.length - 1] || 'PA ADRESË').toUpperCase() : (parts[0] || 'PA ADRESË').toUpperCase();
      if (!map[zone]) map[zone] = { count: 0, m2: 0 };
      map[zone].count += 1;
      map[zone].m2 += Number(it.totals?.m2 || 0);
    }
    return Object.entries(map).sort((a, b) => b[1].count - a[1].count);
  }, [routeItemsView]);

  const toggleSelection = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev || []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(itemView.map((r) => r.id).filter(Boolean)));
  }, [itemView]);

  const prepareActionItems = useCallback(() => {
    let target = [];
    if ((selectedIds?.size || 0) > 0) target = itemView.filter((i) => selectedIds.has(i.id));
    else target = itemView;

    if (geo) {
      const geoLat = Number.isFinite(geo?.lat) ? geo.lat : null;
      const geoLng = Number.isFinite(geo?.lng) ? geo.lng : null;
      if (Number.isFinite(geoLat) && Number.isFinite(geoLng)) {
        target = target
          .map((item) => ({
            item,
            distance: haversineFromCoords(geoLat, geoLng, item?.lat, item?.lng),
          }))
          .sort((a, b) => a.distance - b.distance)
          .map((entry) => entry.item);
      }
    }
    setRouteItems(target.map((entry) => entry.row));
  }, [selectedIds, itemView, geo]);

  const askGpsOrigin = useCallback(() => {
    if (!navigator?.geolocation) {
      alert('GPS nuk eshte i disponueshem ne kete pajisje.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setGpsOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert("S'u lejua GPS. Hap Settings > Location."),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []);

  const autoSortRoute = useCallback(() => {
    const list = routeItemsView
      .map((item) => ({
        row: item.row,
        id: item.id,
        lat: item.lat,
        lng: item.lng,
      }))
      .filter((item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lng));
    if (list.length <= 2) return;
    const startLat = Number.isFinite(gpsOrigin?.lat) ? gpsOrigin.lat : (Number.isFinite(list[0]?.lat) ? list[0].lat : null);
    const startLng = Number.isFinite(gpsOrigin?.lng) ? gpsOrigin.lng : (Number.isFinite(list[0]?.lng) ? list[0].lng : null);
    if (!Number.isFinite(startLat) || !Number.isFinite(startLng)) return;

    const remaining = [...list];
    const ordered = [];
    let curLat = startLat;
    let curLng = startLng;

    while (remaining.length) {
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const candidate = remaining[i];
        const d = haversineFromCoords(curLat, curLng, candidate?.lat, candidate?.lng);
        if (d < bestD) {
          bestD = d;
          bestIdx = i;
        }
      }
      const next = remaining.splice(bestIdx, 1)[0];
      ordered.push(next);
      if (Number.isFinite(next?.lat) && Number.isFinite(next?.lng)) {
        curLat = next.lat;
        curLng = next.lng;
      }
    }
    setRouteItems(ordered.map((x) => x.row));
  }, [routeItemsView, gpsOrigin]);

  const openRouteBuilder = useCallback(() => {
    prepareActionItems();
    setShowRoute(true);
  }, [prepareActionItems]);

  const openBulkMsg = useCallback(() => {
    prepareActionItems();
    setShowBulk(true);
  }, [prepareActionItems]);

  const openRiplanModal = useCallback((row) => {
    const at = getRiplanAt(row);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setRDate(toLocalDateValue(at) || toLocalDateValue(tomorrow));
    setRTime(toLocalTimeValue(at) || '10:00');
    setRNote(getRiplanNote(row) || '');
    setShowRiplan(true);
  }, []);

  const setRDateOffset = useCallback((days) => {
    try {
      const d = new Date();
      d.setDate(d.getDate() + days);
      setRDate(toLocalDateValue(d));
    } catch {}
  }, []);

  const applyQuickTime = useCallback((hhmm) => {
    setRTime(hhmm);
  }, []);

  const bumpMinutes = useCallback((mins) => {
    try {
      const base = new Date(`${rDate || toLocalDateValue(new Date())}T${rTime || '10:00'}:00`);
      base.setMinutes(base.getMinutes() + mins);
      setRDate(toLocalDateValue(base));
      setRTime(toLocalTimeValue(base));
    } catch {}
  }, [rDate, rTime]);

  const addReasonToNote = useCallback((reason) => {
    const tag = String(reason || '').trim();
    if (!tag) return;
    const base = String(rNote || '').trim();
    if (!base) {
      setRNote(tag);
      return;
    }
    if (base.toLowerCase().includes(tag.toLowerCase())) return;
    setRNote(`${base} • ${tag}`);
  }, [rNote]);

  const saveRiplan = useCallback(async (row) => {
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
      if (onBulkStatus) await onBulkStatus([row.id], 'riplan');
      await updateTransportOrderById(row.id, {
        status: 'riplan',
        reschedule_at: iso,
        reschedule_note: (((rRemind30 ? '[KUJTO 30] ' : '') + (rNote || '').trim()).trim() || null),
      });
      try { window.dispatchEvent(new CustomEvent('transport:refresh')); } catch {}
      setShowRiplan(false);
      setToolsRow(null);
    } catch (e) {
      alert('Gabim: ' + (e?.message || e));
    } finally {
      setSavingRiplan(false);
    }
  }, [rDate, rTime, rRemind30, rNote, onBulkStatus]);

  const moveItem = useCallback((index, direction) => {
    setRouteItems((prev) => {
      const newItems = [...(Array.isArray(prev) ? prev : [])];
      if (direction === -1 && index > 0) [newItems[index], newItems[index - 1]] = [newItems[index - 1], newItems[index]];
      else if (direction === 1 && index < newItems.length - 1) [newItems[index], newItems[index + 1]] = [newItems[index + 1], newItems[index]];
      return newItems;
    });
  }, []);

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
    textTransform: 'uppercase',
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
    fontSize: 12,
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
    fontSize: 12,
  };

  return (
    <>
      <div style={{ padding: '0 16px 10px', display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {selectionMode ? (
          <>
            <button style={ui.btnSmall} onClick={() => runDeferred(() => { setSelectionMode(false); setSelectedIds(new Set()); })}>Anulo</button>
            <button style={ui.btnSmall} onClick={() => runDeferred(selectAll)}>Zgjedh Krejt</button>
            {(selectedIds?.size || 0) > 0 && (
              <>
                <button style={ui.btnSmall} onClick={() => runDeferred(() => { prepareActionItems(); setShowBulk(true); })}>DËRGO SMS KONFIRMIMI</button>
                <button style={ui.btnSmall} onClick={() => runDeferred(() => { prepareActionItems(); setShowRoute(true); })}>OPTIMIZO RRUGËN</button>
              </>
            )}
          </>
        ) : (
          <button style={ui.btnSmall} onClick={() => runDeferred(() => setSelectionMode(true))}>Selekto</button>
        )}
      </div>

      <div style={ui.listContainer}>
        {loading && <div style={ui.centerMsg}>Duke ngarkuar...</div>}
        {!loading && itemView.length === 0 && <div style={ui.centerMsg}>S'ka porosi gati.</div>}

        {visibleReadyItems.map((item) => {
          const isSelected = selectedIds?.has(item.id);
          return (
            <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, marginBottom: 8, borderRadius: 16, border: '1px solid rgba(245,158,11,0.45)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 10px 24px rgba(0,0,0,0.18)', cursor: 'pointer', ...item.agingStyle }} onClick={() => runDeferred(() => { if (selectionMode) toggleSelection(item.id); else setToolsRow(item.row); })}>
              {selectionMode && (
                <div style={{ marginRight: 2 }}>
                  <div style={isSelected ? ui.checkboxSelected : ui.checkboxEmpty}>{isSelected && '✓'}</div>
                </div>
              )}
              <div style={{ width: 36, minWidth: 36, height: 36, marginRight: 6, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#39d86f', color: '#03140a', fontSize: 12, fontWeight: 1000, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 16px rgba(57,216,111,0.18)' }}>{item.code}</div>
              <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ffffff', fontSize: 15, fontWeight: 900, letterSpacing: 0.2 }}>{item.name}</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', borderRadius: 999, fontSize: 10, fontWeight: 900, letterSpacing: 0.5, textTransform: 'uppercase', background: 'rgba(255,149,0,0.15)', color: '#FF9F0A', border: '1px solid rgba(255,159,10,0.28)' }}>🚚 PËR KAMION</span>
                  </div>
                  <span style={{ color: 'rgba(255,255,255,0.52)', fontSize: 11, fontWeight: 900, whiteSpace: 'nowrap', flexShrink: 0 }}>{item.createdAtLabel}</span>
                </div>

                <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.address}</div>

                <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 12, fontWeight: 800 }}>{item.totals?.pieces} copë • {money(item.totals?.total)} €</div>

                {item.rackLabel ? (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifySelf: 'start', borderRadius: 12, padding: '4px 8px', background: 'rgba(19,108,53,0.45)', border: '1px solid rgba(52,199,89,0.35)', color: '#86efac', fontSize: 11, fontWeight: 900, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    📍 {item.rackLabel}
                  </div>
                ) : null}

                {item.assignedDriver ? (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifySelf: 'start', borderRadius: 12, padding: '4px 8px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: '#93c5fd', fontSize: 11, fontWeight: 900, marginTop: 4 }}>
                    👷‍♂️ {item.assignedDriver}
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
        {renderBatchHint(remainingReadyCount, renderMoreReady)}

        <div style={{ height: 140 }} />
      </div>

      <div style={ui.floatingBar}>
        <button style={ui.floatBtn} onClick={() => runDeferred(openRouteBuilder)}><span style={{ fontSize: 20 }}>🚛</span><span style={{ fontSize: 10 }}>Ngarko</span></button>
        <button style={ui.floatBtn} onClick={() => runDeferred(openBulkMsg)}><span style={{ fontSize: 20 }}>💬</span><span style={{ fontSize: 10 }}>SMS</span></button>
        <Link href="/transport/menu" style={ui.floatBtnLink}><span style={{ fontSize: 20 }}>☰</span><span style={{ fontSize: 10 }}>Menu</span></Link>
      </div>

      {toolsRow && (
        <div style={{ ...ui.modalOverlay, justifyContent: 'center', alignItems: 'center', padding: 16 }} onClick={() => setToolsRow(null)}>
          <div style={ui.toolsSheet} onClick={(e) => e.stopPropagation()}>
            <div style={ui.toolsHeader}>
              <div style={{ fontWeight: '900', fontSize: 18 }}>{getName(toolsRow)}</div>
              <div style={{ fontSize: 13, opacity: 0.7 }}>{getAddress(toolsRow)}</div>
            </div>
            <div style={ui.toolsGrid}>
              <button style={ui.toolBtnBig} onClick={() => runDeferred(() => openMap(toolsRow))}><span style={{ fontSize: 22 }}>📍</span><span>MAPS</span></button>
              <div><StrikeDots count={getSmsCount ? getSmsCount(toolsRow) : Number(toolsRow?.data?.sms_count || 0)} /><button style={ui.toolBtnBig} onClick={() => runDeferred(() => onOpenSms && onOpenSms(toolsRow, 'transport_konfirmim'))}><span style={{ fontSize: 22 }}>💬</span><span>SMS</span></button></div>
              <button style={{ ...ui.toolBtnBig, background: 'rgba(255,255,255,0.06)' }} onClick={() => runDeferred(() => { setToolsRow(null); onOpenModal(`/transport/pranimi?id=${encodeURIComponent(toolsRow.id)}&edit=1`); })}><span style={{ fontSize: 24 }}>✏️</span><span style={{ fontSize: 14 }}>EDIT</span></button>
              <button style={{ ...ui.toolBtnBig, background: 'rgba(255,255,255,0.06)' }} onClick={() => runDeferred(() => openRiplanModal(toolsRow))}><span style={{ fontSize: 22 }}>🕒</span><span>RIPLAN</span></button>
              <button style={{ ...ui.toolBtnBig, background: 'rgba(255,149,0,0.18)' }} onClick={() => runDeferred(() => { if (kthimPhotoObjectUrlRef.current) { try { URL.revokeObjectURL(kthimPhotoObjectUrlRef.current); } catch {} kthimPhotoObjectUrlRef.current = ''; } setKReason(''); setKPhoto(''); setKPhotoFile(null); setShowKthim(true); })}><span style={{ fontSize: 22 }}>↩️</span><span>KTHIM</span></button>
              <button style={{ ...ui.toolBtnBig, background: '#222' }} onClick={() => runDeferred(() => { setToolsRow(null); onOpenModal(`/transport/pranimi?id=${encodeURIComponent(toolsRow.id)}&focus=pay`); })}><span style={{ fontSize: 22 }}>💵</span><span>PAGUJ</span></button>
              <button style={{ ...ui.toolBtnBig, background: '#34C759' }} onClick={() => runDeferred(async () => {
                try {
                  if (onBulkStatus) await onBulkStatus([toolsRow.id], 'delivery');
                } finally {
                  setToolsRow(null);
                  if (onGoDorzo) onGoDorzo();
                }
              })}><span style={{ fontSize: 22 }}>🚚</span><span>NGARKO</span></button>
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
              <button style={riplanBtnGhost} onClick={() => runDeferred(() => setShowRiplan(false))}>✕</button>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>SHPEJT</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button style={ui.chip} onClick={() => runDeferred(() => setRDateOffset(0))}>SOT</button>
                <button style={ui.chip} onClick={() => runDeferred(() => setRDateOffset(1))}>NESËR</button>
                <button style={ui.chip} onClick={() => runDeferred(() => setRDateOffset(2))}>PASNESËR</button>
                <button style={{ ...ui.chip, background: rRemind30 ? 'rgba(52,199,89,0.18)' : 'rgba(255,255,255,0.06)' }} onClick={() => runDeferred(() => setRRemind30((v) => !v))}>{rRemind30 ? 'MË KUJTO 30 MIN ✓' : 'MË KUJTO 30 MIN'}</button>
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
                  <button key={hhmm} style={ui.chip} onClick={() => runDeferred(() => applyQuickTime(hhmm))}>{hhmm}</button>
                ))}
                <button style={ui.chip} onClick={() => runDeferred(() => bumpMinutes(30))}>+30 MIN</button>
                <button style={ui.chip} onClick={() => runDeferred(() => bumpMinutes(60))}>+1 ORË</button>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>ARSYE (opsional)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {["NUK PËRGJIGJET", "S’ËSHT N’SHTEPI", "ADRESA GABIM", "S’ISHTE GATI"].map((x) => (
                  <button key={x} style={{ ...ui.chip, padding: '10px 10px', fontWeight: 900 }} onClick={() => runDeferred(() => addReasonToNote(x))}>{x}</button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>SHËNIM</div>
              <input type="text" placeholder="p.sh. THIRR NË ORËN 16:30 • DEL TE HYRJA 2" value={rNote} onChange={(e) => setRNote(e.target.value)} style={riplanInputStyle} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button style={riplanBtnGhost} onClick={() => runDeferred(() => setShowRiplan(false))}>ANULO</button>
              <button style={{ ...riplanBtn, opacity: savingRiplan ? 0.6 : 1 }} disabled={savingRiplan} onClick={() => runDeferred(() => saveRiplan(toolsRow))}>{savingRiplan ? 'DUKE RUAJTUR…' : 'RUAJ'}</button>
            </div>
          </div>
        </div>
      )}

      {showKthim && toolsRow && (
        <div style={ui.modalOverlay} onClick={() => { if (kthimPhotoObjectUrlRef.current) { try { URL.revokeObjectURL(kthimPhotoObjectUrlRef.current); } catch {} kthimPhotoObjectUrlRef.current = ''; } setKPhoto(''); setKPhotoFile(null); setShowKthim(false); }}>
          <div style={{ ...ui.toolsSheet, margin: 'auto', maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 4 }}>KTHIM NË BAZË</div>
            <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12 }}>{getName(toolsRow)} • {getCode(toolsRow)}</div>
            <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>ARSYE</div>
            <input type="text" placeholder="p.sh. klienti e ktheu / problem / kërkon ripastrim" value={kReason} onChange={(e) => setKReason(e.target.value)} style={riplanInputStyle} />
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>FOTO (opsionale)</div>
              <input type="file" accept="image/*" capture="environment" onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                try {
                  if (kthimPhotoObjectUrlRef.current) {
                    try { URL.revokeObjectURL(kthimPhotoObjectUrlRef.current); } catch {}
                  }
                  const objectUrl = URL.createObjectURL(f);
                  kthimPhotoObjectUrlRef.current = objectUrl;
                  setKPhotoFile(f);
                  setKPhoto(objectUrl);
                } catch {}
              }} style={{ width: '100%', fontSize: 12, color: '#ddd' }} />
              {kPhoto ? (
                <div style={{ marginTop: 8, borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.12)' }}>
                  <img src={kPhoto} alt="KTHIM" style={{ width: '100%', display: 'block' }} />
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button style={riplanBtnGhost} onClick={() => runDeferred(() => { if (kthimPhotoObjectUrlRef.current) { try { URL.revokeObjectURL(kthimPhotoObjectUrlRef.current); } catch {} kthimPhotoObjectUrlRef.current = ''; } setKPhoto(''); setKPhotoFile(null); setShowKthim(false); })}>ANULO</button>
              <button style={{ ...riplanBtn, opacity: savingKthim ? 0.6 : 1 }} disabled={savingKthim} onClick={() => runDeferred(async () => {
                if (!toolsRow?.id) return;
                setSavingKthim(true);
                try {
                  const prevData = (toolsRow?.data && typeof toolsRow.data === 'object') ? toolsRow.data : {};
                  let uploadedPhotoUrl = null;
                  if (kPhotoFile) {
                    uploadedPhotoUrl = await uploadPhoto(kPhotoFile, toolsRow.id, 'kthim');
                  }
                  const nextData = {
                    ...prevData,
                    kthim: {
                      at: new Date().toISOString(),
                      reason: (kReason || '').trim() || null,
                      photo: uploadedPhotoUrl || null,
                    },
                  };
                  await updateTransportOrderById(toolsRow.id, { status: 'pastrim', data: nextData });
                  try { window.dispatchEvent(new CustomEvent('transport:refresh')); } catch {}
                  if (kthimPhotoObjectUrlRef.current) {
                    try { URL.revokeObjectURL(kthimPhotoObjectUrlRef.current); } catch {}
                    kthimPhotoObjectUrlRef.current = '';
                  }
                  setKPhoto('');
                  setKPhotoFile(null);
                  setShowKthim(false);
                  setToolsRow(null);
                } catch (e) {
                  alert('Gabim: ' + (e?.message || e));
                } finally {
                  setSavingKthim(false);
                }
              })}>{savingKthim ? 'DUKE RUAJTUR…' : 'KTHE NË PASTRIM'}</button>
            </div>
          </div>
        </div>
      )}

      {showRoute && (
        <div style={ui.modalOverlay}>
          <div style={ui.modalShell}>
            <div style={ui.modalTop}>
              <button style={ui.btnCloseModal} onClick={() => runDeferred(() => setShowRoute(false))}>✕ Mbylle</button>
              <div style={{ textAlign: 'center', fontWeight: 800 }}>SMART LOADING</div>
              <div style={{ width: 60 }} />
            </div>
            <div style={{ padding: 12, background: '#000', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
                <button style={ui.miniBtnMid} onClick={() => runDeferred(askGpsOrigin)}>📍 MERRE GPS</button>
                <button style={ui.miniBtnMid} onClick={() => runDeferred(autoSortRoute)}>🧭 OPTIMIZO RRUGËN</button>
                <button style={ui.miniBtnMid} onClick={() => runDeferred(() => setGpsOrigin(null))}>↩︎ RESET GPS</button>
              </div>
              <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap' }}>
                <div style={{ fontSize:12, opacity:.85 }}>KAPACITETI (m²)</div>
                <input value={capM2} onChange={(e) => setCapM2(Number(e.target.value) || 0)} inputMode="numeric" style={{ width: 110, padding:'10px 10px', borderRadius:12, background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.12)', color:'#fff', fontWeight:900 }} />
                <div style={{ fontSize:12, opacity:.9 }}>TOTAL: <span style={{ fontWeight:900 }}>{routeTotals.count}</span> klientë • <span style={{ fontWeight:900 }}>{Math.round(routeTotals.m2 || 0)}</span> m² • <span style={{ fontWeight:900 }}>{routeTotals.pieces}</span> copë</div>
              </div>
              {capM2 > 0 && routeTotals.m2 > capM2 && <div style={{ marginTop:10, padding:10, borderRadius:12, background:'rgba(255,0,0,0.12)', border:'1px solid rgba(255,0,0,0.25)', fontWeight:900 }}>⚠️ TEJKALON KAPACITETIN: {Math.round(routeTotals.m2 || 0)} m² &gt; {capM2} m²</div>}
              {zoneSummary.length > 0 && (
                <div style={{ marginTop:10, display:'flex', gap:8, flexWrap:'wrap' }}>
                  {zoneSummary.slice(0, 6).map(([z, v]) => (
                    <div key={z} style={{ padding:'6px 10px', borderRadius:999, background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.10)', fontSize:11, fontWeight:900 }}>{z} • {v.count}</div>
                  ))}
                </div>
              )}
              <div style={{ marginTop:12, display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10 }}>
                <button style={{ ...ui.bulkBtn, background: '#6D28D9', fontWeight: 900 }} onClick={() => runDeferred(() => { prepareActionItems(); setShowRoute(false); setShowBulk(true); })}>💬 DËRGO SMS KONFIRMIMI</button>
                <button style={{ ...ui.bulkBtn, background: '#0A84FF', fontWeight: 900 }} onClick={() => runDeferred(async () => {
                  const ids = routeItemsView.map((x) => x.id).filter(Boolean);
                  if (!ids.length) return;
                  if (onBulkStatus) await onBulkStatus(ids, 'loaded');
                  setShowRoute(false);
                })}>✅ NGARKO</button>
                <button style={{ ...ui.bulkBtn }} onClick={() => runDeferred(() => setShowRoute(false))}>✕ MBYLL</button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 16, background: '#000' }}>
              {routeItemsView.map((item, idx) => (
                <div key={item.id} style={ui.routeRow}>
                  <div style={ui.routeIndex}>{idx + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '700' }}>{item.name}</div>
                    <div style={{ fontSize: 12, color: '#888' }}>{item.address}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={ui.btnIcon} onClick={() => runDeferred(() => moveItem(idx, -1))}>⬆️</button>
                    <button style={ui.btnIcon} onClick={() => runDeferred(() => moveItem(idx, 1))}>⬇️</button>
                    <button style={ui.btnMapIcon} onClick={() => runDeferred(() => openMap(item.row))}>📍</button>
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
              <button style={ui.btnCloseModal} onClick={() => runDeferred(() => setShowBulk(false))}>✕ Mbylle</button>
              <span style={{ fontWeight: 600 }}>DËRGO SMS KONFIRMIMI</span>
              <div style={{ width: 60 }} />
            </div>
            <div style={{ padding: 16, background: '#000' }}>
              {routeItemsView.map((item) => (
                <button key={item.id} style={{ ...ui.routeRow, width: '100%', textAlign: 'left' }} onClick={() => runDeferred(() => onOpenSms && onOpenSms(item.row, 'transport_konfirmim'))}>
                  <div style={ui.circleAvatar}>{item.code}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800 }}>{item.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>{item.address}</div>
                  </div>
                  <div style={{ fontWeight: 900 }}>SMS</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function GatiModule(props) {
  return <ReadyView {...props} />;
}

export default GatiModule;
