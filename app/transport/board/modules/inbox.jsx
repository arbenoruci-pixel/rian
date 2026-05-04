'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import { buildSmsLink, buildTransportConfirmUrl } from '@/lib/smartSms';
import { useRenderBatches } from '@/lib/renderBatching';

const BOARD_RENDER_LIMIT = 50;
const ACTION_DEFER_MS = 300;

function buildConfirmSms(trackUrl) {
  return `Përshëndetje! Jam shoferi i kompanisë JONI. Jam rrugës për të marrë porosinë tuaj për larjen e tepihave. Ju lutem klikoni këtë link për të na konfirmuar lokacionin dhe kohën kur jeni në shtëpi: ${trackUrl || 'https://tepiha.vercel.app/k/'}`;
}

function normalizePhone(phone) {
  return String(phone || '').trim();
}

function buildTelHref(phone) {
  const clean = normalizePhone(phone);
  return clean ? `tel:${clean}` : '';
}

function buildSmsHref(phone, order) {
  const clean = normalizePhone(phone);
  if (!clean || !order) return '';
  const trackUrl = buildTransportConfirmUrl(order);
  if (!trackUrl || /\/k\/?$/.test(trackUrl)) return '';
  return buildSmsLink(clean, buildConfirmSms(trackUrl));
}

function getLatLngFromOrder(order, getOrderLatLng) {
  try {
    if (typeof getOrderLatLng === 'function') {
      const pair = getOrderLatLng(order);
      if (pair && Number.isFinite(Number(pair?.lat)) && Number.isFinite(Number(pair?.lng))) {
        return { lat: Number(pair.lat), lng: Number(pair.lng) };
      }
    }
  } catch (_) {}

  const latCandidates = [
    order?.gps_lat,
    order?.lat,
    order?.lng_lat,
    order?.pickup_lat,
    order?.address_lat,
    order?.client_lat,
    order?.latitude,
    order?.data?.gps_lat,
    order?.data?.lat,
    order?.data?.client?.gps_lat,
    order?.data?.client?.lat,
  ];
  const lngCandidates = [
    order?.gps_lng,
    order?.lng,
    order?.lng_lng,
    order?.pickup_lng,
    order?.address_lng,
    order?.client_lng,
    order?.longitude,
    order?.data?.gps_lng,
    order?.data?.lng,
    order?.data?.client?.gps_lng,
    order?.data?.client?.lng,
  ];

  const lat = latCandidates.find((v) => Number.isFinite(Number(v)));
  const lng = lngCandidates.find((v) => Number.isFinite(Number(v)));

  if (lat == null || lng == null) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

function openHref(href) {
  if (!href || typeof window === 'undefined') return;
  window.location.href = href;
}

function openMapsForCoords(lat, lng) {
  if (typeof window === 'undefined') return;
  const href = `https://www.google.com/maps?q=${lat},${lng}`;
  window.open(href, '_blank', 'noopener,noreferrer');
}

function labelFromUser(user) {
  const name = String(user?.name || user?.full_name || user?.label || '').trim();
  const pin = String(user?.pin || user?.user_pin || '').trim();
  return name || (pin ? `PIN ${pin}` : 'Shofer');
}

function keyFromUser(user, idx) {
  return String(user?.pin || user?.id || user?.user_id || idx);
}

function orderTitle(order) {
  return String(
    order?.client_name ||
      order?.data?.client?.name ||
      order?.data?.client_name ||
      order?.data?.name ||
      'PA EMËR'
  );
}

function rawOrderCode(order) {
  return String(
    order?.data?.linked_display_code ||
      order?.data?.dispatch_attached_code ||
      order?.data?.linked_transport_tcode ||
      (order?.data?.linked_client_code ? `#${String(order.data.linked_client_code).replace(/^#+/, '')}` : '') ||
      order?.client_tcode ||
      order?.data?.client_tcode ||
      order?.t_code ||
      order?.data?.t_code ||
      ''
  ).trim();
}

function hasRealCode(order) {
  const code = rawOrderCode(order);
  if (!code) return false;
  return code.toUpperCase() !== 'PA KOD';
}

function orderCode(order) {
  const raw = rawOrderCode(order);
  if (!raw) return 'T-NEW';
  if (/^#/.test(raw)) return raw;
  const code = raw.replace(/^#+/, '');
  return /^T/i.test(code) ? code.replace(/^T[-\s]*/i, 'T') : `T${code}`;
}

function orderAddress(order) {
  return String(
    order?.data?.client?.address ||
      order?.pickup_address ||
      order?.address ||
      order?.data?.address ||
      order?.data?.pickup_address ||
      'Adresë jo e ruajtur'
  );
}


function orderCity(order) {
  return String(
    order?.client_city ||
      order?.city ||
      order?.pickup_city ||
      order?.data?.client?.city ||
      order?.data?.city ||
      order?.data?.pickup_city ||
      ''
  ).trim();
}

function orderCityPhone(order) {
  const city = orderCity(order);
  const phone = orderPhone(order);
  if (city && phone) return `${city} • ${phone}`;
  return city || phone || 'Pa qytet / telefon';
}

function orderPhone(order) {
  return String(
    order?.client_phone ||
      order?.data?.client?.phone ||
      order?.phone ||
      order?.data?.phone ||
      ''
  ).trim();
}

function orderNote(order) {
  return String(order?.client_notes || order?.data?.client_notes || order?.data?.note || '').trim();
}

function orderTime(order) {
  try {
    const raw = order?.created_at || order?.updated_at || order?.inserted_at || order?.ready_at || order?.data?.created_at || order?.data?.updated_at;
    if (!raw) return '';
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(dt);
  } catch {
    return '';
  }
}

function sumQtyRows(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + (Number(row?.qty ?? row?.pieces ?? 0) || 0), 0);
}

function orderPieces(order) {
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  const explicit = Number(
    order?.pieces ??
    order?.total_pieces ??
    data?.totals?.pieces ??
    data?.totals?.cope ??
    data?.pieces ??
    data?.cope ??
    0
  ) || 0;
  if (explicit > 0) return explicit;
  return sumQtyRows(data?.tepiha || data?.tepihaRows) +
    sumQtyRows(data?.staza || data?.stazaRows) +
    (Number(data?.shkallore?.qty ?? data?.stairsQty ?? 0) || 0);
}

function orderTotal(order) {
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  return Number(
    order?.total ??
    order?.total_price ??
    order?.price_total ??
    order?.amount_due ??
    data?.pay?.euro ??
    data?.totals?.grandTotal ??
    data?.totals?.grand_total ??
    data?.totals?.total ??
    data?.total ??
    data?.total_price ??
    0
  ) || 0;
}

function orderRackLabel(order) {
  return String(
    order?.data?.ready_note ||
    order?.data?.rack_note ||
    order?.ready_note ||
    ''
  ).trim();
}


function orderAssignedDriver(o) {
  return String(
    o?.actor ||
    o?.data?.actor ||
    o?.driver_name ||
    o?.data?.driver_name ||
    ''
  ).trim();
}

function ActionButton({ onClick, children, disabled, style, title }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      style={{
        appearance: 'none',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 12,
        padding: '7px 8px',
        minHeight: 40,
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        fontSize: 11,
        lineHeight: 1.1,
        fontWeight: 900,
        letterSpacing: 0.2,
        color: '#f8fafc',
        background: 'rgba(255,255,255,0.04)',
        boxShadow: '0 18px 36px rgba(0,0,0,0.22)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        transition: 'transform 140ms ease, box-shadow 140ms ease, opacity 140ms ease',
        ...style,
      }}
      onMouseDown={(e) => {
        if (!disabled) e.currentTarget.style.transform = 'scale(0.985)';
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'scale(1)';
      }}
    >
      {children}
    </button>
  );
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

function InboxModule({ items, loading, onOpenModal, actorRole, transportUsers, onAssign, onCancel, onSaveGps, getOrderLatLng, onOpenSms, onMarkSeen, getUnseenRowStyle, renderUnseenBadge }) {
  const [activeOrder, setActiveOrder] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [assignBusyPin, setAssignBusyPin] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);

  const users = useMemo(() => (Array.isArray(transportUsers) ? transportUsers : []), [transportUsers]);
  const deferredItems = useDeferredValue(items);
  const list = useMemo(() => (Array.isArray(deferredItems) ? deferredItems.slice(0, BOARD_RENDER_LIMIT) : []), [deferredItems]);
  const { visibleItems, remainingCount, renderMore } = useRenderBatches(list, { initial: 12, step: 10, pulseMs: 80, limit: BOARD_RENDER_LIMIT });

  function closeModal() {
    setActiveOrder(null);
    setAssignOpen(false);
    setGpsBusy(false);
    setAssignBusyPin('');
    setCancelBusy(false);
  }

  async function handleSaveGps(order) {
    const existing = getLatLngFromOrder(order, getOrderLatLng);
    if (existing) {
      openMapsForCoords(existing.lat, existing.lng);
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      if (typeof window !== 'undefined') window.alert('GPS nuk mbështetet në këtë pajisje.');
      return;
    }

    try {
      setGpsBusy(true);
      const coords = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          (err) => reject(err),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
      });

      if (typeof onSaveGps === 'function') {
        await onSaveGps(order, coords);
      }

      setActiveOrder((prev) => (prev ? { ...prev, ...coords } : prev));
    } catch (err) {
      console.error('GPS save failed:', err);
      if (typeof window !== 'undefined') {
        window.alert('Nuk u arrit ruajtja e GPS-it. Provo përsëri te dera e klientit.');
      }
    } finally {
      setGpsBusy(false);
    }
  }

  async function handleAssign(order, user) {
    const pin = String(user?.pin || user?.user_pin || '').trim();
    if (!pin || typeof onAssign !== 'function') return;
    try {
      setAssignBusyPin(pin);
      await onAssign(order, pin, user);
      closeModal();
    } catch (err) {
      console.error('Assign failed:', err);
      if (typeof window !== 'undefined') {
        window.alert('Nuk u arrit delegimi i porosisë.');
      }
    } finally {
      setAssignBusyPin('');
    }
  }

  async function handleCancel(order) {
    let reason = 'ANULUAR NGA TRANSPORTERI';
    if (typeof window !== 'undefined') {
      const input = window.prompt('ARSYEJA E ANULIMIT / PSE NUK U REALIZUA?', reason);
      if (input === null) return;
      reason = String(input || '').trim() || reason;
      const ok = window.confirm(`A je i sigurt që dëshiron ta anulosh këtë porosi?\n\nARSYE: ${reason}`);
      if (!ok) return;
    }
    if (typeof onCancel !== 'function') return;
    try {
      setCancelBusy(true);
      await onCancel(order, reason);
      closeModal();
    } catch (err) {
      console.error('Cancel failed:', err);
      if (typeof window !== 'undefined') {
        window.alert('Nuk u arrit anulimi i porosisë.');
      }
    } finally {
      setCancelBusy(false);
    }
  }

  function handleOpenPranimi(order) {
    const id = String(order?.id || '').trim();
    if (!id || typeof onOpenModal !== 'function') return;
    setTimeout(() => {
      onOpenModal('/transport/pranimi?id=' + encodeURIComponent(id));
      closeModal();
    }, ACTION_DEFER_MS);
  }

  const shellStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(2,6,23,0.76)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
    zIndex: 2000,
  };

  const modalStyle = {
    width: '100%',
    maxWidth: 372,
    maxHeight: '78vh',
    borderRadius: 16,
    overflow: 'hidden',
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'linear-gradient(180deg, #0b1220 0%, #0a0f1c 55%, #090d18 100%)',
    boxShadow: '0 32px 64px rgba(0,0,0,0.44)',
    color: '#fff',
  };

  const topBarStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '9px 10px 7px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0))',
  };

  const bodyStyle = {
    padding: 8,
    display: 'grid',
    gap: 7,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  };

  const glassCard = {
    borderRadius: 14,
    border: '1px solid rgba(255,255,255,0.08)',
    background: 'rgba(255,255,255,0.035)',
    boxShadow: '0 18px 36px rgba(0,0,0,0.20)',
    padding: 8,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  };

  const listCardStyle = {
    borderRadius: 14,
    border: '1px solid rgba(245,158,11,0.45)',
    background: 'linear-gradient(180deg, rgba(245,158,11,0.11), rgba(245,158,11,0.04))',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 16px 32px rgba(0,0,0,0.20)',
    padding: 8,
    marginBottom: 6,
    cursor: 'pointer',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  };

  const activeCoords = activeOrder ? getLatLngFromOrder(activeOrder, getOrderLatLng) : null;
  const currentPhone = activeOrder ? orderPhone(activeOrder) : '';
  const activeTrackUrl = activeOrder ? buildTransportConfirmUrl(activeOrder) : '';
  const telHref = buildTelHref(currentPhone);
  const smsHref = buildSmsHref(currentPhone, activeOrder);

  return (
    <>
      <div style={{ display: 'grid', gap: 10 }}>
        {loading ? (
          <div style={{ color: 'rgba(255,255,255,0.72)', padding: '10px 4px', fontWeight: 800 }}>
            Duke u ngarkuar...
          </div>
        ) : list.length ? (
          visibleItems.map((order, idx) => {
            const realCode = hasRealCode(order);
            const rackLabel = orderRackLabel(order);
            const assignedDriver = orderAssignedDriver(order);
            const total = orderTotal(order);
            const pieces = orderPieces(order);
            const secondary = orderCityPhone(order);
            const addressLine = [orderAddress(order), secondary].filter(Boolean).join(' • ');
            return (
              <button
                key={String(order?.id || order?.local_oid || idx)}
                type="button"
                onClick={() => {
                  setTimeout(() => {
                    onMarkSeen && onMarkSeen(order?.id);
                    setActiveOrder(order || null);
                    setAssignOpen(false);
                  }, ACTION_DEFER_MS);
                }}
                style={{
                  ...listCardStyle,
                  padding: 8,
                  marginBottom: 7,
                  borderRadius: 14,
                  ...(getUnseenRowStyle ? getUnseenRowStyle(order) : null),
                  textAlign: 'left',
                  appearance: 'none',
                }}
              >
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{ width: 32, minWidth: 32, height: 32, marginRight: 4, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#39d86f', color: '#03140a', fontSize: 9.5, fontWeight: 1000, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 6px 12px rgba(57,216,111,0.18)' }}>
                      {realCode ? orderCode(order) : 'T-NEW'}
                    </div>
                    <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#ffffff', fontSize: 11.5, fontWeight: 900, letterSpacing: 0.1 }}>
                            {orderTitle(order)}
                          </span>
                          {(getUnseenRowStyle ? getUnseenRowStyle(order) : null) ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', borderRadius: 999, fontSize: 10, fontWeight: 900, letterSpacing: 0.5, textTransform: 'uppercase', background: 'rgba(245,158,11,0.18)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.35)' }}>NEW</span> : null}
                          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', borderRadius: 999, fontSize: 10, fontWeight: 900, letterSpacing: 0.5, textTransform: 'uppercase', background: 'rgba(168,85,247,0.18)', color: '#f0abfc', border: '1px solid rgba(168,85,247,0.30)' }}>📥 TË REJA</span>
                          {renderUnseenBadge ? renderUnseenBadge(order) : null}
                        </div>
                        <span style={{ color: 'rgba(255,255,255,0.48)', fontSize: 9.5, fontWeight: 900, whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {orderTime(order)}
                        </span>
                      </div>

                      <div style={{ color: 'rgba(255,255,255,0.72)', fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {addressLine || 'Adresë jo e ruajtur'}
                      </div>

                      <div style={{ color: 'rgba(255,255,255,0.52)', fontSize: 10.5, fontWeight: 800 }}>
                        {pieces} copë • {total} €
                      </div>

                      {rackLabel ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifySelf: 'start', borderRadius: 12, padding: '4px 8px', background: 'rgba(19,108,53,0.45)', border: '1px solid rgba(52,199,89,0.35)', color: '#86efac', fontSize: 10, fontWeight: 900, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          📍 {rackLabel}
                        </div>
                      ) : null}

                      {assignedDriver ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifySelf: 'start', borderRadius: 12, padding: '4px 8px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: '#93c5fd', fontSize: 10, fontWeight: 900, marginTop: 4 }}>
                          👷‍♂️ {assignedDriver}
                        </div>
                      ) : null}

                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 64, height: 24, padding: '0 9px', borderRadius: 999, background: 'linear-gradient(180deg, rgba(59,130,246,0.26), rgba(37,99,235,0.18))', border: '1px solid rgba(96,165,250,0.30)', color: '#dbeafe', fontSize: 9.5, fontWeight: 900, letterSpacing: 0.2, boxShadow: '0 6px 16px rgba(30,64,175,0.24)' }}>
                          HAP ➔
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            );
          })
        ) : (
          <div style={{ color: 'rgba(255,255,255,0.62)', padding: '10px 4px', fontWeight: 800 }}>
            Nuk ka porosi në këtë tab.
          </div>
        )}

        {renderBatchHint(remainingCount, renderMore)}
      </div>

      {activeOrder ? (
        <div style={shellStyle} onClick={closeModal}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={topBarStyle}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 1.2, color: 'rgba(255,255,255,0.48)', textTransform: 'uppercase' }}>
                  POROSI ONLINE
                </div>
                <div style={{ marginTop: 2, fontSize: 15.5, fontWeight: 900, color: '#f8fafc', lineHeight: 1.15 }}>
                  {orderTitle(activeOrder)}
                </div>
              </div>

              <button
                type="button"
                onClick={closeModal}
                style={{
                  appearance: 'none',
                  border: '1px solid rgba(255,255,255,0.08)',
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.04)',
                  color: '#fff',
                  fontSize: 15.5,
                  fontWeight: 900,
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            </div>

            <div style={bodyStyle}>
              <div style={glassCard}>
                <div style={{ display: 'grid', gap: 10 }}>
                  {hasRealCode(activeOrder) ? (
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.42)' }}>
                        T-Code
                      </div>
                      <div
                        style={{
                          marginTop: 6,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minHeight: 34,
                          padding: '5px 9px',
                          borderRadius: 12,
                          background: 'rgba(37,99,235,0.18)',
                          border: '1px solid rgba(96,165,250,0.28)',
                          color: '#93c5fd',
                          fontSize: 15,
                          fontWeight: 900,
                          letterSpacing: 0.3,
                        }}
                      >
                        {orderCode(activeOrder)}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '7px 12px',
                          borderRadius: 999,
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          fontSize: 12,
                          fontWeight: 900,
                          color: 'rgba(255,255,255,0.55)',
                          textTransform: 'uppercase',
                        }}
                      >
                        E RE
                      </span>
                    </div>
                  )}

                  <div>
                    <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 1.2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.42)' }}>
                      Adresa
                    </div>
                    <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.28, color: '#e5eefc', fontWeight: 800 }}>
                      {orderAddress(activeOrder)}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        borderRadius: 999,
                        padding: '5px 8px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        color: 'rgba(255,255,255,0.82)',
                        fontWeight: 800,
                        fontSize: 12,
                      }}
                    >
                      👤 {orderTitle(activeOrder)}
                    </span>
                    {currentPhone ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                          borderRadius: 999,
                          padding: '5px 8px',
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: 'rgba(255,255,255,0.82)',
                          fontWeight: 800,
                          fontSize: 12,
                        }}
                      >
                        📱 {currentPhone}
                      </span>
                    ) : null}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        borderRadius: 999,
                        padding: '5px 8px',
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        color: 'rgba(255,255,255,0.82)',
                        fontWeight: 800,
                        fontSize: 12,
                      }}
                    >
                      🧭 {activeCoords ? 'GPS i ruajtur' : 'GPS mungon'}
                    </span>
                    {actorRole ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                          borderRadius: 999,
                          padding: '5px 8px',
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: 'rgba(255,255,255,0.82)',
                          fontWeight: 800,
                          fontSize: 12,
                          textTransform: 'uppercase',
                        }}
                      >
                        🎯 {String(actorRole)}
                      </span>
                    ) : null}
                    {orderAssignedDriver(activeOrder) ? (
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 8,
                          borderRadius: 999,
                          padding: '5px 8px',
                          background: 'rgba(59,130,246,0.14)',
                          border: '1px solid rgba(59,130,246,0.28)',
                          color: '#93c5fd',
                          fontWeight: 900,
                          fontSize: 12,
                        }}
                      >
                        👷‍♂️ {orderAssignedDriver(activeOrder)}
                      </span>
                    ) : null}
                  </div>

                  {orderNote(activeOrder) ? (
                    <div style={{ marginTop: 14, padding: 8, borderRadius: 12, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.22)' }}>
                      <div style={{ fontSize: 10, fontWeight: 900, color: '#fcd34d', textTransform: 'uppercase', letterSpacing: 1.2 }}>
                        📝 Shënim nga Klienti
                      </div>
                      <div style={{ marginTop: 6, fontSize: 11.5, color: '#fef3c7', fontWeight: 800, lineHeight: 1.35 }}>
                        {orderNote(activeOrder)}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 7 }}>
                <ActionButton onClick={() => openHref(telHref)} disabled={!telHref}>
                  <span style={{ color: '#34d399' }}>📞</span>
                  <span>THIRR</span>
                </ActionButton>

                <ActionButton onClick={() => setTimeout(() => { onOpenSms && onOpenSms(activeOrder, 'transport_marrje'); }, ACTION_DEFER_MS)} disabled={!currentPhone}>
                  <span style={{ color: '#60a5fa' }}>💬</span>
                  <span>SMS</span>
                </ActionButton>

                <ActionButton
                  onClick={() => {
                    const row = activeOrder;
                    setActiveOrder(null);
                    setTimeout(() => { if (onOpenRack && row) onOpenRack(row); }, ACTION_DEFER_MS);
                  }}
                  disabled={!activeTrackUrl}
                >
                  <span style={{ color: '#34C759' }}>📍</span>
                  <span>RAFTI</span>
                </ActionButton>
              </div>

              <ActionButton onClick={() => handleSaveGps(activeOrder)} disabled={gpsBusy}>
                <span style={{ color: activeCoords ? '#2dd4bf' : '#fbbf24' }}>
                  {activeCoords ? '🗺️' : '📍'}
                </span>
                <span>
                  {gpsBusy
                    ? 'DUKE RUAJTUR GPS...'
                    : activeCoords
                    ? 'HARTA'
                    : 'RUAJ GPS'}
                </span>
              </ActionButton>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 7 }}>
                <ActionButton
                  onClick={() => handleOpenPranimi(activeOrder)}
                  disabled={!activeTrackUrl}
                  style={{
                    background: 'linear-gradient(180deg, rgba(30,64,175,0.72), rgba(15,23,42,0.96))',
                    border: '1px solid rgba(96,165,250,0.22)',
                    boxShadow: '0 18px 36px rgba(13,35,83,0.34)',
                  }}
                >
                  <span style={{ color: '#dbeafe' }}>📦</span>
                  <span>PRANIMI</span>
                </ActionButton>

                <ActionButton onClick={() => handleCancel(activeOrder)} disabled={cancelBusy}>
                  <span style={{ color: '#f87171' }}>🚫</span>
                  <span>{cancelBusy ? 'ANULIM...' : 'ANULO'}</span>
                </ActionButton>
              </div>

              <div style={glassCard}>
                <button
                  type="button"
                  onClick={() => setAssignOpen((v) => !v)}
                  style={{
                    appearance: 'none',
                    width: '100%',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: 14,
                    background: 'rgba(255,255,255,0.04)',
                    boxShadow: '0 18px 36px rgba(0,0,0,0.22)',
                    minHeight: 40,
                    padding: '7px 8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    color: '#fff',
                    fontWeight: 900,
                    fontSize: 11.5,
                    cursor: 'pointer',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: '#c4b5fd' }}>🔄</span>
                    <span>KALO TE SHOFER TJETËR</span>
                  </span>
                  <span style={{ fontSize: 20, color: 'rgba(255,255,255,0.62)' }}>{assignOpen ? '−' : '+'}</span>
                </button>

                {assignOpen ? (
                  <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                    {users.length ? (
                      users.map((user, idx) => {
                        const pin = String(user?.pin || user?.user_pin || '').trim();
                        const busy = assignBusyPin && assignBusyPin === pin;
                        return (
                          <button
                            key={keyFromUser(user, idx)}
                            type="button"
                            onClick={() => handleAssign(activeOrder, user)}
                            disabled={!pin || !!assignBusyPin}
                            style={{
                              appearance: 'none',
                              width: '100%',
                              minHeight: 38,
                              border: '1px solid rgba(255,255,255,0.08)',
                              borderRadius: 12,
                              background: 'rgba(255,255,255,0.035)',
                              color: '#fff',
                              fontWeight: 850,
                              fontSize: 11.5,
                              padding: '8px 10px',
                              textAlign: 'left',
                              boxShadow: '0 14px 28px rgba(0,0,0,0.18)',
                              cursor: !pin || assignBusyPin ? 'not-allowed' : 'pointer',
                              opacity: !pin || (assignBusyPin && !busy) ? 0.52 : 1,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 12,
                              backdropFilter: 'blur(10px)',
                              WebkitBackdropFilter: 'blur(10px)',
                            }}
                          >
                            <span style={{ display: 'grid', gap: 3 }}>
                              <span>{labelFromUser(user)}</span>
                              {pin ? (
                                <span style={{ color: 'rgba(255,255,255,0.46)', fontSize: 10, fontWeight: 800 }}>
                                  PIN {pin}
                                </span>
                              ) : null}
                            </span>
                            <span style={{ color: '#c4b5fd', fontWeight: 900 }}>
                              {busy ? 'DUKE KALUAR...' : 'ZGJIDH'}
                            </span>
                          </button>
                        );
                      })
                    ) : (
                      <div style={{ color: 'rgba(255,255,255,0.62)', fontWeight: 800 }}>
                        Nuk ka shoferë të listuar.
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export { InboxModule };
