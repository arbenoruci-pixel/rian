'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { fetchWorkerBonusAccount } from '@/lib/workerBonusAccountClient.js';
import { WORKER_BONUS_TIME_ZONE } from '@/lib/workerBonusAccount.js';
import { buildWorkerDailyBonusView, validWorkerBonusDay, workerBonusDayKey } from '@/lib/workerDailyBonusView.js';
import './WorkerDailyBonusLedger.css';

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = value => `${MONEY.format(value)} €`;
const PAGE_SIZE = 8;
const STATUSES = {
  EARNED: 'Në dispozicion',
  RESERVED: 'Në dorëzim',
  PARTIAL_RESERVED: 'Pjesërisht në dorëzim',
  RETAINED: 'E mbajtur',
  PARTIAL_RETAINED: 'Pjesërisht e mbajtur',
};

function actorKey(actor) {
  if (actor?.is_active === false) return '';
  const id = String(actor?.id || actor?.user_id || actor?.pin || '').trim();
  return id ? `${id}:${String(actor?.pin || '').trim()}:${String(actor?.role || '').trim().toUpperCase()}` : '';
}

function postedTime(value) {
  return new Intl.DateTimeFormat('sq-AL', { timeZone: WORKER_BONUS_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export default function WorkerDailyBonusLedger({ actor, targetPin }) {
  const actorIdentity = actorKey(actor);
  const sessionIdentity = actorKey(getActor());
  const pin = String(targetPin || actor?.pin || '').trim();
  const [, updateSession] = useState(0);
  const [selectedDate, setSelectedDate] = useState('');
  const [rowLimit, setRowLimit] = useState(PAGE_SIZE);
  const [state, setState] = useState({ key: '', report: null, error: '', loading: false });
  const refreshRef = useRef(null);
  const eligibleRef = useRef(null);
  const today = workerBonusDayKey();
  const date = selectedDate || today;
  const month = date.slice(0, 7);
  const identityKey = `${actorIdentity}:${pin}`;
  const requestKey = `${identityKey}:${month}`;
  const current = state.key === requestKey ? state : { report: null, error: '', loading: true };
  const knownEnabled = eligibleRef.current === identityKey;

  useEffect(() => {
    if (!actorIdentity || actorIdentity !== sessionIdentity || !pin) return undefined;
    let active = true;
    let sequence = 0;
    async function load(force = false) {
      const request = ++sequence;
      if (actorKey(getActor()) !== actorIdentity) {
        eligibleRef.current = null;
        setState({ key: requestKey, report: null, error: '', loading: false });
        updateSession(value => value + 1);
        return;
      }
      setState({ key: requestKey, report: null, error: '', loading: true });
      try {
        const report = await fetchWorkerBonusAccount({ targetPin: pin, month, force });
        if (!active || request !== sequence) return;
        if (actorKey(getActor()) !== actorIdentity) {
          eligibleRef.current = null;
          setState({ key: requestKey, report: null, error: '', loading: false });
          updateSession(value => value + 1);
          return;
        }
        if (report?.enabled !== false) buildWorkerDailyBonusView(report, `${month}-01`);
        eligibleRef.current = report?.enabled === true ? identityKey : null;
        setState({ key: requestKey, report, error: '', loading: false });
      } catch (error) {
        if (!active || request !== sequence) return;
        eligibleRef.current = null;
        setState({ key: requestKey, report: null, error: error?.message || 'Bonuset ditore nuk u ngarkuan. Provo përsëri.', loading: false });
      }
    }
    refreshRef.current = () => void load(true);
    const refresh = () => void load(true);
    const focus = () => {
      updateSession(value => value + 1);
      if (document.visibilityState !== 'hidden') void load();
    };
    void load();
    window.addEventListener('focus', focus);
    window.addEventListener('arka:refresh', refresh);
    window.addEventListener('base-ready-bonus:refresh', refresh);
    return () => {
      active = false;
      refreshRef.current = null;
      window.removeEventListener('focus', focus);
      window.removeEventListener('arka:refresh', refresh);
      window.removeEventListener('base-ready-bonus:refresh', refresh);
    };
  }, [actorIdentity, sessionIdentity, pin, month, identityKey, requestKey]);

  useEffect(() => {
    const changed = () => {
      if (actorKey(getActor()) !== actorIdentity) {
        eligibleRef.current = null;
        setState({ key: requestKey, report: null, error: '', loading: false });
      }
      updateSession(value => value + 1);
    };
    window.addEventListener('tepiha:session-changed', changed);
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener('tepiha:session-changed', changed);
      window.removeEventListener('storage', changed);
    };
  }, [actorIdentity, requestKey]);

  useEffect(() => { setRowLimit(PAGE_SIZE); }, [date, identityKey]);

  const view = useMemo(() => current.report?.enabled === true ? buildWorkerDailyBonusView(current.report, date) : null, [current.report, date]);

  if (!actorIdentity || actorIdentity !== sessionIdentity || !pin || current.report?.enabled === false) return null;
  if (!current.report && !current.error && !knownEnabled) return null;

  return <section id="bonuset-ditore" className="worker-daily-bonuses" aria-label="Bonuset në Arkën ditore" aria-busy={current.loading}>
    <header className="wdb-header"><div><div className="wdb-eyebrow">ARKA DITORE</div><h2>BONUSET E DATËS</h2><p>Regjistrimet në Arkë për bonusin e bazës dhe kontrollin e transportit.</p></div><button type="button" className="wdb-refresh" disabled={current.loading} onClick={() => refreshRef.current?.()}>{current.loading ? 'Duke ngarkuar…' : 'Rifresko bonuset'}</button></header>
    <div className="wdb-date"><label>Data <input type="date" aria-label="Data e bonuseve ditore" value={date} max={today} onChange={event => { if (validWorkerBonusDay(event.target.value)) setSelectedDate(event.target.value === today ? '' : event.target.value); }} /></label><button type="button" onClick={() => setSelectedDate('')} aria-pressed={date === today}>Sot</button></div>
    {current.error ? <p className="wdb-error" role="alert">{current.error}</p> : null}
    {!view && current.loading ? <p className="wdb-empty" role="status">Duke ngarkuar regjistrimet e bonusit…</p> : null}
    {view ? <>
      <div className="wdb-earned">
        {view.sources.map(source => <div key={source.source} data-daily-bonus-source={source.source}><span>{source.label}</span><strong>{money(source.earned)}</strong><small>{source.count} regjistrime</small></div>)}
        <div className="wdb-total"><span>Regjistruar për këtë datë</span><strong>{money(view.earned)}</strong><small>{view.earnedCount} bonuse</small></div>
      </div>
      {view.bookingWarnings.length ? <p className="wdb-warning" role="status">Për {view.bookingWarnings.length} {view.bookingWarnings.length === 1 ? 'bonus mungon' : 'bonuse mungon'} data e regjistrimit në Arkë. Kërkohet verifikim.{view.bookingWarnings.some(warning => warning.orderCode) ? ` Porositë: ${view.bookingWarnings.map(warning => warning.orderCode).filter(Boolean).slice(0, 3).join(', ')}${view.bookingWarnings.length > 3 ? '…' : '.'}` : ''}</p> : null}
      <ol className="wdb-rows">{view.rows.length ? view.rows.slice(0, rowLimit).map(row => <li key={row.id} data-daily-bonus-id={row.id}>
        <div><strong>{row.label}</strong><span>{row.code || 'Pa kod'} · {postedTime(row.creditedAt)}</span></div>
        <div className="wdb-row-money"><strong>+{money(row.amount)}</strong><span>{STATUSES[row.status] || 'Regjistruar'}</span></div>
      </li>) : <li className="wdb-empty">S'ka bonuse të regjistruara në këtë datë.</li>}</ol>
      {view.rows.length > rowLimit ? <button type="button" className="wdb-more" onClick={() => setRowLimit(value => value + PAGE_SIZE)}>Shfaq edhe {Math.min(PAGE_SIZE, view.rows.length - rowLimit)} bonuse</button> : null}
      <div className="wdb-current">
        <div><span>Bonus në dispozicion tani</span><strong data-daily-bonus-available="true">{money(view.available)}</strong></div>
        <div><span>Bonus në dorëzim</span><strong>{money(view.reserved)}</strong></div>
        <p>Gjendja tani përfshin të gjitha ditët. Te Dorëzo shihen bonusi që mbahet dhe netoja për Dispatch.</p>
      </div>
      <footer><small>Regjistrimet e bonusit ruhen veçmas nga pagesat e klientëve.</small><a href="#bonuset">Llogaria e plotë e bonuseve →</a></footer>
    </> : null}
  </section>;
}
