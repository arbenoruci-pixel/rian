'use client';

import PublicFamilyPanel from '@/components/PublicFamilyPanel.jsx';
import { CustomerIcon, CustomerPortalStyles, portal } from '@/components/CustomerPortalUi.jsx';
import { familyRequest } from '@/lib/clientFamilyClient.js';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from '@/lib/routerCompat.jsx';
import { findLatestOrderByCode, resolveOrderById, updateOrderData, updateOrderGps } from '@/lib/ordersService';
import { extractPieces, extractTotal } from '@/lib/smartSms';

function V33PageOpenFallback() {
  return <div style={{ minHeight: '100dvh', background: '#f3f6f9', color: '#19334a', padding: 24, fontFamily: 'system-ui,sans-serif' }}>Duke hapur porosinë…</div>;
}

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
    order?.client_tcode ||
      order?.data?.transport_client_tcode ||
      order?.data?.client_tcode ||
      order?.data?.client?.transport_client_tcode ||
      order?.data?.client?.tcode ||
      order?.code_str ||
      order?.code ||
      order?.data?.code ||
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
  const rawId = String(params?.id || '').trim();
  const isShort = rawId.startsWith('s_');
  const [link, setLink] = useState(null);
  const [linkError, setLinkError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLink(null); setLinkError('');
    if (isShort) familyRequest({ action: 'RESOLVE_LINK', token: rawId }, { signal: controller.signal })
      .then(result => {
        if (!['BASE', 'TRANSPORT'].includes(result.source) || !result.orderId) throw new Error('LINK_INVALID');
        if (active) setLink({ ...result, key: rawId });
      })
      .catch(() => { if (active && !controller.signal.aborted) setLinkError('Linku nuk u hap. Provoje përsëri ose kërko një mesazh të ri.'); });
    return () => { active = false; controller.abort(); };
  }, [rawId, isShort, retry]);
  if (isShort) {
    if (link?.key !== rawId) return <main style={{ minHeight: '100vh', background: '#0b1220', color: '#fff', padding: 24, textAlign: 'center' }}>
      <p role={linkError ? 'alert' : 'status'}>{linkError || 'Duke hapur tepihat…'}</p>
      {linkError && <button type="button" onClick={() => setRetry(value => value + 1)}>Provo përsëri</button>}
    </main>;
    return <OrderTrackingContent key={rawId} id={String(link.orderId)} srcHint={link.source.toLowerCase()} familyToken={link.token} />;
  }
  const source = String(searchParams?.get('src') || searchParams?.get('table') || searchParams?.get('type') || '').trim().toLowerCase();
  const srcHint = ['transport', 'transport_orders'].includes(source) ? 'transport' : ['base', 'orders'].includes(source) ? 'base' : '';
  return <OrderTrackingContent key={`${rawId}:${srcHint}`} id={rawId} srcHint={srcHint} familyToken={String(searchParams?.get('family') || '')} />;
}

function OrderTrackingContent({ id, srcHint, familyToken }) {
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

        if (srcHint === 'base') {
          // src=base is a hard table boundary: exact orders.id first, then only the
          // legacy Base client code. It must never fall through from 1032 to T1032.
          resolved = await resolveOrderById(rawId, 'base', '*');
        } else {
          // Keep pre-source Transport links compatible while isolating them from Base.
          if (!resolved && (isTransportCode || isShortNumeric)) {
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

          if (!resolved && isUuid) {
            resolved = await resolveOrderById(rawId, 'transport', '*');
          }
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
    ? ['Pranimi', 'Në pastrim', 'Gati për tërheqje', 'Përfunduar']
    : ['Marrja e tepihave', 'Në pastrim', 'Gati', 'Në dërgesë', 'Përfunduar'];

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
      setGpsNotice('Lokacioni u dërgua.');
    } catch (err) {
      const geoCode = err?.code;
      if (geoCode === 1) {
        setGpsError('GPS është i bllokuar. Ju lutem lejojeni lokacionin nga shfletuesi dhe provoni sërish.');
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

  const statusLabel = isCancelled ? 'E anuluar' : isDepo ? 'Në depo' : ['assigned', 'dispatched', 'riplan'].includes(status) ? 'E planifikuar' : STEP_LABELS[activeStep];
  const stepIcons = isBase ? ['rug', 'wash', 'box', 'check'] : ['truck', 'wash', 'box', 'truck', 'check'];
  return (
    <main className="customer-portal" style={styles.page}>
      <CustomerPortalStyles />
      <div style={styles.shell}>
        <header style={styles.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ ...portal.icon, background: '#19334a', color: '#fff', width: 42, height: 42 }}><CustomerIcon name="rug" size={25} /></span>
            <div><div style={{ fontSize: 21, letterSpacing: 2, fontWeight: 750, color: '#19334a' }}>JONI</div><div style={{ color: '#64798a', fontSize: 12, marginTop: 2 }}>Pastrimi i tepihave</div></div>
          </div>
          <a href={`tel:${COMPANY_PHONE}`} aria-label="Telefono kompaninë JONI" style={{ ...portal.icon, background: '#fff', color: '#355c72', border: '1px solid #dde5ec' }}><CustomerIcon name="phone" size={19} /></a>
        </header>
        {loading ? <div style={portal.card}><p style={portal.copy}>Duke ngarkuar porosinë…</p></div> : error ? (
          <div style={portal.card}>
            <div style={portal.heading}><CustomerIcon name="alert" /><h1 style={portal.title}>Nuk u ngarkua porosia</h1></div>
            <p role="alert" style={portal.error}>{error}</p>
            <button style={{ ...portal.button, marginTop: 14 }} onClick={() => window.location.reload()}>Provo përsëri</button>
          </div>
        ) : <>
          <section className="portal-card" aria-label="Porosia juaj" style={portal.card}>
            <div style={{ color: '#64798a', fontSize: 13, marginBottom: 5 }}>Përshëndetje,</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <h1 style={{ fontSize: 24, lineHeight: 1.25, margin: 0, color: '#19334a', fontWeight: 650, overflowWrap: 'anywhere' }}>{clientName || 'Klient'}</h1>
              <span style={{ fontSize: 13, background: '#f0f4f8', color: '#355168', borderRadius: 8, padding: '7px 10px', fontWeight: 600 }}>Kodi {code}</span>
            </div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: isCancelled ? '#a53131' : '#08715f', background: isCancelled ? '#fff0ee' : '#e8f5ef', padding: '7px 10px', borderRadius: 8, marginTop: 13, fontSize: 12, fontWeight: 600 }}><CustomerIcon name={isCancelled ? 'alert' : activeStep === STEP_LABELS.length - 1 ? 'check' : 'clock'} size={15} />{statusLabel}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, borderTop: '1px solid #e8edf1', paddingTop: 14, marginTop: 16, fontSize: 13, color: '#64798a' }}>
              <span>Copë <strong style={{ color: '#19334a', fontWeight: 600, marginLeft: 5 }}>{isWaitingStep ? '—' : pieces}</strong></span>
              <span>Totali <strong style={{ color: '#19334a', fontWeight: 600, marginLeft: 5 }}>{isWaitingStep && !pieces && !total ? 'Pas matjes' : `€ ${formatMoney(total)}`}</strong></span>
            </div>
          </section>

          <PublicFamilyPanel token={familyToken} source={isBase ? 'BASE' : 'TRANSPORT'} orderId={order?.id} />

          {smsCount > 0 && !needsDepotChoice && !depotChoice && <p style={{ ...portal.copy, fontSize: 13 }}>Tentativa të dërgesës: {Math.min(smsCount, 3)} / 3</p>}
          {needsDepotChoice ? (
            <section style={{ ...portal.card, borderColor: '#e8d4ab', background: '#fffcf4' }}>
              <div style={portal.heading}><CustomerIcon name="box" /><h2 style={portal.title}>Tepihat janë në depo</h2></div>
              <p style={portal.copy}>Zgjidhni nëse dëshironi dërgesë tjetër apo t’i merrni vetë në depo.</p>
              <button disabled={submittingChoice} onClick={() => handleDepotChoice('resend')} style={portal.button}><CustomerIcon name="truck" size={18} />{submittingChoice ? 'Po dërgohet…' : 'Sillni përsëri (+5,00 €)'}</button>
              <button disabled={submittingChoice} onClick={() => handleDepotChoice('pickup')} style={{ ...portal.button, ...portal.secondary, marginTop: 10 }}><CustomerIcon name="pin" size={18} />Vij i marr në depo</button>
            </section>
          ) : depotChoice ? (
            <section style={portal.card}>
              <p style={{ ...portal.success, marginTop: 0 }}><CustomerIcon name="check" />Zgjedhja u regjistrua.</p>
              <p style={{ ...portal.copy, margin: '10px 0 0' }}>{depotChoice === 'resend' ? 'Dërgesë tjetër: +5,00 €. Shoferi do t’ju kontaktojë.' : 'Ju mirëpresim t’i merrni tepihat në depo.'}</p>
            </section>
          ) : isWaitingStep && !familyToken ? (
            <section style={portal.card}>
              <button type="button" onClick={handleSendGps} disabled={gpsBusy} style={portal.button}><CustomerIcon name="pin" size={18} />{gpsBusy ? 'Po dërgohet…' : 'Dërgo lokacionin tim'}</button>
              <p style={{ ...portal.copy, margin: '10px 0 0', fontSize: 13 }}>Preke kur je aty ku duhet të vijë shoferi. Lokacioni i dërgohet për këtë porosi.</p>
              {gpsNotice && <p role="status" style={portal.success}>{gpsNotice}</p>}
              {gpsError && <p role="alert" style={portal.error}>{gpsError}</p>}
            </section>
          ) : null}

          <details className="portal-card" style={portal.card}>
            <summary style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, color: '#19334a', fontSize: 16, fontWeight: 600 }}><span style={{ display: 'flex', alignItems: 'center', gap: 10 }}><CustomerIcon name="box" />Statusi</span><CustomerIcon name="chevron" size={18} className="portal-chevron" /></summary>
            <ol style={{ listStyle: 'none', padding: 0, margin: '16px 0 0', display: 'grid', gap: 6 }}>
              {STEP_LABELS.map((label, index) => {
                const state = getStepState(index, activeStep, isCancelled);
                return <li key={label} aria-current={state === 'active' ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 10, padding: '10px 8px', background: state === 'active' ? '#eaf5f1' : 'transparent', color: state === 'pending' ? '#7a8b98' : '#205e50', fontSize: 14, fontWeight: state === 'active' ? 600 : 400 }}><CustomerIcon name={state === 'done' ? 'check' : stepIcons[index]} size={19} /><span>{label}</span>{state === 'active' && <span style={{ marginLeft: 'auto', fontSize: 11 }}>Tani</span>}</li>;
              })}
            </ol>
          </details>
          <footer style={{ textAlign: 'center', padding: '4px 0 12px' }}>
            <a href={`tel:${COMPANY_PHONE}`} style={{ ...portal.button, ...portal.secondary, background: '#fff' }}><CustomerIcon name="phone" size={18} />Na kontaktoni</a>
            <div style={{ marginTop: 12, color: '#64798a', fontSize: 12 }}>Kompania JONI · +383 44 735 312</div>
          </footer>
        </>}
      </div>
    </main>
  );
}

const styles = {
  page: { minHeight: '100dvh', background: '#f3f6f9', color: '#19334a', padding: '20px 16px calc(24px + env(safe-area-inset-bottom))', overflowWrap: 'anywhere' },
  shell: { maxWidth: 520, margin: '0 auto' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 2px 22px' },
};

export default function OrderTrackingPage() {
  return (
    <Suspense fallback={null}>
      <OrderTrackingPageInner />
    </Suspense>
  );
}
