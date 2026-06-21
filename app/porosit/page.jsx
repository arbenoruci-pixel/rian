'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from '@/lib/routerCompat.jsx';
import { supabase } from '@/lib/supabaseClient';
import { bootLog, bootMarkReady } from '@/lib/bootLog';

const PAGE_BG = 'linear-gradient(180deg, #090e17 0%, #06090f 100%)';
const DAY_CAPACITY = 30;
const SLOT_CAPACITY = 15;
const SLOT_OPTIONS = [
  { value: 'morning', label: 'PARADITE', time: '09:00 – 13:00', startHour: 9, endHour: 13 },
  { value: 'evening', label: 'MBRËMJE', time: '18:00 – 21:00', startHour: 18, endHour: 21 },
];
const CLOSED_STATUSES = new Set(['done', 'cancelled', 'canceled', 'rejected']);

function getTodayYmd(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDefaultSlot(now = new Date()) {
  const hour = now.getHours();
  if (hour < 13) return 'morning';
  if (hour < 21) return 'evening';
  return '';
}

function getSlotState(selectedDate, slotValue, capacity, nowYmd = '', nowHour = null) {
  const slot = SLOT_OPTIONS.find((x) => x.value === slotValue);
  const count = Number(capacity?.slotCounts?.[slotValue] || 0);
  const total = Number(capacity?.total || 0);
  const dayFull = total >= DAY_CAPACITY;
  const slotFull = count >= SLOT_CAPACITY;
  const pastToday = !!nowYmd && nowHour != null && selectedDate === nowYmd && slot && nowHour >= slot.endHour;
  const disabled = !selectedDate || dayFull || slotFull || pastToday;
  return { disabled, count, dayFull, slotFull, pastToday };
}

async function loadCapacityForDate(dateYmd) {
  if (!dateYmd) {
    return { total: 0, slotCounts: { morning: 0, evening: 0 } };
  }

  const { data, error } = await supabase
    .from('transport_orders')
    .select('id,status,data')
    .filter('data->>pickup_date', 'eq', dateYmd);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const slotCounts = { morning: 0, evening: 0 };
  let total = 0;

  for (const row of rows) {
    const status = String(row?.status || '').toLowerCase();
    if (CLOSED_STATUSES.has(status)) continue;
    const slot = String(row?.data?.pickup_slot || '').toLowerCase();
    total += 1;
    if (slot === 'morning' || slot === 'evening') slotCounts[slot] += 1;
  }

  return { total, slotCounts };
}

const EMPTY_FORM = {
  name: '',
  phone: '',
  address: '',
  pieces: '',
  note: '',
  pickupDate: '',
  pickupSlot: '',
  lat: null,
  lng: null,
};

export default function PremiumBookingPage() {
  const searchParams = useSearchParams();
  const [hydrated, setHydrated] = useState(false);
  const [clientClock, setClientClock] = useState({ todayYmd: '', currentHour: null });
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [gpsError, setGpsError] = useState('');
  const [locating, setLocating] = useState(false);
  const [capacity, setCapacity] = useState({ total: 0, slotCounts: { morning: 0, evening: 0 } });
  const [capacityLoading, setCapacityLoading] = useState(false);
  const [capacityError, setCapacityError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const uiReadyMarkedRef = useRef(false);
  const submitAbortRef = useRef(null);

  const successInfo = useMemo(() => {
    const ok = searchParams?.get('ok') === '1';
    if (!ok) return null;
    const pickupSlot = searchParams.get('pickupSlot') || '';
    const pickupWindow = searchParams.get('pickupWindow') || SLOT_OPTIONS.find((x) => x.value === pickupSlot)?.time || '';
    return {
      name: searchParams.get('name') || '',
      phone: searchParams.get('phone') || '',
      pickupDate: searchParams.get('pickupDate') || '',
      pickupSlot,
      pickupWindow,
    };
  }, [searchParams]);

  const queryError = useMemo(() => {
    const raw = searchParams?.get('err') || '';
    return raw ? decodeURIComponent(raw) : '';
  }, [searchParams]);

  useEffect(() => {
    setHydrated(true);
    const now = new Date();
    const todayYmd = getTodayYmd(now);
    const defaultSlot = getDefaultSlot(now);
    const currentHour = now.getHours() + (now.getMinutes() / 60);
    setClientClock({ todayYmd, currentHour });
    setFormData((prev) => ({
      ...prev,
      pickupDate: prev.pickupDate || todayYmd,
      pickupSlot: prev.pickupSlot || defaultSlot,
    }));
  }, []);

  useEffect(() => {
    return () => {
      try { submitAbortRef.current?.abort(); } catch {}
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const url = new URL(window.location.href);
      let changed = false;
      [
        'fbclid',
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_id',
        'utm_term',
        'utm_content',
      ].forEach((key) => {
        if (!url.searchParams.has(key)) return;
        url.searchParams.delete(key);
        changed = true;
      });
      if (changed) {
        const next = url.pathname + (url.search || '') + (url.hash || '');
        window.history.replaceState(window.history.state, '', next);
      }
    } catch {}
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;

    const markReady = (source = 'porosit_hydrated_ready') => {
      if (uiReadyMarkedRef.current) return;
      uiReadyMarkedRef.current = true;
      const path = typeof window !== 'undefined' ? (window.location.pathname || '/porosit') : '/porosit';
      try { bootLog('ui_ready', { page: 'porosit', path, source }); } catch {}
      try { bootMarkReady({ page: 'porosit', path, source }); } catch {}
      try {
        window.__TEPIHA_UI_READY = true;
        document?.documentElement?.setAttribute?.('data-ui-ready', '1');
        document?.body?.setAttribute?.('data-ui-ready', '1');
      } catch {}
    };

    markReady('porosit_hydrated_ready');
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || !formData.pickupDate || successInfo) return;
    let alive = true;
    setCapacityLoading(true);
    setCapacityError('');
    loadCapacityForDate(formData.pickupDate)
      .then((next) => {
        if (!alive) return;
        setCapacity(next);
      })
      .catch((err) => {
        console.error(err);
        if (!alive) return;
        setCapacity({ total: 0, slotCounts: { morning: 0, evening: 0 } });
        setCapacityError('Nuk po arrijmë ta kontrollojmë ngarkesën e datës. Provoni përsëri.');
      })
      .finally(() => {
        if (alive) setCapacityLoading(false);
      });
    return () => { alive = false; };
  }, [hydrated, formData.pickupDate, successInfo]);

  useEffect(() => {
    if (!hydrated || !formData.pickupDate || successInfo) return;
    const slotState = getSlotState(formData.pickupDate, formData.pickupSlot, capacity, clientClock.todayYmd, clientClock.currentHour);
    if (formData.pickupSlot && slotState.disabled) {
      setFormData((prev) => ({ ...prev, pickupSlot: '' }));
    }
  }, [hydrated, formData.pickupDate, formData.pickupSlot, capacity, clientClock, successInfo]);

  const slotCards = useMemo(() => {
    if (!hydrated) {
      return SLOT_OPTIONS.map((slot) => ({ ...slot, disabled: true, count: 0, dayFull: false, slotFull: false, pastToday: false, selected: false }));
    }
    return SLOT_OPTIONS.map((slot) => {
      const state = getSlotState(formData.pickupDate, slot.value, capacity, clientClock.todayYmd, clientClock.currentHour);
      return { ...slot, ...state, selected: formData.pickupSlot === slot.value };
    });
  }, [hydrated, formData.pickupDate, formData.pickupSlot, capacity, clientClock]);

  const dayIsFull = Number(capacity?.total || 0) >= DAY_CAPACITY;
  const selectedSlotLabel = slotCards.find((x) => x.selected)?.time || '';
  const displayError = submitError || queryError || capacityError;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleGetLocation = () => {
    const blockedGpsMessage = "🔒 GPS është bllokuar! Për ta lejuar, klikoni ikonën e drynit (ose 'aA') lart në shiritin e adresës dhe ndryshoni Lokacionin në 'Lejo' (Allow).";
    if (!navigator.geolocation) {
      setGpsError(blockedGpsMessage);
      return;
    }
    setGpsError('');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setFormData((prev) => ({ ...prev, lat: pos.coords.latitude, lng: pos.coords.longitude }));
        setGpsError('');
        setLocating(false);
      },
      () => {
        setGpsError(blockedGpsMessage);
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!formData.pickupSlot || dayIsFull) return;

    setSubmitError('');
    setSubmitting(true);

    const formEl = e.currentTarget;
    const body = new FormData(formEl);
    const controller = new AbortController();
    submitAbortRef.current = controller;

    const timeoutId = window.setTimeout(() => {
      try { controller.abort(); } catch {}
    }, 15000);

    try {
      const res = await fetch('/api/public-booking', {
        method: 'POST',
        body,
        signal: controller.signal,
        redirect: 'follow',
        cache: 'no-store',
        headers: {
          'x-requested-with': 'public-booking-fetch',
        },
      });

      const nextUrl = res?.url || ('/porosit?err=' + encodeURIComponent('Ndodhi një problem gjatë dërgimit. Ju lutem provoni përsëri.'));
      window.location.href = nextUrl;
    } catch (err) {
      console.error('public booking submit failed', err);
      setSubmitting(false);
      setSubmitError('Dërgimi po vonon ose dështoi. Ju lutem provoni përsëri.');
    } finally {
      window.clearTimeout(timeoutId);
      if (submitAbortRef.current === controller) {
        submitAbortRef.current = null;
      }
    }
  };

  if (successInfo) {
    return (
      <div style={styles.page}>
        <div style={styles.shell}>
          <div style={styles.successCard}>
            <div style={styles.successPulse}><div style={styles.successEmoji}>🎉</div></div>
            <h2 style={styles.successTitle}>Porosia u pranua!</h2>
            <div style={styles.successDivider} />
            <p style={styles.successText}>
              Faleminderit <strong style={{ color: '#fff' }}>{successInfo.name}</strong>!<br /><br />
              Kemi marrë kërkesën tuaj për datën <strong style={{ color: '#fff' }}>{successInfo.pickupDate}</strong>
              {successInfo.pickupWindow ? <> në orarin <strong style={{ color: '#0A84FF' }}>{successInfo.pickupWindow}</strong></> : null}.
              <br /><br />
              Një nga shoferët tanë do t'ju kontaktojë në numrin <strong style={{ color: '#0A84FF' }}>{successInfo.phone}</strong>.
            </p>
            <button onClick={() => { window.location.href = '/porosit'; }} style={styles.btnSecondary}>Kthehu te Fillimi</button>
          </div>
        </div>
      </div>
    );
  }

  if (!hydrated) {
    return (
      <div style={styles.page}><div style={styles.shell}><div style={styles.formContainer}><div style={styles.sectionCard}><div style={styles.sectionTitle}>📅 Po hapet formulari...</div></div></div></div></div>
    );
  }

  return (
    <div style={styles.page}>
      <style>{`
        @keyframes pulseLocation {
          0% { box-shadow: 0 0 0 0 rgba(52,199,89,0.4); }
          70% { box-shadow: 0 0 0 10px rgba(52,199,89,0); }
          100% { box-shadow: 0 0 0 0 rgba(52,199,89,0); }
        }
        .form-input {
          width: 100%;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 14px;
          padding: 14px 16px;
          color: #ffffff;
          font-size: 16px;
          outline: none;
          transition: all 0.25s ease;
        }
        .form-input:focus {
          border-color: rgba(10,132,255,0.6);
          background: rgba(0,0,0,0.5);
          box-shadow: 0 0 0 4px rgba(10,132,255,0.15);
        }
      `}</style>

      <div style={styles.shell}>
        <div style={styles.headerWrap}>
          <h1 style={styles.mainTitle}>KOMPANIA JONI</h1>
          <div style={styles.subTitleBadge}>për larjen e tepihave</div>
          <p style={styles.subtitle}>Plotësoni të dhënat dhe ne vijmë t'i marrim tepihat në shtëpinë tuaj, pa asnjë mundim.</p>
        </div>

        {displayError ? <div style={styles.errorBox}>⚠️ {displayError}</div> : null}

        <form onSubmit={handleSubmit} style={styles.formContainer}>
          <input type="hidden" name="pickupSlot" value={formData.pickupSlot || ''} />
          <input type="hidden" name="pickupWindow" value={selectedSlotLabel || ''} />
          <input type="hidden" name="lat" value={formData.lat ?? ''} />
          <input type="hidden" name="lng" value={formData.lng ?? ''} />

          <div style={styles.sectionCard}>
            <div style={styles.sectionTitle}>📅 Data & Orari i Marrjes</div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>📆 Zgjidh Datën *</label>
              <input type="date" name="pickupDate" value={formData.pickupDate} min={clientClock.todayYmd || undefined} onChange={handleChange} className="form-input" required />
            </div>

            <div style={styles.capacityRow}>
              <div style={styles.capacityCard}>
                <div style={styles.capacityKicker}>PËR KËTË DATË</div>
                <div style={styles.capacityValue}>{capacityLoading ? '...' : `${capacity.total}/${DAY_CAPACITY}`}</div>
                <div style={styles.capacitySub}>{dayIsFull ? 'DATA E MBUSHUR' : 'POROSI TË PLANIFIKUARA'}</div>
              </div>
            </div>

            <div style={styles.slotGrid}>
              {slotCards.map((slot) => {
                const helper = slot.dayFull
                  ? 'DATA E MBUSHUR'
                  : slot.slotFull
                    ? 'ORARI U MBUSH'
                    : slot.pastToday
                      ? 'KY ORAR PËRFUNDOI'
                      : `${slot.count}/${SLOT_CAPACITY} POROSI`;
                return (
                  <button
                    key={slot.value}
                    type="button"
                    disabled={slot.disabled}
                    onClick={() => setFormData((prev) => ({ ...prev, pickupSlot: slot.value }))}
                    style={{
                      ...styles.slotBtn,
                      ...(slot.selected ? styles.slotBtnActive : null),
                      ...(slot.disabled ? styles.slotBtnDisabled : null),
                    }}
                  >
                    <div style={styles.slotTitle}>{slot.label}</div>
                    <div style={styles.slotTime}>{slot.time}</div>
                    <div style={styles.slotMeta}>{helper}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={styles.sectionCard}>
            <div style={styles.sectionTitle}>👤 Të Dhënat e Klientit</div>
            <div style={styles.inputGroup}>
              <label style={styles.label}>Emri dhe Mbiemri *</label>
              <input type="text" name="name" value={formData.name} onChange={handleChange} className="form-input" required />
            </div>
            <div style={styles.inputGroup}>
              <label style={styles.label}>📱 Numri i Telefonit *</label>
              <input type="tel" name="phone" value={formData.phone} onChange={handleChange} className="form-input" required />
            </div>
          </div>

          <div style={styles.sectionCard}>
            <div style={styles.sectionTitle}>📍 Lokacioni & Adresa</div>
            <div style={styles.gpsBox}>
              <p style={styles.gpsText}>Për shërbim më të shpejtë, na dërgoni lokacionin tuaj të saktë me GPS:</p>
              {formData.lat && formData.lng ? (
                <div style={styles.gpsSuccess}>✅ Lokacioni u ruajt me sukses!</div>
              ) : (
                <button type="button" onClick={handleGetLocation} disabled={locating} style={styles.gpsBtn}>
                  {locating ? '⏳ Po kërkojmë...' : '🧭 MERR LOKACIONIN TIM (GPS)'}
                </button>
              )}
              {!!gpsError && <div style={styles.gpsErrorBox}>{gpsError}</div>}
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>🗺️ Adresa me Fjalë *</label>
              <input type="text" name="address" value={formData.address} onChange={handleChange} className="form-input" required />
            </div>
          </div>

          <div style={styles.sectionCard}>
            <div style={styles.sectionTitle}>📦 Detajet e Porosisë</div>
            <div style={styles.inputGroup}>
              <label style={styles.label}>🔢 Sa copë tepiha keni? (Opsionale)</label>
              <input type="number" name="pieces" value={formData.pieces} onChange={handleChange} className="form-input" />
            </div>
            <div style={styles.inputGroup}>
              <label style={styles.label}>📝 Shënim për shoferin (Opsionale)</label>
              <textarea name="note" value={formData.note} onChange={handleChange} className="form-input" style={{ minHeight: '90px', resize: 'vertical' }} />
            </div>
          </div>

          <div style={styles.footerNote}>🛡️ Pagesa bëhet vetëm pasi të kthehen tepihat e pastruar.</div>

          <button type="submit" disabled={!formData.pickupSlot || dayIsFull || submitting} style={{ ...styles.submitBtn, opacity: (!formData.pickupSlot || dayIsFull || submitting) ? 0.7 : 1 }}>
            {submitting ? '⏳ PO DËRGOHET...' : '🚀 DËRGO POROSINË'}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100dvh',
    background: PAGE_BG,
    color: '#F5F7FB',
    padding: '30px 14px 50px',
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  shell: { maxWidth: 520, margin: '0 auto' },
  headerWrap: { padding: '10px 4px 28px', textAlign: 'center' },
  mainTitle: { margin: 0, fontSize: 34, lineHeight: 1.1, fontWeight: 900, letterSpacing: '0.02em', color: '#ffffff', textTransform: 'uppercase' },
  subTitleBadge: { display: 'inline-block', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)', padding: '4px 16px', borderRadius: 999, fontSize: 14, fontWeight: 600, letterSpacing: 1.5, marginTop: 8, border: '1px solid rgba(255,255,255,0.1)', textTransform: 'lowercase' },
  subtitle: { margin: '18px auto 0', fontSize: 15, lineHeight: 1.5, color: 'rgba(255,255,255,0.65)', maxWidth: '90%' },
  errorBox: { background: 'rgba(255,69,58,0.15)', border: '1px solid rgba(255,69,58,0.3)', color: '#ff453a', padding: 14, borderRadius: 16, fontSize: 14, fontWeight: 800, textAlign: 'center', marginBottom: 12 },
  formContainer: { display: 'flex', flexDirection: 'column', gap: 20 },
  sectionCard: { background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 24, padding: '22px 18px', boxShadow: '0 12px 30px rgba(0,0,0,0.3)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' },
  sectionTitle: { fontSize: 16, fontWeight: 900, color: '#fff', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 12, marginBottom: 16, letterSpacing: 0.3 },
  inputGroup: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 },
  label: { fontSize: 13, fontWeight: 800, color: 'rgba(255,255,255,0.7)' },
  capacityRow: { display: 'flex', marginBottom: 16 },
  capacityCard: { flex: 1, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '14px 16px', textAlign: 'center' },
  capacityKicker: { fontSize: 11, fontWeight: 900, letterSpacing: 1, color: 'rgba(255,255,255,0.55)' },
  capacityValue: { marginTop: 6, fontSize: 28, fontWeight: 900, color: '#fff' },
  capacitySub: { marginTop: 4, fontSize: 12, fontWeight: 800, color: 'rgba(255,255,255,0.65)' },
  slotGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  slotBtn: { textAlign: 'left', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 18, padding: '16px 14px', color: '#fff', cursor: 'pointer' },
  slotBtnActive: { background: 'rgba(10,132,255,0.18)', border: '1px solid rgba(10,132,255,0.55)', boxShadow: '0 12px 24px rgba(10,132,255,0.16)' },
  slotBtnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  slotTitle: { fontSize: 15, fontWeight: 900, letterSpacing: 0.4 },
  slotTime: { marginTop: 6, fontSize: 13, fontWeight: 800, color: '#7cc0ff' },
  slotMeta: { marginTop: 10, fontSize: 11, fontWeight: 800, color: 'rgba(255,255,255,0.6)' },
  gpsBox: { background: 'rgba(10,132,255,0.06)', border: '1px dashed rgba(10,132,255,0.3)', borderRadius: 16, padding: 18, marginBottom: 18, textAlign: 'center' },
  gpsText: { fontSize: 13, color: 'rgba(255,255,255,0.8)', marginBottom: 12, lineHeight: 1.4 },
  gpsBtn: { width: '100%', background: 'rgba(10,132,255,0.15)', border: '1px solid rgba(10,132,255,0.4)', borderRadius: 16, padding: '14px 16px', color: '#fff', fontSize: 14, fontWeight: 900, cursor: 'pointer', animation: 'pulseLocation 2s infinite' },
  gpsSuccess: { background: 'rgba(52,199,89,0.14)', border: '1px solid rgba(52,199,89,0.35)', color: '#34c759', padding: '14px 12px', borderRadius: 14, fontWeight: 900 },
  gpsErrorBox: { marginTop: 12, background: 'rgba(255,69,58,0.12)', border: '1px solid rgba(255,69,58,0.28)', color: '#ff453a', borderRadius: 12, padding: 12, fontSize: 12, fontWeight: 800, lineHeight: 1.45 },
  footerNote: { textAlign: 'center', fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: -6 },
  submitBtn: { width: '100%', background: 'linear-gradient(180deg, #0A84FF, #0066d6)', border: 'none', borderRadius: 20, padding: '18px 20px', color: '#fff', fontSize: 17, fontWeight: 900, letterSpacing: 0.3, cursor: 'pointer', boxShadow: '0 18px 28px rgba(10,132,255,0.28), inset 0 1px 0 rgba(255,255,255,0.14)', marginBottom: 28 },
  successCard: { background: 'linear-gradient(180deg, rgba(52,199,89,0.15), rgba(52,199,89,0.04))', border: '1px solid rgba(52,199,89,0.28)', borderRadius: 28, padding: '34px 24px', textAlign: 'center', boxShadow: '0 18px 32px rgba(0,0,0,0.35)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', marginTop: 24 },
  successPulse: { width: 120, height: 120, borderRadius: '50%', margin: '0 auto 24px', background: 'radial-gradient(circle, rgba(52,199,89,0.26), rgba(52,199,89,0.08))', display: 'grid', placeItems: 'center', boxShadow: '0 0 0 18px rgba(52,199,89,0.06), 0 0 0 36px rgba(52,199,89,0.03)' },
  successEmoji: { fontSize: 52 },
  successTitle: { margin: 0, fontSize: 32, fontWeight: 900, color: '#fff' },
  successDivider: { width: 72, height: 6, borderRadius: 999, margin: '18px auto 22px', background: 'linear-gradient(90deg, #34c759, #32d74b)' },
  successText: { margin: 0, fontSize: 16, lineHeight: 1.75, color: 'rgba(255,255,255,0.86)' },
  btnSecondary: { marginTop: 28, width: '100%', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 18, padding: '16px 18px', color: '#fff', fontSize: 16, fontWeight: 900, cursor: 'pointer' },
};
