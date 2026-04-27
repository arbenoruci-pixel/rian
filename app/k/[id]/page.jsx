'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from '@/lib/routerCompat.jsx';
import { fetchOrderByIdSafe, findLatestOrderByCode, resolveOrderById, updateOrderData, updateOrderGps } from '@/lib/ordersService';
import { extractPieces, extractTotal } from '@/lib/smartSms';

function V33PageOpenFallback() {
  return (
    <div style={{ minHeight: '100vh', background: '#05070d', color: '#fff', display: 'grid', placeItems: 'center', padding: 24, fontFamily: '-apple-system,BlinkMacSystemFont,Roboto,sans-serif' }}>
      <div style={{ width: 'min(420px, 100%)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 20, background: 'rgba(255,255,255,0.06)', padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>DUKE HAPUR…</div>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/" style={{ color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 12, padding: '10px 14px', fontWeight: 900 }}>HOME</a>
          <a href="/diag-raw" style={{ color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 12, padding: '10px 14px', fontWeight: 900 }}>DIAG RAW</a>
        </div>
      </div>
    </div>
  );
}

const PAGE_BG = 'linear-gradient(180deg, #0b1220 0%, #0a0f1c 55%, #090d18 100%)';
const COMPANY_PHONE = '+38344735312';

function normalizeStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function getPieces(order) {
  return extractPieces(order || {});
}

function getTotal(order) {
  return extractTotal(order || {});
}

function getName(order) {
  const n = order?.client_name || order?.data?.client_name || order?.client?.name || order?.data?.client?.name || order?.data?.client?.full_name || '';
  return String(n).trim();
}

function formatMoney(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function getCode(order) {
  return String(
    order?.code_str ||
      order?.client_tcode ||
      order?.code ||
      order?.data?.code ||
      order?.data?.client_tcode ||
      '-'
  );
}

function getStepState(index, activeIndex, isCancelled) {
  if (isCancelled) return 'pending';
  if (index < activeIndex) return 'done';
  if (index === activeIndex) return 'active';
  return 'pending';
}

function OrderTrackingPageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = useMemo(() => String(params?.id || '').trim(), [params]);
  const srcHint = useMemo(() => {
    const raw = String(searchParams?.get('src') || searchParams?.get('table') || searchParams?.get('type') || '').trim().toLowerCase();
    if (raw === 'transport' || raw === 'transport_orders') return 'transport';
    if (raw === 'base' || raw === 'orders') return 'base';
    return '';
  }, [searchParams]);

  const [order, setOrder] = useState(null);
  const [orderType, setOrderType] = useState('transport'); // 'transport' or 'base'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsNotice, setGpsNotice] = useState('');
  const [gpsError, setGpsError] = useState('');
  const [submittingChoice, setSubmittingChoice] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadOrder() {
      if (!id) {
        setError('ID e porosisë mungon.');
        setLoading(false);
        return;
      }

      setLoading(true);
      setError('');

      try {
        const rawId = String(id || '').trim();
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
        const isTransportCode = /^t\d+$/i.test(rawId);
        const isShortNumeric = /^\d+$/.test(rawId);

        let resolved = null;

        if (srcHint === 'base' && isShortNumeric) {
          const baseById = await fetchOrderByIdSafe('orders', rawId, '*').catch(() => null);
          if (baseById) {
            resolved = { table: 'orders', row: baseById };
          }
        }

        // Tracking i transportit duhet të pranojë si T43 ashtu edhe 43.
        // Për këto raste provo gjithmonë client_tcode te transport_orders para fallback-eve të tjera.
        if (!resolved && (srcHint === 'transport' || isTransportCode || isShortNumeric)) {
          const transportLookupKey = isShortNumeric ? `T${rawId}` : rawId.toUpperCase();
          const transportByCode = await findLatestOrderByCode('transport_orders', transportLookupKey, '*');
          if (transportByCode) {
            resolved = { table: 'transport_orders', row: transportByCode };
          }
        }

        if (!resolved) {
          const effectiveHint = srcHint || (isTransportCode ? 'transport' : '');
          resolved = await resolveOrderById(rawId, effectiveHint, '*');
        }

        // Fallback shtesë: nëse kemi UUID, por resolve dështoi, provo si transport direkt.
        if (!resolved && isUuid) {
          resolved = await resolveOrderById(rawId, 'transport', '*');
        }

        const orderData = resolved?.row || null;
        const type = resolved?.table === 'orders' ? 'base' : 'transport';

        if (!orderData) throw new Error('Porosia nuk u gjet.');

        if (!cancelled) {
          setOrder(orderData);
          setOrderType(type);
        }
      } catch (err) {
        if (!cancelled) {
          setOrder(null);
          setError(err?.message || 'Ndodhi një gabim gjatë ngarkimit të porosisë.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadOrder();
    return () => {
      cancelled = true;
    };
  }, [id, srcHint]);

  const status = normalizeStatus(order?.status || order?.statusi);
  const isCancelled = status === 'cancelled';
  const isBase = orderType === 'base';

  // Hapat sipas tipit të porosisë (Baza vs Transporti)
  const STEP_LABELS = isBase
    ? ['🏢 Pranimi', '💦 Në Pastrim', '📦 Gati (Ejani merreni)', '✅ Përfunduar']
    : ['🚐 Marrja e Porosisë', '💦 Në Pastrim', '📦 Gati', '🚚 Në Rrugë', '✅ Përfunduar'];

  // Gjetja e hapit aktual
  let activeStep = 0;
  if (isBase) {
    if (['new', 'inbox', 'pranim', 'marrje'].includes(status)) activeStep = 0;
    else if (['pastrim', 'loaded'].includes(status)) activeStep = 1;
    else if (status === 'gati') activeStep = 2;
    else if (['dorzim', 'dorezim', 'done'].includes(status)) activeStep = 3;
  } else {
    if (['new', 'inbox', 'pickup', 'pranim', 'dispatched', 'assigned', 'riplan'].includes(status)) activeStep = 0;
    else if (['loaded', 'pastrim'].includes(status)) activeStep = 1;
    else if (status === 'gati') activeStep = 2;
    else if (['delivery'].includes(status)) activeStep = 3;
    else if (['dorzim', 'dorezim', 'done'].includes(status)) activeStep = 4;
  }

  const code = getCode(order);
  const pieces = getPieces(order || {});
  const total = getTotal(order || {});
  const clientName = getName(order || {});
  const isWaitingStep = activeStep === 0;

  const smsCount = Number(order?.data?.sms_count || 0);
  const isDepo = status === 'ne_depo' || smsCount >= 3;
  const depotChoice = String(order?.data?.tracking_choice || order?.data?.depot_choice || order?.tracking_choice || '')
    .trim()
    .toLowerCase();
  const needsDepotChoice = isDepo && !depotChoice;

  async function handleDepotChoice(choice) {
    if (!order?.id || orderType !== 'transport') return;
    setSubmittingChoice(true);
    try {
      const nextData = {
        ...(order.data || {}),
        tracking_choice: choice,
        depot_fee: choice === 'resend' ? 5 : 0,
      };
      await updateOrderData('transport_orders', order.id, nextData);
      setOrder({ ...order, data: nextData, updated_at: new Date().toISOString() });
    } catch (err) {
      alert('Gabim gjatë dërgimit të kërkesës!');
    } finally {
      setSubmittingChoice(false);
    }
  }

  async function handleSendGps() {
    setGpsNotice('');
    setGpsError('');

    if (!order?.id) {
      setGpsError('Porosia nuk u gjet. Rifreskoni faqen dhe provoni sërish.');
      return;
    }

    if (typeof window === 'undefined' || !navigator?.geolocation) {
      setGpsError('Pajisja juaj nuk e mbështet dërgimin e lokacionit.');
      return;
    }

    setGpsBusy(true);

    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0,
        });
      });

      const lat = Number(position?.coords?.latitude);
      const lng = Number(position?.coords?.longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error('Koordinatat GPS nuk u lexuan saktë.');
      }

      const table = orderType === 'base' ? 'orders' : 'transport_orders';
      await updateOrderGps(table, order.id, lat, lng);
      setOrder((prev) => ({
        ...(prev || {}),
        gps_lat: lat,
        gps_lng: lng,
        data: {
          ...((prev?.data && typeof prev.data === 'object' && !Array.isArray(prev.data)) ? prev.data : {}),
          gps_lat: lat,
          gps_lng: lng,
        },
      }));
      setGpsNotice('✅ Lokacioni juaj u dërgua me sukses. Shoferi tani mund ta shohë GPS-in tuaj.');
    } catch (err) {
      const geoCode = err?.code;
      if (geoCode === 1) {
        setGpsError('🔒 GPS është i bllokuar. Ju lutem lejojeni lokacionin nga shfletuesi dhe provoni sërish.');
      } else if (geoCode === 2) {
        setGpsError('GPS nuk u gjet. Dilni pak më afër dritares ose provoni përsëri pas pak.');
      } else if (geoCode === 3) {
        setGpsError('Marrja e GPS-it mori shumë kohë. Provoni sërish pas pak sekondash.');
      } else {
        setGpsError(err?.message || 'Nuk u arrit të dërgohet lokacioni juaj.');
      }
    } finally {
      setGpsBusy(false);
    }
  }

  return (
    <div style={styles.page}>
      <style>{`
        @keyframes pulse {
          0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(10,132,255,0.45); }
          70% { transform: scale(1.02); box-shadow: 0 0 0 14px rgba(10,132,255,0); }
          100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(10,132,255,0); }
        }
      `}</style>

      <div style={styles.shell}>
        <div style={styles.headerWrap}>
          <div style={styles.eyebrow}>LIVE TRACKING</div>
          <h1 style={styles.title}>JONI - Pastrimi i Tepihave</h1>
          <p style={styles.subtitle}>Ndiqeni progresin e porosisë suaj në kohë reale.</p>
        </div>

        {loading ? (
          <div style={styles.stateCard}>
            <div style={styles.stateEmoji}>⏳</div>
            <div style={styles.stateTitle}>Duke u ngarkuar...</div>
            <div style={styles.stateText}>Po marrim të dhënat e porosisë suaj.</div>
          </div>
        ) : error ? (
          <div style={styles.stateCard}>
            <div style={styles.stateEmoji}>⚠️</div>
            <div style={styles.stateTitle}>Nuk u ngarkua porosia</div>
            <div style={styles.stateText}>{error}</div>
            <button style={{ marginTop: 14, padding: '12px 16px', borderRadius: 12, background: '#0A84FF', color: '#fff', border: 'none', fontWeight: 900, cursor: 'pointer' }} onClick={() => { setError(''); setLoading(true); setTimeout(() => { try { window.dispatchEvent(new CustomEvent('tepiha:k-page-soft-retry')); } catch {} setLoading(false); }, 120); }}>RIPROVO</button>
          </div>
        ) : (
          <>
            <div style={styles.glassCard}>
              <div style={styles.cardGrid}>
                {clientName && (
                  <div style={{ ...styles.infoBox, gridColumn: '1 / -1' }}>
                    <div style={styles.infoLabel}>Klienti</div>
                    <div style={{ ...styles.infoValue, fontSize: 22, color: '#fff' }}>{clientName}</div>
                  </div>
                )}
                <div style={styles.infoBox}>
                  <div style={styles.infoLabel}>Kodi</div>
                  <div style={styles.infoValue}>{isWaitingStep ? 'Në pritje...' : code}</div>
                </div>
                <div style={styles.infoBox}>
                  <div style={styles.infoLabel}>Total Copë</div>
                  <div style={styles.infoValue}>{isWaitingStep ? 'Në pritje...' : pieces}</div>
                </div>
                <div style={{ ...styles.infoBox, gridColumn: '1 / -1' }}>
                  <div style={styles.infoLabel}>Totali (€)</div>
                  <div style={styles.infoValue}>€ {formatMoney(total)}</div>
                </div>
              </div>
            </div>

            {smsCount > 0 && !needsDepotChoice && !depotChoice ? (
              <div
                style={{
                  ...styles.glassCard,
                  marginTop: 12,
                  padding: '14px 16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 900,
                    color: 'rgba(255,255,255,0.85)',
                    letterSpacing: 0.5,
                  }}
                >
                  TENTATIVAT E DËRGESËS:
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[0, 1, 2].map((idx) => {
                    const isOn = idx < smsCount;
                    return (
                      <span
                        key={idx}
                        style={{
                          width: 14,
                          height: 14,
                          borderRadius: 999,
                          background: isOn ? '#FF9F0A' : 'transparent',
                          border: `2px solid ${isOn ? '#FF9F0A' : 'rgba(255,255,255,0.25)'}`,
                          boxShadow: isOn ? '0 0 0 4px rgba(255,159,10,0.15)' : 'none',
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}

            {needsDepotChoice ? (
              <div style={{ ...styles.glassCard, marginTop: 20, padding: 24, textAlign: 'center', border: '1px solid rgba(255,59,48,0.5)', background: 'rgba(255,59,48,0.1)' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
                <h3 style={{ color: '#FF3B30', marginTop: 0, marginBottom: 10, fontSize: 20, fontWeight: 900 }}>Porosia ndodhet në Depo!</h3>
                <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5, marginBottom: 20 }}>
                  Kemi provuar t'ju kontaktojmë 3 herë pa sukses. Sipas rregullores, porosia është kthyer në depo. Zgjidhni si dëshironi të veproni:
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <button
                    disabled={submittingChoice}
                    onClick={() => handleDepotChoice('resend')}
                    style={{ padding: '16px', borderRadius: 14, background: '#0A84FF', color: '#fff', fontWeight: 900, border: 'none', cursor: 'pointer', fontSize: 14 }}
                  >
                    {submittingChoice ? 'DUKE DËRGUAR...' : '🔄 SILLNI PRAPË (+5.00 € Extra)'}
                  </button>
                  <button
                    disabled={submittingChoice}
                    onClick={() => handleDepotChoice('pickup')}
                    style={{ padding: '16px', borderRadius: 14, background: 'rgba(255,255,255,0.08)', color: '#fff', fontWeight: 900, border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', fontSize: 14 }}
                  >
                    📍 VIJ I MARR VETË NË DEPO
                  </button>
                </div>
              </div>
            ) : depotChoice ? (
              <div style={{ ...styles.glassCard, marginTop: 20, padding: 24, textAlign: 'center', border: '1px solid rgba(52,199,89,0.4)', background: 'rgba(52,199,89,0.1)' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
                <h3 style={{ color: '#34C759', marginTop: 0, marginBottom: 10, fontSize: 18, fontWeight: 900 }}>Zgjedhja juaj u regjistrua!</h3>
                <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5 }}>
                  {depotChoice === 'resend'
                    ? 'Keni zgjedhur rikthimin e porosisë (+5.00 € tarifë ekstra). Transporti do t\'ju kontaktojë së shpejti për t\'ua sjellë.'
                    : 'Keni zgjedhur t\'i merrni vetë. Ju mirëpresim në depon tonë!'}
                </p>
              </div>
            ) : isWaitingStep ? (
              <div style={styles.glassCard}>
                <div style={styles.gpsCardTitle}>📍 Dërgojeni lokacionin tuaj shoferit</div>
                <div style={styles.gpsCardText}>
                  Nëse e shtypni butonin më poshtë, shoferi do ta marrë GPS-in tuaj të saktë për ta gjetur adresën më shpejt.
                </div>
                <button
                  type="button"
                  onClick={handleSendGps}
                  disabled={gpsBusy}
                  style={{
                    ...styles.gpsBtn,
                    ...(gpsBusy ? styles.gpsBtnDisabled : {}),
                  }}
                >
                  {gpsBusy ? '⏳ DUKE DËRGUAR GPS...' : '📍 DËRGO LOKACIONIN TIM (GPS) PËR SHOFERIN'}
                </button>

                {gpsNotice ? <div style={styles.gpsSuccessBox}>{gpsNotice}</div> : null}
                {gpsError ? <div style={styles.gpsErrorBox}>{gpsError}</div> : null}
              </div>
            ) : null}

            <div style={styles.glassCard}>
              <div style={styles.progressHeader}>
                <div style={styles.progressTitle}>Statusi i Porosisë</div>
                <div style={styles.progressStatusPill(isCancelled)}>
                  {isCancelled ? '❌ E anuluar' : (status === 'gati' ? 'Gati' : (status === 'pastrim' ? 'Në pastrim' : order?.status || 'Në proces'))}
                </div>
              </div>

              <div style={styles.timeline}>
                {STEP_LABELS.map((label, index) => {
                  const state = getStepState(index, activeStep, isCancelled);
                  const isActive = state === 'active';
                  const isDone = state === 'done';
                  const isLast = index === STEP_LABELS.length - 1;

                  return (
                    <div key={label} style={styles.stepRow}>
                      <div style={styles.stepRailWrap}>
                        <div
                          style={{
                            ...styles.stepDot,
                            ...(isDone ? styles.stepDotDone : {}),
                            ...(isActive ? styles.stepDotActive : {}),
                          }}
                        />
                        {!isLast ? (
                          <div
                            style={{
                              ...styles.stepLine,
                              ...(isDone ? styles.stepLineDone : {}),
                              ...(isActive ? styles.stepLineActive : {}),
                            }}
                          />
                        ) : null}
                      </div>

                      <div
                        style={{
                          ...styles.stepCard,
                          ...(isDone ? styles.stepCardDone : {}),
                          ...(isActive ? styles.stepCardActive : {}),
                        }}
                      >
                        <div style={styles.stepLabel}>{label}</div>
                        <div style={styles.stepMeta}>
                          {isCancelled
                            ? 'Kjo porosi është anuluar.'
                            : isDone
                              ? 'Hap i përfunduar.'
                              : isActive
                                ? 'Ky është hapi aktual.'
                                : 'Në pritje.'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <a href={`tel:${COMPANY_PHONE}`} style={styles.callBtn}>
              📞 KONTAKTO KOMPANINË
            </a>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100dvh',
    background: PAGE_BG,
    color: '#F5F7FB',
    padding: '20px 14px 28px',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shell: {
    maxWidth: 560,
    margin: '0 auto',
  },
  headerWrap: {
    padding: '8px 4px 18px',
  },
  eyebrow: {
    fontSize: 12,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.58)',
    fontWeight: 800,
    marginBottom: 8,
  },
  title: {
    margin: 0,
    fontSize: 30,
    lineHeight: 1.05,
    fontWeight: 900,
    letterSpacing: '-0.03em',
  },
  subtitle: {
    margin: '10px 0 0',
    fontSize: 14,
    lineHeight: 1.5,
    color: 'rgba(255,255,255,0.72)',
  },
  glassCard: {
    background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04))',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 24,
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
    boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
    padding: 16,
    marginBottom: 16,
  },
  
  // STILE E REJA QË I KISHTE HARRUAR KODI I MËPARSHËM
  depotCard: {
    border: '1px solid rgba(255,69,58,0.3)',
    background: 'linear-gradient(180deg, rgba(255,69,58,0.15), rgba(255,69,58,0.05))',
  },
  depotTitle: {
    fontSize: 20,
    fontWeight: 900,
    color: '#FF453A',
    marginBottom: 8,
  },
  depotText: {
    fontSize: 14,
    lineHeight: 1.5,
    color: 'rgba(255,255,255,0.76)',
    marginBottom: 16,
  },
  depotButtonsWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  choiceBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    minHeight: 52,
    borderRadius: 14,
    padding: '0 16px',
    fontSize: 15,
    fontWeight: 800,
    color: '#fff',
    cursor: 'pointer',
    border: 'none',
  },
  choiceBtnBlue: {
    background: 'rgba(10,132,255,0.2)',
    border: '1px solid rgba(10,132,255,0.4)',
  },
  choiceBtnGreen: {
    background: 'rgba(52,199,89,0.2)',
    border: '1px solid rgba(52,199,89,0.4)',
  },
  choiceBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  choicePriceBlue: {
    color: '#64D2FF',
  },
  choicePriceGreen: {
    color: '#30D158',
  },
  // FUNDI I STILEVE TË REJA

  stateCard: {
    background: 'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04))',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 24,
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
    boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
    padding: '28px 18px',
    textAlign: 'center',
    marginTop: 12,
  },
  stateEmoji: {
    fontSize: 34,
    marginBottom: 10,
  },
  stateTitle: {
    fontSize: 20,
    fontWeight: 900,
    marginBottom: 8,
  },
  stateText: {
    fontSize: 14,
    lineHeight: 1.5,
    color: 'rgba(255,255,255,0.72)',
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
  },
  infoBox: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 18,
    padding: 14,
    minHeight: 88,
  },
  infoLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    color: 'rgba(255,255,255,0.6)',
    marginBottom: 8,
    fontWeight: 800,
  },
  infoValue: {
    fontSize: 26,
    lineHeight: 1.05,
    fontWeight: 900,
    letterSpacing: '-0.03em',
    wordBreak: 'break-word',
  },
  gpsCardTitle: {
    fontSize: 18,
    fontWeight: 900,
    marginBottom: 8,
  },
  gpsCardText: {
    fontSize: 14,
    lineHeight: 1.55,
    color: 'rgba(255,255,255,0.76)',
    marginBottom: 14,
  },
  gpsBtn: {
    width: '100%',
    minHeight: 62,
    borderRadius: 18,
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'linear-gradient(180deg, rgba(10,132,255,0.95), rgba(88,86,214,0.92))',
    color: '#fff',
    fontSize: 15,
    fontWeight: 900,
    letterSpacing: 0.2,
    padding: '14px 16px',
    boxShadow: '0 18px 38px rgba(10,132,255,0.24)',
  },
  gpsBtnDisabled: {
    opacity: 0.72,
    filter: 'saturate(0.9)',
  },
  gpsSuccessBox: {
    marginTop: 12,
    borderRadius: 18,
    padding: '13px 14px',
    background: 'linear-gradient(180deg, rgba(52,199,89,0.18), rgba(52,199,89,0.1))',
    border: '1px solid rgba(52,199,89,0.3)',
    color: '#F5FFF7',
    fontSize: 14,
    lineHeight: 1.5,
    fontWeight: 700,
  },
  gpsErrorBox: {
    marginTop: 12,
    borderRadius: 18,
    padding: '13px 14px',
    background: 'linear-gradient(180deg, rgba(255,159,10,0.2), rgba(255,69,58,0.12))',
    border: '1px solid rgba(255,159,10,0.28)',
    color: '#FFF7ED',
    fontSize: 14,
    lineHeight: 1.5,
    fontWeight: 700,
  },
  progressHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  progressTitle: {
    fontSize: 18,
    fontWeight: 900,
  },
  progressStatusPill: (isCancelled) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: '#fff',
    background: isCancelled ? 'rgba(255,69,58,0.24)' : 'rgba(10,132,255,0.2)',
    border: `1px solid ${isCancelled ? 'rgba(255,69,58,0.34)' : 'rgba(10,132,255,0.34)'}`,
  }),
  timeline: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  stepRow: {
    display: 'grid',
    gridTemplateColumns: '28px 1fr',
    gap: 12,
    alignItems: 'stretch',
  },
  stepRailWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  stepDot: {
    width: 18,
    height: 18,
    borderRadius: 999,
    background: 'rgba(255,255,255,0.18)',
    border: '2px solid rgba(255,255,255,0.16)',
    marginTop: 6,
    flexShrink: 0,
  },
  stepDotDone: {
    background: '#34C759',
    borderColor: 'rgba(52,199,89,0.9)',
    boxShadow: '0 0 0 6px rgba(52,199,89,0.14)',
  },
  stepDotActive: {
    background: '#0A84FF',
    borderColor: 'rgba(10,132,255,0.95)',
    boxShadow: '0 0 0 8px rgba(10,132,255,0.14)',
    animation: 'pulse 1.8s infinite',
  },
  stepLine: {
    width: 3,
    flex: 1,
    minHeight: 48,
    borderRadius: 999,
    marginTop: 6,
    background: 'rgba(255,255,255,0.12)',
  },
  stepLineDone: {
    background: 'linear-gradient(180deg, rgba(52,199,89,0.95), rgba(52,199,89,0.5))',
  },
  stepLineActive: {
    background: 'linear-gradient(180deg, rgba(10,132,255,0.95), rgba(10,132,255,0.24))',
  },
  stepCard: {
    background: 'rgba(255,255,255,0.045)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 18,
    padding: '14px 14px 13px',
  },
  stepCardDone: {
    background: 'linear-gradient(180deg, rgba(52,199,89,0.16), rgba(52,199,89,0.08))',
    border: '1px solid rgba(52,199,89,0.3)',
  },
  stepCardActive: {
    background: 'linear-gradient(180deg, rgba(10,132,255,0.2), rgba(10,132,255,0.08))',
    border: '1px solid rgba(10,132,255,0.34)',
  },
  stepLabel: {
    fontSize: 17,
    lineHeight: 1.2,
    fontWeight: 900,
    letterSpacing: '-0.02em',
  },
  stepMeta: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 1.45,
    color: 'rgba(255,255,255,0.68)',
  },
  callBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 60,
    marginTop: 8,
    borderRadius: 18,
    textDecoration: 'none',
    color: '#fff',
    fontSize: 16,
    fontWeight: 900,
    letterSpacing: 0.3,
    background: 'linear-gradient(180deg, rgba(52,199,89,0.95), rgba(10,132,255,0.88))',
    boxShadow: '0 18px 36px rgba(10,132,255,0.2)',
    border: '1px solid rgba(255,255,255,0.18)',
  },
};
export default function OrderTrackingPage() {
  return (
    <Suspense fallback={<V33PageOpenFallback />}>
      <OrderTrackingPageInner />
    </Suspense>
  );
}
