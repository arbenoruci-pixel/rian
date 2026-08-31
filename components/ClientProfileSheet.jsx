'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/lib/routerCompat.jsx';
import SmartSmsModal from '@/components/SmartSmsModal';
import { buildHomeSearchHref } from '@/lib/homeSearch';
import { buildClientProfileAnchor } from '@/lib/clientProfileIdentity';
import { fetchClientProfile, readCachedClientProfile } from '@/lib/clientProfileClient';
import { buildClientProfileSmartSms } from '@/lib/clientProfileSmartSms';

const TABS = Object.freeze([
  { key: 'ACTIVE', label: 'AKTIVE' },
  { key: 'HISTORY', label: 'HISTORIA' },
  { key: 'PAYMENTS', label: 'PAGESAT' },
  { key: 'INFO', label: 'INFO' },
]);

const TERMINAL_LABELS = Object.freeze({
  done: 'PËRFUNDUAR',
  completed: 'PËRFUNDUAR',
  complete: 'PËRFUNDUAR',
  delivered: 'DORËZUAR',
  dorezuar: 'DORËZUAR',
  dorëzuar: 'DORËZUAR',
  cancelled: 'ANULUAR',
  canceled: 'ANULUAR',
  anuluar: 'ANULUAR',
  archived: 'ARKIVUAR',
});

const STATUS_LABELS = Object.freeze({
  draft: 'DRAFT',
  pranim: 'PRANIM',
  pranimi: 'PRANIM',
  pending: 'NË PRITJE',
  pickup: 'PËR MARRJE',
  marrje: 'PËR MARRJE',
  assigned: 'CAKTUAR',
  caktuar: 'CAKTUAR',
  at_base: 'NË BAZË',
  ne_baze: 'NË BAZË',
  pastrim: 'PASTRIM',
  pastrimi: 'PASTRIM',
  gati: 'GATI',
  ready: 'GATI',
  dorzim: 'DORËZIM',
  dorëzim: 'DORËZIM',
  ...TERMINAL_LABELS,
});

function clean(value) {
  return String(value ?? '').trim();
}

function euro(value) {
  return `€${Math.max(0, Number(value || 0)).toFixed(2)}`;
}

function dateTime(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('sq-XK', {
      timeZone: 'Europe/Belgrade',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return clean(value) || '—';
  }
}

function statusLabel(value) {
  const key = clean(value).toLowerCase();
  return STATUS_LABELS[key] || key.replaceAll('_', ' ').toUpperCase() || '—';
}

function statusTone(visit) {
  if (Number(visit?.debt || 0) > 0) return { bg: 'rgba(190,24,93,.20)', color: '#fda4af', border: 'rgba(244,63,94,.40)' };
  if (visit?.active) return { bg: 'rgba(37,99,235,.20)', color: '#bfdbfe', border: 'rgba(96,165,250,.38)' };
  return { bg: 'rgba(34,197,94,.14)', color: '#bbf7d0', border: 'rgba(74,222,128,.30)' };
}

function safePhoneHref(phone) {
  const value = clean(phone).replace(/[^\d+]/g, '');
  return value ? `tel:${value}` : '';
}

function visitHref(visit) {
  if (!visit?.id) return '';
  return buildHomeSearchHref({
    kind: visit.source,
    orderId: visit.id,
    id: visit.id,
    code: visit.code,
    status: visit.status,
  });
}

function Metric({ label, value, tone = '#f8fafc' }) {
  return (
    <div style={{ minWidth: 0, border: '1px solid rgba(148,163,184,.14)', background: 'rgba(15,23,42,.72)', borderRadius: 16, padding: '10px 8px', textAlign: 'center' }}>
      <div style={{ color: 'rgba(203,213,225,.72)', fontSize: 9, fontWeight: 1000, letterSpacing: '.08em' }}>{label}</div>
      <div style={{ marginTop: 5, color: tone, fontSize: 17, fontWeight: 1000, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  );
}

function VisitCard({ visit, expanded, onToggle, onOpen }) {
  const tone = statusTone(visit);
  const items = Array.isArray(visit?.items) ? visit.items : [];
  return (
    <article style={{ border: visit?.current ? '1px solid rgba(96,165,250,.55)' : '1px solid rgba(148,163,184,.16)', background: visit?.current ? 'rgba(30,64,175,.15)' : 'rgba(15,23,42,.70)', borderRadius: 18, overflow: 'hidden' }}>
      <button type="button" onClick={onToggle} style={{ width: '100%', border: 0, background: 'transparent', color: '#f8fafc', padding: 12, textAlign: 'left', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ flex: '0 0 auto', borderRadius: 10, background: visit?.source === 'TRANSPORT' ? '#7c3aed' : '#0284c7', padding: '7px 9px', fontSize: 13, fontWeight: 1000 }}>{visit?.code || '—'}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 1000 }}>{visit?.source === 'TRANSPORT' ? 'TRANSPORT' : 'BAZË'}{visit?.visitNr ? ` • VIZITA ${visit.visitNr}` : ''}</div>
            <div style={{ marginTop: 3, fontSize: 10, color: 'rgba(203,213,225,.70)' }}>{dateTime(visit?.createdAt)}</div>
          </div>
          <span style={{ flex: '0 0 auto', border: `1px solid ${tone.border}`, background: tone.bg, color: tone.color, borderRadius: 999, padding: '5px 7px', fontSize: 9, fontWeight: 1000 }}>{statusLabel(visit?.status)}</span>
        </div>
        <div style={{ marginTop: 9, display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 5, color: 'rgba(226,232,240,.88)', fontSize: 10, fontWeight: 850 }}>
          <span>{Number(visit?.pieces || 0)} copë</span>
          <span>{Number(visit?.m2 || 0).toFixed(2)} m²</span>
          <span>{euro(visit?.total)}</span>
          <span style={{ color: Number(visit?.debt || 0) > 0 ? '#fda4af' : '#86efac' }}>{Number(visit?.debt || 0) > 0 ? `BORXH ${euro(visit.debt)}` : 'PAGUAR'}</span>
        </div>
      </button>
      {expanded ? (
        <div style={{ borderTop: '1px solid rgba(148,163,184,.14)', padding: 12, display: 'grid', gap: 10 }}>
          {visit?.worker ? <div style={{ color: '#fcd34d', fontSize: 11, fontWeight: 900 }}>PUNËTORI: {visit.worker}</div> : null}
          {visit?.rack ? <div style={{ color: '#93c5fd', fontSize: 11, fontWeight: 850 }}>📍 {visit.rack}</div> : null}
          {visit?.note ? <div style={{ color: 'rgba(226,232,240,.78)', fontSize: 11, lineHeight: 1.35 }}>📝 {visit.note}</div> : null}
          {items.length ? (
            <div style={{ display: 'grid', gap: 6 }}>
              {items.map((item, index) => (
                <div key={`${visit.id}_${index}`} style={{ display: 'grid', gridTemplateColumns: item?.photoUrl ? '46px 1fr' : '1fr', gap: 8, alignItems: 'center', borderRadius: 12, background: 'rgba(2,6,23,.55)', padding: 8 }}>
                  {item?.photoUrl ? <img src={item.photoUrl} alt="" loading="lazy" style={{ width: 46, height: 46, borderRadius: 9, objectFit: 'cover', background: '#020617' }} /> : null}
                  <div style={{ minWidth: 0, fontSize: 11, fontWeight: 900 }}>{item.kind} • {Number(item.qty || 0)} copë × {Number(item.m2 || 0).toFixed(2)} m²</div>
                </div>
              ))}
            </div>
          ) : <div style={{ color: 'rgba(148,163,184,.72)', fontSize: 11 }}>Dimensionet e detajuara nuk janë ruajtur për këtë vizitë.</div>}
          <button type="button" onClick={onOpen} style={{ width: '100%', border: '1px solid rgba(96,165,250,.32)', background: 'rgba(37,99,235,.18)', color: '#dbeafe', borderRadius: 13, padding: 11, fontSize: 12, fontWeight: 1000, cursor: 'pointer' }}>HAP VIZITËN E SAKTË</button>
        </div>
      ) : null}
    </article>
  );
}

export default function ClientProfileSheet({ open = false, onClose, anchor: anchorLike = null }) {
  const router = useRouter();
  const anchor = useMemo(() => buildClientProfileAnchor(anchorLike || {}), [anchorLike]);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [tab, setTab] = useState('ACTIVE');
  const [expandedId, setExpandedId] = useState('');
  const [smsOpen, setSmsOpen] = useState(false);
  const scrollRef = useRef({ y: 0, previous: null });
  const smartSms = useMemo(
    () => buildClientProfileSmartSms(profile, anchor),
    [profile, anchor.source, anchor.orderId],
  );

  useEffect(() => {
    if (!open) return undefined;
    const cached = readCachedClientProfile(anchorLike || {});
    if (cached) {
      setProfile(cached);
      setFromCache(true);
    } else {
      setProfile(null);
      setFromCache(false);
    }
    setLoading(true);
    setError('');
    setTab('ACTIVE');
    setSmsOpen(false);
    setExpandedId(anchor.orderId || '');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    fetchClientProfile(anchorLike || {}, { signal: controller?.signal })
      .then((result) => {
        setProfile(result.profile);
        setFromCache(result.fromCache === true);
      })
      .catch((requestError) => setError(String(requestError?.code || requestError?.message || 'CLIENT_PROFILE_FAILED')))
      .finally(() => setLoading(false));
    return () => controller?.abort();
  }, [open, anchor.clientId, anchor.orderId, anchor.phone, anchor.source]);

  useEffect(() => {
    if (!open || typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const body = document.body;
    const html = document.documentElement;
    const y = window.scrollY || 0;
    const previous = { bodyPosition: body.style.position, bodyTop: body.style.top, bodyWidth: body.style.width, bodyOverflow: body.style.overflow, htmlOverflow: html.style.overflow };
    scrollRef.current = { y, previous };
    body.style.position = 'fixed';
    body.style.top = `-${y}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';
    const onKey = (event) => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => {
      body.style.position = previous.bodyPosition || '';
      body.style.top = previous.bodyTop || '';
      body.style.width = previous.bodyWidth || '';
      body.style.overflow = previous.bodyOverflow || '';
      html.style.overflow = previous.htmlOverflow || '';
      window.removeEventListener('keydown', onKey);
      try { window.scrollTo(0, y); } catch {}
    };
  }, [open, onClose]);

  if (!open) return null;

  const client = profile?.client || { name: anchor.name || 'Pa emër', phone: anchor.phone || null };
  const summary = profile?.summary || { visits: 0, active: 0, m2: 0, totalDebt: 0 };
  const visits = Array.isArray(profile?.visits) ? profile.visits : [];
  const visibleVisits = tab === 'ACTIVE' ? visits.filter((visit) => visit?.active) : visits;
  const payments = Array.isArray(profile?.payments) ? profile.payments : [];
  const tel = safePhoneHref(client.phone);
  const canMessage = Boolean(client.phone && smartSms.ready && !loading && !fromCache);
  const mapHref = client.gpsLat && client.gpsLng
    ? `https://www.google.com/maps?q=${encodeURIComponent(`${client.gpsLat},${client.gpsLng}`)}`
    : (client.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(client.address)}` : '');
  const isTransportProfile = anchor.source === 'TRANSPORT';
  const newVisitHref = !isTransportProfile && profile?.identity?.baseClientId
    ? `/pranimi?existingClient=1&clientId=${encodeURIComponent(profile.identity.baseClientId)}${client.baseCode ? `&code=${encodeURIComponent(client.baseCode)}` : ''}&name=${encodeURIComponent(client.name || '')}&phone=${encodeURIComponent(client.phone || '')}&from=client_profile`
    : '';

  return (
    <>
      <div role="dialog" aria-modal="true" aria-label="Kartela e klientit" style={{ position: 'fixed', inset: 0, zIndex: 9600, background: 'rgba(2,6,23,.82)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: '8px 8px max(8px,env(safe-area-inset-bottom))' }}>
        <section style={{ width: 'min(100%,680px)', height: 'min(94dvh,94vh)', maxHeight: 'min(94dvh,94vh)', overflow: 'hidden', borderRadius: '26px 26px 18px 18px', border: '1px solid rgba(96,165,250,.25)', background: 'linear-gradient(180deg,#0f172a,#020617)', boxShadow: '0 -24px 80px rgba(0,0,0,.62)', color: '#f8fafc', display: 'flex', flexDirection: 'column' }}>
          <div style={{ width: 48, height: 5, borderRadius: 999, background: 'rgba(148,163,184,.45)', margin: '9px auto 2px', flex: '0 0 auto' }} />
          <header style={{ padding: '8px 12px 12px', borderBottom: '1px solid rgba(148,163,184,.14)', display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'start', flex: '0 0 auto' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#7dd3fc', fontSize: 10, fontWeight: 1000, letterSpacing: '.12em' }}>KARTELA E KLIENTIT</div>
              <h2 style={{ margin: '5px 0 0', fontSize: 22, lineHeight: 1.05, fontWeight: 1000, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{client.name || 'Pa emër'}</h2>
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', color: 'rgba(226,232,240,.72)', fontSize: 11, fontWeight: 850 }}>
                {client.baseCode ? <span>BAZË {client.baseCode}</span> : null}
                {client.transportCode ? <span>• {client.transportCode}</span> : null}
                {client.phone ? <span>• {client.phone}</span> : <span>• PA TELEFON</span>}
              </div>
            </div>
            <button type="button" onClick={onClose} aria-label="Mbyll kartelën" style={{ width: 44, height: 44, borderRadius: 14, border: '1px solid rgba(148,163,184,.25)', background: 'rgba(15,23,42,.88)', color: '#fff', fontSize: 19, fontWeight: 1000, cursor: 'pointer' }}>✕</button>
          </header>

          <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', padding: '12px 12px max(20px,env(safe-area-inset-bottom))' }}>
            <div style={{ display: 'grid', gridTemplateColumns: mapHref ? 'repeat(3,minmax(0,1fr))' : 'repeat(2,minmax(0,1fr))', gap: 8 }}>
              <button type="button" disabled={!tel} onClick={() => { if (tel) window.location.href = tel; }} style={{ minHeight: 48, borderRadius: 15, border: '1px solid rgba(34,197,94,.30)', background: 'rgba(22,163,74,.18)', color: tel ? '#dcfce7' : '#64748b', fontSize: 13, fontWeight: 1000, cursor: tel ? 'pointer' : 'not-allowed' }}>📞 THIRR</button>
              <button type="button" disabled={!canMessage} onClick={() => { if (canMessage) setSmsOpen(true); }} title={canMessage ? 'Hap Smart Message për vizitën aktuale' : 'Smart Message aktivizohet pasi të verifikohet statusi live i vizitës'} style={{ minHeight: 48, borderRadius: 15, border: '1px solid rgba(59,130,246,.35)', background: 'rgba(37,99,235,.20)', color: canMessage ? '#dbeafe' : '#64748b', fontSize: 13, fontWeight: 1000, cursor: canMessage ? 'pointer' : 'not-allowed' }}>💬 MESAZH</button>
              {mapHref ? <button type="button" onClick={() => { window.location.href = mapHref; }} style={{ minHeight: 48, borderRadius: 15, border: '1px solid rgba(245,158,11,.30)', background: 'rgba(217,119,6,.16)', color: '#fef3c7', fontSize: 13, fontWeight: 1000, cursor: 'pointer' }}>📍 HARTA</button> : null}
            </div>

            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6 }}>
              <Metric label="BORXHI" value={euro(summary.totalDebt)} tone={Number(summary.totalDebt || 0) > 0 ? '#fda4af' : '#86efac'} />
              <Metric label="AKTIVE" value={summary.active || 0} tone="#93c5fd" />
              <Metric label="VIZITA" value={summary.visits || 0} />
              <Metric label="TOTAL M²" value={Number(summary.m2 || 0).toFixed(1)} tone="#fde68a" />
            </div>

            {newVisitHref ? <button type="button" onClick={() => { onClose?.(); router.push(newVisitHref); }} style={{ marginTop: 10, width: '100%', minHeight: 46, borderRadius: 15, border: '1px solid rgba(34,197,94,.32)', background: 'linear-gradient(135deg,rgba(22,163,74,.26),rgba(5,150,105,.18))', color: '#dcfce7', fontSize: 13, fontWeight: 1000, cursor: 'pointer' }}>＋ VIZITË E RE PËR KËTË KLIENT</button> : null}

            {fromCache ? <div style={{ marginTop: 9, borderRadius: 12, background: 'rgba(245,158,11,.12)', border: '1px solid rgba(245,158,11,.25)', color: '#fde68a', padding: 9, fontSize: 10, fontWeight: 900 }}>PO SHFAQET SNAPSHOT-I I FUNDIT I RUAJTUR</div> : null}
            {profile?.identity?.warnings?.includes('SOURCE_CLIENT_UNLINKED') ? <div style={{ marginTop: 9, borderRadius: 12, background: 'rgba(239,68,68,.11)', border: '1px solid rgba(248,113,113,.23)', color: '#fecaca', padding: 9, fontSize: 10, fontWeight: 900 }}>KJO VIZITË S’KA LIDHJE TË PLOTË ME CLIENT_ID. HISTORIA E SIGURT SHFAQET NGA TELEFONI UNIK.</div> : null}

            <nav style={{ position: 'sticky', top: -12, zIndex: 3, margin: '12px -2px 10px', padding: '7px 2px', background: 'linear-gradient(180deg,#020617 78%,rgba(2,6,23,0))', display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 5 }}>
              {TABS.map((item) => (
                <button key={item.key} type="button" onClick={() => setTab(item.key)} style={{ minWidth: 0, borderRadius: 11, border: tab === item.key ? '1px solid rgba(96,165,250,.55)' : '1px solid rgba(148,163,184,.14)', background: tab === item.key ? 'rgba(37,99,235,.28)' : 'rgba(15,23,42,.75)', color: tab === item.key ? '#dbeafe' : 'rgba(203,213,225,.72)', padding: '9px 3px', fontSize: 9, fontWeight: 1000, cursor: 'pointer' }}>{item.label}</button>
              ))}
            </nav>

            {loading && !profile ? <div style={{ padding: 24, textAlign: 'center', color: '#bfdbfe', fontWeight: 1000 }}>DUKE E HAPUR KARTELËN...</div> : null}
            {error && !profile ? <div style={{ borderRadius: 16, border: '1px solid rgba(248,113,113,.28)', background: 'rgba(127,29,29,.22)', color: '#fecaca', padding: 14, fontSize: 12, fontWeight: 900 }}>Kartela nuk u hap: {error}</div> : null}

            {(tab === 'ACTIVE' || tab === 'HISTORY') && profile ? (
              <div style={{ display: 'grid', gap: 9 }}>
                {visibleVisits.length ? visibleVisits.map((visit) => (
                  <VisitCard
                    key={`${visit.source}_${visit.id}`}
                    visit={visit}
                    expanded={expandedId === `${visit.source}_${visit.id}` || expandedId === visit.id}
                    onToggle={() => setExpandedId((current) => (current === `${visit.source}_${visit.id}` ? '' : `${visit.source}_${visit.id}`))}
                    onOpen={() => {
                      const href = visitHref(visit);
                      if (!href) return;
                      onClose?.();
                      router.push(href);
                    }}
                  />
                )) : <div style={{ padding: 18, textAlign: 'center', color: 'rgba(148,163,184,.78)', fontSize: 12, fontWeight: 850 }}>{tab === 'ACTIVE' ? 'Nuk ka vizita aktive.' : 'Nuk u gjet histori.'}</div>}
              </div>
            ) : null}

            {tab === 'PAYMENTS' && profile ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ borderRadius: 16, border: '1px solid rgba(244,63,94,.22)', background: 'rgba(136,19,55,.16)', padding: 12, display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 1000 }}><span>BORXHI I POROSIVE</span><span>{euro(summary.orderDebt)}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 1000 }}><span>BORXHI I BARTUR</span><span>{euro(summary.carryDebt)}</span></div>
                  <div style={{ borderTop: '1px solid rgba(244,63,94,.20)', paddingTop: 7, display: 'flex', justifyContent: 'space-between', color: '#fda4af', fontSize: 14, fontWeight: 1000 }}><span>TOTALI I HAPUR</span><span>{euro(summary.totalDebt)}</span></div>
                </div>
                {payments.length ? payments.map((payment) => (
                  <div key={payment.id} style={{ borderRadius: 14, border: '1px solid rgba(148,163,184,.15)', background: 'rgba(15,23,42,.72)', padding: 11, display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                    <div style={{ minWidth: 0 }}><div style={{ fontSize: 12, fontWeight: 1000 }}>{payment.code} • {payment.type || 'PAGESË'}</div><div style={{ marginTop: 4, color: 'rgba(203,213,225,.65)', fontSize: 10 }}>{dateTime(payment.createdAt)} • {payment.status || '—'}</div>{payment.note ? <div style={{ marginTop: 4, color: 'rgba(226,232,240,.76)', fontSize: 10 }}>{payment.note}</div> : null}</div>
                    <strong style={{ color: '#86efac', fontSize: 14 }}>{euro(payment.amount)}</strong>
                  </div>
                )) : <div style={{ padding: 18, textAlign: 'center', color: 'rgba(148,163,184,.78)', fontSize: 12, fontWeight: 850 }}>Nuk u gjetën pagesa të veçanta në Arkë.</div>}
              </div>
            ) : null}

            {tab === 'INFO' && profile ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {[
                  ['EMRI', client.name || '—'],
                  ['TELEFONI', client.phone || '—'],
                  ['KODI BAZË', client.baseCode || '—'],
                  ['KODI TRANSPORT', client.transportCode || '—'],
                  ['ADRESA', client.address || '—'],
                  ['LIDHJA', profile.identity?.resolution || '—'],
                ].map(([label, value]) => <div key={label} style={{ borderRadius: 14, border: '1px solid rgba(148,163,184,.14)', background: 'rgba(15,23,42,.70)', padding: 11 }}><div style={{ color: 'rgba(148,163,184,.72)', fontSize: 9, fontWeight: 1000 }}>{label}</div><div style={{ marginTop: 4, fontSize: 13, fontWeight: 900, overflowWrap: 'anywhere' }}>{value}</div></div>)}
              </div>
            ) : null}
          </div>
        </section>
      </div>
      <SmartSmsModal isOpen={smsOpen && canMessage} onClose={() => setSmsOpen(false)} phone={client.phone || ''} messageText={smartSms.messageText} />
    </>
  );
}
