'use client';

import { useEffect, useRef, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { getActor } from '@/lib/actorSession';
import { canReviewBonusEvidence, isBujar } from '@/lib/baseBonusEvidence';
import { fetchWorkerBonusAccount, workerBonusMonthKey } from '@/lib/workerBonusAccountClient.js';
import './WorkerBonusAccount.css';

const TIME_ZONE = 'Europe/Belgrade';
const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const AREA = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const PAGE_SIZE = 12;
const SOURCE_NAMES = { BASE: 'Bazë', TRANSPORT_CONTROL: 'Kontroll transporti' };
const BONUS_STATUSES = {
  EARNED: ['Në dispozicion', 'blue'],
  RESERVED: ['Në dorëzim', 'gold'],
  PARTIAL_RESERVED: ['Pjesërisht në dorëzim', 'gold'],
  RETAINED: ['E mbajtur', 'green'],
  PARTIAL_RETAINED: ['Pjesërisht e mbajtur', 'green'],
  INELIGIBLE: ['Pa bonus', ''],
  VOIDED: ['Anuluar', ''],
  REVIEW_REQUIRED: ['Kërkon verifikim', 'red'],
};
const HANDOFF_STATUSES = {
  ACCEPTED: ['Pranuar nga Dispatch', 'green'],
  ACCEPTED_BY_DISPATCH: ['Pranuar nga Dispatch', 'green'],
  APPROVED: ['Pranuar nga Dispatch', 'green'],
  PENDING: ['Në pritje të Dispatch-it', 'gold'],
  PENDING_DISPATCH_APPROVAL: ['Në pritje të Dispatch-it', 'gold'],
  REJECTED: ['Kthyer', 'red'],
  CANCELLED: ['Anuluar', ''],
};

function money(value) {
  const number = Number(value ?? 0);
  return `${MONEY.format(Number.isFinite(number) ? number : 0)} €`;
}
function list(value) { return Array.isArray(value) ? value : []; }
function actorKey(actor) {
  const id = String(actor?.id || actor?.user_id || actor?.pin || '').trim();
  return id ? `${id}:${String(actor?.pin || '').trim()}:${String(actor?.role || '').trim().toUpperCase()}` : '';
}
function accessDenied(error) {
  return [401, 403].includes(Number(error?.httpStatus)) || /^(AUTH_|DEVICE_)/.test(String(error?.code || ''))
    || ['WORKER_BONUS_FORBIDDEN', 'WORKER_BONUS_SESSION_CHANGED'].includes(error?.code);
}
function stamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('sq-AL', { timeZone: TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function monthLabel(value) {
  const date = new Date(`${value}-15T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('sq-AL', { timeZone: TIME_ZONE, month: 'long', year: 'numeric' }).format(date);
}
function statusInfo(status, handoff = false) {
  return (handoff ? HANDOFF_STATUSES : BONUS_STATUSES)[String(status || '').toUpperCase()] || ['Në verifikim', ''];
}
function Badge({ status, handoff = false }) {
  const [label, tone] = statusInfo(status, handoff);
  return <span className={`wba-status${tone ? ` wba-status-${tone}` : ''}`}>{label}</span>;
}
function AllocationBadge({ status }) {
  const value = String(status || '').toUpperCase();
  const [label, tone] = ({ RETAINED: ['E mbajtur', 'green'], RESERVED: ['E rezervuar', 'gold'], REVERSED: ['Mbajtja u anulua', 'red'] })[value] || ['Në verifikim', ''];
  return <span className={`wba-status${tone ? ` wba-status-${tone}` : ''}`}>{label}</span>;
}
function Metric({ label, amount, sub, tone = '' }) {
  return <div className={`wba-metric${tone ? ` wba-metric-${tone}` : ''}`}>
    <div className="wba-metric-label">{label}</div><strong>{money(amount)}</strong><small>{sub}</small>
  </div>;
}
function SourceCard({ source }) {
  const transport = source.source === 'TRANSPORT_CONTROL';
  return <section className={`wba-source${transport ? ' wba-source-transport' : ''}`} data-bonus-source={source.source}>
    <div className="wba-source-title"><h3>{SOURCE_NAMES[source.source] || source.label}</h3><span className="wba-source-count">{Number(source.earnedCount || 0)} bonuse të fituara</span></div>
    <strong className="wba-source-main">{money(source.retained)}</strong>
    <span className="wba-source-caption">Të mbajtura me dorëzim të pranuar këtë muaj</span>
    <dl>
      <div><dt>Fituar këtë muaj</dt><dd>{money(source.earned)}</dd></div>
      <div><dt>Në dorëzim tani</dt><dd>{money(source.reserved)}</dd></div>
      <div><dt>Në dispozicion tani</dt><dd>{money(source.available)}</dd></div>
      <div><dt>Mbajtur në gjithë historikun</dt><dd>{money(source.retainedAllTime)}</dd></div>
    </dl>
  </section>;
}
function BonusRow({ row }) {
  const transport = row.source === 'TRANSPORT_CONTROL';
  const handoffs = list(row.handoffs);
  return <article className="wba-row" data-bonus-id={row.id}>
    <div className="wba-row-head">
      <div>
        <div className="wba-row-title"><strong>{row.code || 'Pa kod'}</strong><span className={`wba-source-tag${transport ? ' wba-source-tag-transport' : ''}`}>{SOURCE_NAMES[row.source] || 'Bonus'}</span></div>
        <p className="wba-row-meta">{stamp(row.earnedAt)}{!transport && Number(row.m2) > 0 ? ` · ${AREA.format(Number(row.m2))} m²` : ''}</p>
      </div>
      <Badge status={row.status} />
    </div>
    <div className="wba-row-amounts">
      <div><small>Fituar</small><b>{money(row.amount)}</b></div>
      <div><small>Mbajtur gjithsej</small><b>{money(row.retained)}</b></div>
      <div><small>Në dorëzim</small><b>{money(row.reserved)}</b></div>
      <div><small>Në dispozicion</small><b>{money(row.available)}</b></div>
    </div>
    {handoffs.length ? <details className="wba-row-details">
      <summary>Dorëzimet e këtij bonusi <span>{handoffs.length}</span></summary>
      <ul>{handoffs.map((handoff, index) => <li key={`${handoff.id}-${index}`}>
        <div><b>Dorëzimi #{handoff.id}</b><small>{stamp(handoff.decidedAt || handoff.submittedAt)}</small></div>
        <div><strong>{money(handoff.amount)}</strong><Badge status={handoff.status} handoff /><AllocationBadge status={handoff.allocationStatus} /></div>
      </li>)}</ul>
    </details> : null}
  </article>;
}
function HandoffRow({ handoff }) {
  return <article className="wba-row" data-bonus-handoff={handoff.id}>
    <div className="wba-row-head"><div><div className="wba-row-title"><strong>Dorëzimi #{handoff.id}</strong></div><p className="wba-row-meta">{handoff.decidedAt ? 'Vendosur' : 'Dërguar'} {stamp(handoff.decidedAt || handoff.submittedAt)}</p></div><Badge status={handoff.status} handoff /></div>
    <p className="wba-handoff-total">{money(handoff.total)} <small>bonuse në këtë dorëzim</small></p>
    <div className="wba-handoff-split"><span>Bazë <strong>{money(handoff.base)}</strong></span><span>Kontroll transporti <strong>{money(handoff.transport)}</strong></span></div>
    {list(handoff.allocations).length ? <details className="wba-row-details"><summary>Shiko bonuset e përfshira <span>{handoff.allocations.length}</span></summary><ul>
      {handoff.allocations.map((allocation, index) => <li key={`${allocation.bonusId}-${index}`}><div><b>{allocation.code || 'Pa kod'}</b><small>{SOURCE_NAMES[allocation.source] || 'Bonus'}</small></div><div><strong>{money(allocation.amount)}</strong><AllocationBadge status={allocation.status} /></div></li>)}
    </ul></details> : null}
  </article>;
}
function PendingControl({ control }) {
  const orderStatus = String(control.orderStatus || '').toLowerCase();
  const explanation = !control.blocked ? 'Pret shqyrtimin e provave nga Dispatch.'
    : orderStatus === 'done' ? 'Porosia është dorëzuar. Aprovimi i bonusit kërkon sqarim nga Dispatch.'
      : orderStatus === 'cancelled' ? 'Porosia është anuluar. Bonusi kërkon sqarim nga Dispatch.'
        : 'Gjendja e porosisë e bllokon aprovimin. Kërkohet sqarim nga Dispatch.';
  return <article className="wba-row" data-pending-control={control.id}>
    <div className="wba-row-head"><div><div className="wba-row-title"><strong>{control.code || 'Kontroll transporti'}</strong></div><p className="wba-row-meta">Dërguar {stamp(control.submittedAt)}</p></div><span className={`wba-status ${control.blocked ? 'wba-status-red' : 'wba-status-gold'}`}>{control.blocked ? 'Kërkon sqarim' : 'Në aprovim'}</span></div>
    <p className={`wba-row-note${control.blocked ? ' wba-blocked-note' : ''}`}>{explanation}</p>
    <p className="wba-row-meta">Vlerë e mundshme pas aprovimit: <b>{money(control.potentialAmount)}</b></p>
  </article>;
}

export default function WorkerBonusAccount({ actor, targetPin }) {
  const actorIdentity = actorKey(actor);
  const sessionIdentity = actorKey(getActor());
  const cleanTargetPin = String(targetPin || actor?.pin || '').trim();
  const [, updateSession] = useState(0);
  const [month, setMonth] = useState(() => workerBonusMonthKey());
  const [state, setState] = useState({ key: '', data: null, error: '', loading: false });
  const [sourceFilter, setSourceFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [rowLimit, setRowLimit] = useState(PAGE_SIZE);
  const [handoffLimit, setHandoffLimit] = useState(4);
  const [controlLimit, setControlLimit] = useState(6);
  const [warningLimit, setWarningLimit] = useState(3);
  const refreshRef = useRef(null);
  const eligibilityRef = useRef(null);
  const panelRef = useRef(null);
  const scrolledToAnchor = useRef(false);
  const identityKey = `${actorIdentity}:${cleanTargetPin}`;
  const key = `${identityKey}:${month}`;
  const current = state.key === key ? state : { data: null, error: '', loading: true };
  const knownEligible = eligibilityRef.current?.key === identityKey && eligibilityRef.current.enabled === true;

  useEffect(() => {
    if (!actorIdentity || !cleanTargetPin || actorIdentity !== sessionIdentity) return undefined;
    let active = true;
    let sequence = 0;
    async function load(force = false) {
      const request = ++sequence;
      if (actorKey(getActor()) !== actorIdentity) {
        eligibilityRef.current = null;
        setState({ key, data: null, error: '', loading: false });
        updateSession(value => value + 1);
        return;
      }
      setState(previous => ({ key, data: previous.key === key ? previous.data : null, error: '', loading: true }));
      try {
        const data = await fetchWorkerBonusAccount({ targetPin: cleanTargetPin, month, force });
        if (actorKey(getActor()) !== actorIdentity) {
          const error = new Error('Sesioni ka ndryshuar. Hape përsëri llogarinë.');
          error.code = 'WORKER_BONUS_SESSION_CHANGED';
          throw error;
        }
        if (active && sequence === request) {
          eligibilityRef.current = { key: identityKey, enabled: data?.enabled === true };
          setState({ key, data, error: '', loading: false });
        }
      } catch (error) {
        if (active && sequence === request) {
          const clearSnapshot = accessDenied(error) || actorKey(getActor()) !== actorIdentity;
          if (clearSnapshot) eligibilityRef.current = null;
          setState(previous => ({ key, data: !clearSnapshot && previous.key === key ? previous.data : null, error: error?.message || 'Bonuset nuk u ngarkuan. Provo përsëri.', loading: false }));
        }
      }
    }
    refreshRef.current = () => void load(true);
    const focus = () => { if (document.visibilityState !== 'hidden') void load(); };
    const changed = () => void load(true);
    void load();
    window.addEventListener('focus', focus);
    window.addEventListener('arka:refresh', changed);
    window.addEventListener('base-ready-bonus:refresh', changed);
    return () => {
      active = false;
      refreshRef.current = null;
      window.removeEventListener('focus', focus);
      window.removeEventListener('arka:refresh', changed);
      window.removeEventListener('base-ready-bonus:refresh', changed);
    };
  }, [actorIdentity, sessionIdentity, cleanTargetPin, month, identityKey, key]);

  useEffect(() => {
    const changed = () => {
      if (actorKey(getActor()) !== actorIdentity) {
        eligibilityRef.current = null;
        setState({ key, data: null, error: '', loading: false });
      }
      updateSession(value => value + 1);
    };
    window.addEventListener('tepiha:session-changed', changed);
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener('tepiha:session-changed', changed);
      window.removeEventListener('storage', changed);
    };
  }, [actorIdentity, key]);

  useEffect(() => {
    setRowLimit(PAGE_SIZE); setHandoffLimit(4); setControlLimit(6); setWarningLimit(3);
  }, [key, sourceFilter, statusFilter]);

  useEffect(() => {
    if (current.data?.enabled && !scrolledToAnchor.current && window.location.hash === '#bonuset') {
      scrolledToAnchor.current = true;
      panelRef.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
    }
  }, [current.data?.enabled]);

  if (!actorIdentity || actorIdentity !== sessionIdentity || !cleanTargetPin || current.data?.enabled === false) return null;
  // Wait for eligibility before adding a panel to another worker's account.
  if (!current.data && !current.error && !knownEligible) return null;
  const data = current.data;
  const totals = data?.totals || {};
  const sources = list(data?.sources);
  const bonusRows = list(data?.rows).filter(row => {
    if (sourceFilter !== 'ALL' && row.source !== sourceFilter) return false;
    if (statusFilter === 'AVAILABLE') return Number(row.available) > 0;
    if (statusFilter === 'RESERVED') return Number(row.reserved) > 0;
    if (statusFilter === 'RETAINED') return Number(row.retained) > 0;
    if (statusFilter === 'INELIGIBLE') return ['INELIGIBLE', 'VOIDED', 'REVIEW_REQUIRED'].includes(row.status);
    return true;
  });
  const handoffs = list(data?.handoffs);
  const controls = list(data?.pendingControls);
  const blockedCount = controls.filter(control => control.blocked).length;
  const warnings = list(data?.warnings);
  const selectedMonth = monthLabel(month);
  const canOpenControls = isBujar(actor) || canReviewBonusEvidence(actor);

  return <section id="bonuset" ref={panelRef} className="worker-bonus-account" aria-label="Llogaria e bonuseve" aria-busy={current.loading}>
    <header className="wba-header"><div><div className="wba-eyebrow">Bazë · Kontroll transporti</div><h2>Llogaria e bonuseve</h2>{data?.worker?.name ? <p className="wba-worker-name">{data.worker.name}</p> : null}</div><button type="button" className="wba-refresh" disabled={current.loading} onClick={() => refreshRef.current?.()}>{current.loading ? 'Duke rifreskuar…' : 'Rifresko'}</button></header>
    <div className="wba-month-bar"><label>Muaji <input aria-label="Muaji i bonuseve" type="month" value={month} onChange={event => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) setMonth(event.target.value); }} /></label><span className="wba-month-name">{selectedMonth}</span></div>
    {!data && current.loading ? <p className="wba-empty" role="status">Duke ngarkuar bonuset…</p> : null}
    {current.error ? <div className="wba-notice wba-error" role="alert">{current.error}{data ? ' Shifrat më poshtë janë nga ngarkimi i fundit.' : ''}</div> : null}
    {data ? <>
      <div className="wba-metrics">
        <Metric label="Fituar në muaj" amount={totals.earned} sub={`${Number(totals.earnedCount || 0)} bonuse · ${selectedMonth}`} />
        <Metric label="Mbajtur në muaj" amount={totals.retained} sub="Dorëzime të pranuara nga Dispatch" tone="green" />
        <Metric label="Në dorëzim tani" amount={totals.reserved} sub="Pret pranimin e Dispatch-it" tone="gold" />
        <Metric label="Në dispozicion" amount={totals.available} sub="Për t'u mbajtur në dorëzimin tjetër" tone="green" />
      </div>
      <p className="wba-scope-note">“Fituar” dhe “Mbajtur” i përkasin muajit të zgjedhur. Gjendja në dorëzim dhe në dispozicion përfshin edhe bonuset nga muajt e kaluar.</p>
      <div className="wba-sources">{sources.map(source => <SourceCard key={source.source} source={source} />)}</div>
      <p className="wba-scope-note">Shumat e mbajtura verifikohen nga dorëzimet e pranuara. Një bonus i fituar më herët mund të jetë mbajtur këtë muaj.</p>
      {warnings.length ? <div className="wba-notice" role="status">{warnings.slice(0, warningLimit).map((warning, index) => <p key={`${warning.code}-${warning.bonusId}-${index}`}>Ka një mospërputhje në historikun e bonusit {warning.orderCode || ''} prej {money(warning.difference)}; duhet verifikim.</p>)}{warnings.length > warningLimit ? <button type="button" className="wba-more" onClick={() => setWarningLimit(warnings.length)}>Shiko të gjitha mospërputhjet ({warnings.length})</button> : null}</div> : null}

      <section className="wba-section" aria-label="Lista e bonuseve">
        <div className="wba-section-head"><div><h3>Regjistrimet e bonusit</h3><p>Bonuset e fituara ose të mbajtura këtë muaj, bashkë me çdo bonus ende të hapur.</p></div><span className="wba-count">{bonusRows.length}</span></div>
        <div className="wba-filter-bar"><div className="wba-filters" aria-label="Burimi i bonusit">{[['ALL', 'Të gjitha'], ['BASE', 'Bazë'], ['TRANSPORT_CONTROL', 'Transport']].map(([value, label]) => <button type="button" key={value} aria-pressed={sourceFilter === value} onClick={() => setSourceFilter(value)}>{label}</button>)}</div><select aria-label="Gjendja e bonusit" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="ALL">Çdo gjendje</option><option value="RETAINED">Të mbajtura</option><option value="RESERVED">Në dorëzim</option><option value="AVAILABLE">Në dispozicion</option><option value="INELIGIBLE">Pa bonus / verifikim</option></select></div>
        <div className="wba-list">{bonusRows.length ? bonusRows.slice(0, rowLimit).map(row => <BonusRow key={row.id} row={row} />) : <p className="wba-empty">S'ka bonuse për këtë muaj dhe filtër.</p>}</div>
        {bonusRows.length > rowLimit ? <button type="button" className="wba-more" onClick={() => setRowLimit(value => value + PAGE_SIZE)}>Shfaq edhe {Math.min(PAGE_SIZE, bonusRows.length - rowLimit)} · {bonusRows.length - rowLimit} të tjera</button> : null}
      </section>

      <section className="wba-section" aria-label="Dorëzimet me bonuse">
        <div className="wba-section-head"><div><h3>Ku janë mbajtur bonuset</h3><p>Dorëzimet e muajit dhe ato që presin pranimin. Çdo shumë më poshtë është vetëm pjesa e bonusit.</p></div><span className="wba-count">{handoffs.length}</span></div>
        <div className="wba-list">{handoffs.length ? handoffs.slice(0, handoffLimit).map(handoff => <HandoffRow key={handoff.id} handoff={handoff} />) : <p className="wba-empty">S'ka dorëzime me bonuse për këtë periudhë.</p>}</div>
        {handoffs.length > handoffLimit ? <button type="button" className="wba-more" onClick={() => setHandoffLimit(value => value + 8)}>Shiko dorëzime të tjera ({handoffs.length - handoffLimit})</button> : null}
      </section>

      {controls.length ? <section className="wba-section" aria-label="Kontrollet që presin aprovim">
        <div className="wba-section-head"><div><h3>Kontrollet në pritje</h3><p>{controls.length - blockedCount} për shqyrtim{blockedCount ? ` · ${blockedCount} kërkojnë sqarim` : ''}</p></div><span className="wba-count">{controls.length}</span></div>
        <p className="wba-scope-note">Këto kontrolle ende presin aprovim. Vlera e tyre bëhet bonus i fituar pas aprovimit.</p>
        <div className="wba-list wba-pending-list">{controls.slice(0, controlLimit).map(control => <PendingControl key={control.id} control={control} />)}</div>
        {controls.length > controlLimit ? <button type="button" className="wba-more" onClick={() => setControlLimit(value => value + 12)}>Shiko kontrolle të tjera ({controls.length - controlLimit})</button> : null}
      </section> : null}
      <footer className="wba-footer"><small>Përditësuar {stamp(data.generatedAt)}</small>{canOpenControls ? <Link href="/kontrolli-transportit">Shiko kontrollet e transportit →</Link> : null}</footer>
    </> : null}
  </section>;
}
