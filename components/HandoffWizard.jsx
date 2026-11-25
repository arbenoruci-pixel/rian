'use client';

// WORKER_HANDOFF_WIZARD_V1: every financial amount is reviewed from one server snapshot.
import { useEffect, useId, useRef, useState } from 'react';
import { workerHandoffApi } from '@/lib/workerHandoffClient';
import {
  HANDOFF_STEPS, EXPENSE_CATEGORIES, FUNDING_SOURCES, handoffMoney as money,
  handoffDate as date, parseHandoffCash, handoffDifference, handoffDifferenceText,
  newHandoffExpense, normalizeHandoffExpense, handoffExpenseDescription, handoffErrorMessage, verifyHandoffPreview,
} from './workerHandoffWizardModel.js';
import './HandoffWizard.css';

const emptyOptions = () => ({ expenses:[] });
const actorScope = actor => `${actor?.id || actor?.user_id || ''}:${String(actor?.role || '').toUpperCase()}`;
const sourceName = source => String(source || '').toUpperCase().includes('TRANSPORT') ? 'Transport' : 'Bazë';
const isReadyNumber = value => value != null && Number.isFinite(Number(value));
const warningText = warning => {
  const value = typeof warning === 'string' ? warning : warning?.message || '';
  return { NO_READY_PAYMENTS:'Nuk ka pagesa të reja për dorëzim.', MEAL_CHOICE_REQUIRED:'Zgjedhja e ushqimit plotësohet te hapi 3.' }[value]
    || (/^[A-Z0-9_]+$/.test(value) ? 'Ky regjistrim kërkon kontroll nga dispatch-i.' : value);
};

function PreviousHandoffs({ rows }) {
  if (!rows.length) return null;
  return <details className="whw-pending" data-handoff-previous="1">
    <summary>{rows.length} dorëzime të mëparshme presin pranimin</summary>
    <p>Këto regjistrime vazhdojnë veçmas. Paratë dhe zbritjet e tyre mbeten te dorëzimi përkatës.</p>
    <ul>{rows.map(row => <li key={row.id}><span>Dorëzimi #{row.id}<br />{date(row.submittedAt)}</span><strong>Mbeten {money(row.outstandingAmount ?? row.amount)}</strong></li>)}</ul>
  </details>;
}

function Line({ label, value, sub, emphasis = false, children, ...rest }) {
  return <div className={`whw-line${emphasis ? ' whw-line-emphasis' : ''}`} {...rest}><span>{label}{sub ? <small>{sub}</small> : null}</span><strong>{children || value}</strong></div>;
}

function Total({ label, value, sub, amber = false, ...rest }) {
  return <div className={`whw-total${amber ? ' whw-total-amber' : ''}`} {...rest}><div className="whw-total-label">{label}</div><div className="whw-total-value">{money(value)}</div>{sub ? <small>{sub}</small> : null}</div>;
}

function PaymentCards({ rows }) {
  return <div className="whw-stack">{rows.map(row => <article className="whw-card" key={row.id} data-handoff-payment={row.id}>
    <div className="whw-card-head"><div><strong>{row.code ? `#${row.code}` : 'Pa kod'} · {row.clientName || 'Klienti'}</strong><div className="whw-card-meta">{date(row.collectedAt)} · {sourceName(row.sourceModule)}</div></div><strong className="whw-card-amount">{money(row.amount)}</strong></div>
  </article>)}</div>;
}

function ExpenseCards({ rows, onRemove }) {
  return <div className="whw-stack">{rows.map((row, index) => {
    const id = row.clientKey || row.existingPaymentId || index;
    const applied = isReadyNumber(row.deductionAmount) ? Number(row.deductionAmount) : Number(row.amount);
    const mealOffset = isReadyNumber(row.mealAlreadyDeducted) ? Number(row.mealAlreadyDeducted) : 0;
    return <article className="whw-card" key={id} data-handoff-expense={id}>
      <div className="whw-card-head"><div><strong>{handoffExpenseDescription(row.description) || EXPENSE_CATEGORIES[row.category] || 'Shpenzim'}</strong><div className="whw-card-meta">{date(row.spentOn, false)}{row.recipient ? ` · ${row.recipient}` : ''}</div></div><strong className="whw-card-amount">{money(row.amount)}</strong></div>
      <div className="whw-card-meta">{FUNDING_SOURCES[row.fundingSource] || 'Burimi për verifikim'}</div>
      <p className="whw-card-desc"><span className="whw-badge whw-badge-amber">Pret verifikimin</span>{row.existingPaymentId ? ` · Regjistrimi #${row.existingPaymentId}` : ' · Kërkesë e re'}</p>
      {row.fundingSource === 'WORKER_COLLECTIONS' ? <p className="whw-card-desc">{mealOffset > 0 ? `Ushqim i llogaritur një herë: ${money(mealOffset)}. Kërkesa shtesë: ${money(applied)}.` : 'Përfshihet në llogaritjen e propozuar; dispatch-i kontrollon burimin.'}</p> : <p className="whw-card-desc">Cash-i i këtij dorëzimi mbetet i pandryshuar nga kjo kërkesë.</p>}
      {row.includesOwnMeal && !mealOffset ? <div className="whw-card-meta">Përfshin edhe ushqimin personal. Kontrollohet bashkë me zbritjen e ushqimit.</div> : null}
      {onRemove ? <div className="whw-card-actions"><button type="button" className="whw-button whw-button-small whw-button-danger" onClick={() => onRemove(row.clientKey)}>Hiqe nga kjo kërkesë</button></div> : null}
    </article>;
  })}</div>;
}

function Breakdown({ preview, physical, reason, compact = false }) {
  const totals = preview.totals;
  const difference = handoffDifference(physical, totals.projectedCash);
  return <div>
    <Line label="Pagesa të regjistruara nga klientët" value={money(totals.grossCash)} />
    {Number(totals.commission) > 0 ? <Line label="Komisioni që mbetet te punëtori" value={`− ${money(totals.commission)}`} /> : null}
    <Line label="Bonusi i këtij dorëzimi" value={`− ${money(totals.bonusDeduction)}`} sub="Llogaritet një herë." />
    <Line label="Ushqimi i këtij dorëzimi" value={`− ${money(totals.mealDeduction)}`} sub={preview.mealPolicy?.dailyAllowed ? 'Sipas regjistrimeve dhe zgjedhjes për sot.' : 'Vetëm regjistrimet e mëparshme. Shtesa e re kalon në rrogë.'} />
    <Line label="Pritet para kërkesave të shpenzimeve" value={money(totals.expectedCash)} emphasis data-handoff-expected="1" />
    <Line label="Shpenzime të deklaruara nga paratë e klientëve" value={`− ${money(totals.claimedCollectionExpenses)}`} sub="Në pritje të verifikimit të dispatch-it." />
    {compact ? <Line label="Cash sipas llogaritjes së propozuar" value={money(totals.projectedCash)} emphasis data-handoff-projected="1" /> : <Total label="Cash sipas llogaritjes së propozuar" value={totals.projectedCash} sub="Dispatch-i verifikon shpenzimet dhe regjistron paratë që pranon realisht." data-handoff-projected="1" />}
    {physical != null ? <><Line label="Paratë e numëruara nga ti" value={money(physical)} emphasis /><Line label="Dallimi nga llogaritja" value={money(Math.abs(difference))} sub={handoffDifferenceText(difference)} data-handoff-difference="1" />{reason ? <div className="whw-note">Sqarimi yt: {reason}</div> : null}</> : null}
  </div>;
}

export default function HandoffWizard({ open, actor, onClose, onSaved, api = workerHandoffApi }) {
  const titleId = useId();
  const scope = actorScope(actor);
  const liveScope = useRef(scope); liveScope.current = scope;
  const callbacks = useRef({ onClose, onSaved }); callbacks.current = { onClose, onSaved };
  const sequence = useRef(0), submitting = useRef(false), bodyRef = useRef(null), dialogRef = useRef(null), headingRef = useRef(null);
  const [stateScope, setStateScope] = useState('');
  const [step, setStep] = useState(1), [preview, setPreview] = useState(null), [options, setOptions] = useState(emptyOptions), [reviewOptions, setReviewOptions] = useState(emptyOptions);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [physical, setPhysical] = useState(''), [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState(null), [pendingIntent, setPendingIntent] = useState(null);
  const [expenseForm, setExpenseForm] = useState(null), [expenseError, setExpenseError] = useState('');
  const [sessionChanged, setSessionChanged] = useState(false);
  const visible = !sessionChanged && stateScope === scope;
  const current = visible ? preview : null;
  const saved = visible ? receipt : null;
  const pending = visible ? pendingIntent : null;
  const parsedCash = parseHandoffCash(physical);
  const difference = current ? handoffDifference(parsedCash, current.totals.projectedCash) : null;
  const dirty = JSON.stringify(options) !== JSON.stringify(reviewOptions);
  const busy = saving || loading;

  async function loadPreview(nextOptions, nextStep) {
    const request = ++sequence.current;
    const requestedScope = scope;
    setLoading(true); setError('');
    try {
      const result = verifyHandoffPreview(await api.preview(nextOptions));
      if (request !== sequence.current || liveScope.current !== requestedScope) return false;
      if (result.actorId && result.actorId !== (actor?.id || actor?.user_id)) throw new Error('HANDOFF_SESSION_CHANGED');
      const resolvedOptions = { ...nextOptions, expenses:[...(nextOptions.expenses || [])] };
      // Keep the exact options that produced this hash, including a missing meal
      // choice under monthly policy. The server owns policy normalization.
      setPreview(result); setStateScope(requestedScope); setOptions(resolvedOptions); setReviewOptions(resolvedOptions);
      setPhysical(''); setReason(''); setConfirmed(false);
      if (nextStep) setStep(nextStep);
      return true;
    } catch (err) {
      if (request === sequence.current && liveScope.current === requestedScope) setError(handoffErrorMessage(err));
      return false;
    } finally {
      if (request === sequence.current && liveScope.current === requestedScope) setLoading(false);
    }
  }

  useEffect(() => {
    sequence.current++;
    setStateScope(scope); setStep(1); setPreview(null); setOptions(emptyOptions()); setReviewOptions(emptyOptions());
    setPhysical(''); setReason(''); setConfirmed(false); setReceipt(null); setPendingIntent(null); setError(''); setExpenseForm(null); setExpenseError('');
    setSessionChanged(false);
    submitting.current = false; setSaving(false); setLoading(!!open);
    if (!open) return;
    const startSequence = sequence.current;
    (async () => {
      try {
        const intent = await api.pending({ serverRecovery:true });
        if (startSequence !== sequence.current || liveScope.current !== scope) return;
        if (intent) { setPendingIntent(intent); setLoading(false); return; }
        await loadPreview(emptyOptions(), 1);
      } catch (err) {
        if (startSequence === sequence.current && liveScope.current === scope) { setError(handoffErrorMessage(err)); setLoading(false); }
      }
    })();
    return () => { sequence.current++; };
  }, [open, scope, api]);

  useEffect(() => {
    if (!open) return;
    const invalidate = () => {
      // The session event may arrive before a parent has updated actor props.
      // Immediately hide the old account and invalidate both reads and writes.
      sequence.current++;
      setSessionChanged(true); setStateScope(''); setPreview(null); setReceipt(null); setPendingIntent(null);
      setPhysical(''); setReason(''); setConfirmed(false); setOptions(emptyOptions()); setReviewOptions(emptyOptions());
      setExpenseForm(null); setExpenseError(''); setError(''); setLoading(false); setSaving(false);
      submitting.current = false;
      callbacks.current.onClose?.();
    };
    window.addEventListener('tepiha:session-changed', invalidate);
    return () => window.removeEventListener('tepiha:session-changed', invalidate);
  }, [open, scope]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus?.({ preventScroll:true }); };
  }, [open]);

  useEffect(() => {
    if (!open || loading) return;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    headingRef.current?.focus?.({ preventScroll:true });
  }, [open, step, loading, pendingIntent, receipt]);

  function changeOptions(patch) {
    setOptions(previous => ({ ...previous, ...patch }));
    setPhysical(''); setReason(''); setConfirmed(false); setError('');
  }

  function close() {
    if (submitting.current) return;
    sequence.current++;
    callbacks.current.onClose?.();
  }

  function trapFocus(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) { if (expenseForm) setExpenseForm(null); else close(); }
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || []);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function validatePhysical() {
    if (parsedCash == null) { setError('Numëro paratë dhe shkruaje shumën reale me deri në dy shifra pas presjes.'); return false; }
    if (difference !== 0 && reason.trim().length < 4) { setError('Shpjego pse shuma e numëruar ndryshon nga llogaritja.'); return false; }
    setError(''); return true;
  }

  async function next() {
    if (busy || !current) return;
    if (step < 3) { setError(''); setStep(step + 1); return; }
    if (step === 3) {
      if (expenseForm) { setExpenseError('Ruaje ose mbylle shpenzimin para se të vazhdosh.'); return; }
      if (current.mealPolicy.dailyAllowed && current.mealPolicy.requiresDecision && !options.mealChoice) { setError('Zgjedhe çfarë ka ndodhur me ushqimin sot.'); return; }
      if (options.mealChoice === 'other' && !options.mealPayerId) { setError('Zgjedhe personin që ka paguar ushqimin.'); return; }
      await loadPreview(options, 4); return;
    }
    if (step === 4 && validatePhysical()) { setConfirmed(false); setStep(5); }
  }

  async function save(retry = false) {
    if (submitting.current || sessionChanged || liveScope.current !== scope) return;
    if (!retry && (!current || !current.canSubmit || dirty || !validatePhysical() || !confirmed)) {
      if (!confirmed) setError('Konfirmo që i ke kontrolluar regjistrimet dhe i ke numëruar paratë.');
      return;
    }
    submitting.current = true; setSaving(true); setError('');
    const requestedScope = scope;
    const request = ++sequence.current;
    const payload = retry ? pending : { snapshotHash:current.snapshotHash, options:reviewOptions, physicalCash:parsedCash, differenceReason:reason.trim() };
    try {
      const result = await api.submit(payload, { retry, serverRecovery:true });
      if (request !== sequence.current || liveScope.current !== requestedScope) return;
      if (result?.ok !== true || !result.submission || !result.handoffId) throw new Error('Konfirmimi i dorëzimit nuk u kthye i plotë. Riprovo të njëjtën kërkesë.');
      setReceipt(result); setPendingIntent(null); setExpenseForm(null);
      try { Promise.resolve(callbacks.current.onSaved?.(result)).catch(() => {}); } catch {}
    } catch (err) {
      if (request !== sequence.current || liveScope.current !== requestedScope) return;
      try { const intent = await api.pending({ serverRecovery:true }); if (request === sequence.current && liveScope.current === requestedScope) setPendingIntent(intent || null); } catch {}
      if (request === sequence.current && liveScope.current === requestedScope) setError(handoffErrorMessage(err));
    } finally {
      if (request === sequence.current && liveScope.current === requestedScope) { submitting.current = false; setSaving(false); }
    }
  }

  function addExpense() {
    try {
      if (!current.mealPolicy.dailyAllowed && !expenseForm.existingPaymentId && expenseForm.category === 'FOOD') throw new Error('Ushqimi i ri është pjesë e rrogës mujore. Zgjedh llojin e shpenzimit tjetër që po deklaron.');
      const row = normalizeHandoffExpense(expenseForm, options.expenses || []);
      if (row.spentOn > current.businessDate) throw new Error('Data e shpenzimit nuk mund të jetë në të ardhmen.');
      changeOptions({ expenses:[...(options.expenses || []), row] });
      setExpenseForm(null); setExpenseError('');
    } catch (err) { setExpenseError(err.message); }
  }

  if (!open) return null;
  const selectedIds = new Set((options.expenses || []).map(row => row.existingPaymentId).filter(id => id != null).map(String));
  const shownExpenses = dirty ? options.expenses || [] : current?.expenses || [];
  const availableStaff = (current?.mealPayers || current?.mealPolicy?.staffOptions || []).filter(row => String(row.id || row.userId) !== String(actor?.id || actor?.user_id));
  const progressVisible = current && !saved && !pending;
  const showNext = current && current.payments.length > 0 && !saved && !pending;

  return <div className="whw-overlay" data-worker-handoff-wizard="1" onKeyDown={trapFocus}>
    <section ref={dialogRef} className="whw-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="whw-header"><div><div className="whw-kicker">Dorëzimi i parave</div><h1 id={titleId} className="whw-title">Llogaria para dorëzimit</h1><div className="whw-worker">{actor?.name || 'Llogaria ime'}{current?.businessDate ? ` · ${date(current.businessDate, false)}` : ''}</div></div><button className="whw-close" type="button" aria-label="Mbylle dorëzimin" disabled={saving} onClick={close}>×</button></header>
      {progressVisible ? <nav className="whw-progress" aria-label="Hapat e dorëzimit"><div className="whw-progress-label"><span>Hapi {step} nga 5</span><strong>{HANDOFF_STEPS[step - 1]}</strong></div><div className="whw-progress-bars" aria-hidden="true">{HANDOFF_STEPS.map((label, index) => <span key={label} data-done={index < step} />)}</div></nav> : null}
      <div className="whw-body" ref={bodyRef}>
        {sessionChanged ? <div className="whw-warning" role="status">Llogaria ka ndryshuar. Hape dorëzimin nga llogaria aktive për ta vazhduar.</div> : (!visible || (loading && !current && !pending)) ? <div className="whw-loading" role="status">Po lexohen pagesat, bonuset dhe shpenzimet…</div> : null}
        {visible && pending && !saved ? <div data-handoff-pending-retry="1"><h2 className="whw-step-title" ref={headingRef} tabIndex={-1}>Kërkesa pret konfirmimin</h2><p className="whw-lead">Një dorëzim është dërguar dhe përgjigjja përfundimtare mungon. Riprovoje të njëjtën kërkesë që të kontrollohet rezultati.</p><Total label="Paratë që ke deklaruar" value={pending.physicalCash} sub="Shuma e ruajtur në kërkesën e mëparshme." />{pending.differenceReason ? <div className="whw-note">Sqarimi yt: {pending.differenceReason}</div> : null}<p className="whw-lead whw-section">Riprova përdor të njëjtën kërkesë të ruajtur. Regjistrimi mbrohet nga përsëritja.</p></div> : null}
        {saved ? <div className="whw-receipt" data-handoff-receipt="1"><div className="whw-receipt-mark" aria-hidden="true">✓</div><h2 className="whw-step-title" ref={headingRef} tabIndex={-1}>U dërgua për pranim</h2><span className="whw-receipt-reference">Dorëzimi #{saved.handoffId}</span><p className="whw-lead">Dispatch-i e sheh këtë llogaritje, shpenzimet e deklaruara dhe shumën që ke numëruar.</p><Total label="Paratë e deklaruara nga ti" value={saved.submission.physicalCash} sub="Pranimi real regjistrohet nga dispatch-i pasi t’i numërojë paratë." /><Line label="Pritet para kërkesave të shpenzimeve" value={money(saved.submission.expectedCash)} /><Line label="Llogaritja pas kërkesave të shpenzimeve" value={money(saved.submission.projectedCash)} /><Line label="Dallimi nga llogaritja" value={money(Math.abs(handoffDifference(Number(saved.submission.physicalCash), saved.submission.projectedCash) || 0))} sub={handoffDifferenceText(handoffDifference(Number(saved.submission.physicalCash), saved.submission.projectedCash))} />{saved.submission.differenceReason ? <div className="whw-note whw-section">Sqarimi: {saved.submission.differenceReason}</div> : null}{saved.submission.createdAt ? <div className="whw-card-meta whw-section">Regjistruar më {date(saved.submission.createdAt)}</div> : null}{saved.claims?.length ? <div className="whw-warning whw-section">{saved.claims.length} kërkesa shpenzimesh presin verifikimin e dispatch-it. Shuma përfundimtare e mbetur ndiqet në këtë dorëzim.</div> : null}</div> : null}

        {current && !saved && !pending ? <fieldset className="whw-step" disabled={busy} data-handoff-step={step} aria-label={HANDOFF_STEPS[step - 1]}>
          {step === 1 ? <><h2 className="whw-step-title" ref={headingRef} tabIndex={-1}>Pagesat nga klientët</h2><p className="whw-lead">Kontrollo secilën pagesë të regjistruar dhe datën e saj. Këto janë pagesat e reja që po përgatit për dorëzim.</p><PreviousHandoffs rows={current.pendingHandoffs} /><Total label={`${current.payments.length} pagesa të regjistruara`} value={current.totals.grossCash} sub="Shuma para komisionit, bonuseve dhe ushqimit." />{current.payments.length ? <PaymentCards rows={current.payments} /> : <div className="whw-empty">Nuk ke pagesa të reja për dorëzim. Dorëzimet e mëparshme vazhdojnë të ndiqen te lista e pranimeve.</div>}{Number(current.totals.commission) > 0 ? <Line label="Komision transporti që e mban" value={money(current.totals.commission)} /> : null}</> : null}

          {step === 2 ? <><h2 className="whw-step-title" ref={headingRef} tabIndex={-1}>Bonusi që përfshihet këtu</h2><p className="whw-lead">Bonuset e disponueshme lexohen nga regjistrimet. Shuma për këtë dorëzim llogaritet një herë.</p><Total label="Bonus që zbritet në këtë dorëzim" value={current.totals.bonusDeduction} sub="Ky është bonusi që mbetet te ti nga këto para." amber /><div className="whw-stack">{current.bonuses.length ? current.bonuses.map(row => <article className="whw-card" key={row.bonusId} data-handoff-bonus={row.bonusId}><div className="whw-card-head"><strong>{sourceName(row.kind) === 'Transport' ? 'Kontroll transporti' : 'Bonus baze'}{row.code ? ` · #${row.code}` : ''}</strong><strong className="whw-card-amount">{money(row.remainingAmount)}</strong></div><div className="whw-card-meta">Në dispozicion për dorëzim{isReadyNumber(row.amount) ? ` · I fituar: ${money(row.amount)}` : ''}</div></article>) : <div className="whw-empty">Nuk ka bonus të disponueshëm për këtë dorëzim.</div>}</div>{Number(current.totals.bonusRemaining) > 0 ? <div className="whw-note whw-section">{money(current.totals.bonusRemaining)} bonus mbeten në dispozicion pas këtij dorëzimi.</div> : null}<div className="whw-note whw-section">Bonuset e lidhura me dorëzimet e mëparshme qëndrojnë te ato regjistrime. Këtu përfshihet vetëm pjesa e disponueshme.</div></> : null}

          {step === 3 ? <><h2 className="whw-step-title" ref={headingRef} tabIndex={-1}>Ushqimi dhe shpenzimet</h2><p className="whw-lead">Trego çfarë është paguar dhe nga cilat para. Dispatch-i kontrollon çdo kërkesë shpenzimi.</p><h3 className="whw-section-title">Ushqimi për sot</h3>
            {!current.mealPolicy.dailyAllowed ? <div className="whw-note">Ushqimi i ri është pjesë e rrogës mujore. Në këtë dorëzim përfshihen vetëm regjistrime të mëparshme të pazbritura.</div> : current.mealPolicy.coveredToday === true || current.mealPolicy.choice === 'existing' ? <div className="whw-note">Ushqimi për sot është verifikuar në regjistrime.{Number(current.mealPolicy.existingMealTotal) > 0 ? ` Për t’u llogaritur: ${money(current.mealPolicy.existingMealTotal)}.` : ' Zbritja e re për sot është 0,00 €.'}</div> : <div className="whw-stack" role="group" aria-label="Çfarë ka ndodhur me ushqimin sot?">{[['self','E kam paguar vetë','Zbritja personale kontrollohet sipas rregullit të ushqimit.'],['other','E ka paguar një punëtor tjetër','Zgjedhe paguesin që të ruhet lidhja e saktë.'],['none','Nuk kam marrë ushqim sot','Pa zbritje të re për sot.']].filter(([value]) => value !== 'self' || current.mealPolicy.eligibleSelf !== false).map(([value,label,sub]) => <button type="button" className="whw-choice" key={value} data-selected={options.mealChoice === value} aria-pressed={options.mealChoice === value} onClick={() => changeOptions({ mealChoice:value, mealPayerId:null })}><span className="whw-choice-mark" aria-hidden="true" /><span><strong>{label}</strong><small>{sub}</small></span></button>)}</div>}
            {options.mealChoice === 'other' ? <label className="whw-field">Kush e ka paguar ushqimin?<select className="whw-select" value={options.mealPayerId || ''} onChange={event => changeOptions({ mealPayerId:event.target.value || null })}><option value="">Zgjedhe punëtorin</option>{availableStaff.map(row => <option key={row.id || row.userId} value={row.id || row.userId}>{row.name || 'Punëtori'}</option>)}</select>{!availableStaff.length ? <small>Lista e punëtorëve nuk u ngarkua. Rifresko llogaritjen.</small> : null}</label> : null}
            {Number(current.mealPolicy.existingMealTotal) > 0 ? <Line label="Ushqim i regjistruar për t’u zbritur" value={money(current.mealPolicy.existingMealTotal)} sub="Përfshin regjistrimet e mëparshme të pazbritura." /> : null}
            {current.meals?.length ? <details className="whw-details"><summary>Regjistrimet e ushqimit ({current.meals.length})</summary>{current.meals.map(row => <Line key={row.id} label={`Ushqim · ${date(row.day, false)}`} value={money(row.amount)} sub={`Regjistrimi #${row.id} · përfshihet një herë në këtë dorëzim.`} />)}</details> : null}
            <section className="whw-section"><h3 className="whw-section-title">Shpenzimet e kësaj kërkese</h3><p className="whw-lead">{current.mealPolicy.dailyAllowed ? 'Përfshi karburant, ushqim ekipi, materiale ose pagesa të tjera me përshkrim dhe datë.' : 'Përfshi karburant, materiale ose shpenzime të tjera të punës me përshkrim dhe datë. Ushqimi i ri është pjesë e rrogës mujore.'}</p>{shownExpenses.length ? <ExpenseCards rows={shownExpenses} onRemove={clientKey => changeOptions({ expenses:(options.expenses || []).filter(row => row.clientKey !== clientKey) })} /> : <div className="whw-empty">Ende nuk është shtuar shpenzim në këtë kërkesë.</div>}<button className="whw-button whw-full whw-section" type="button" disabled={!!expenseForm} onClick={() => { setExpenseForm(newHandoffExpense(current.businessDate)); setExpenseError(''); }}>+ Shto shpenzim</button></section>
            {current.existingExpenses.length ? <details className="whw-details"><summary>Zgjedh nga shpenzimet e regjistruara ({current.existingExpenses.length})</summary><div className="whw-stack">{current.existingExpenses.map(row => <article className="whw-card" key={row.paymentId}><div className="whw-card-head"><strong>{handoffExpenseDescription(row.description) || `Shpenzimi #${row.paymentId}`}</strong><strong className="whw-card-amount">{money(row.amount)}</strong></div><div className="whw-card-meta">{date(row.spentOn, false)} · {row.ledgerPosted ? 'Regjistruar më parë · burimi kërkon konfirmim' : String(row.status || '').toUpperCase().includes('PENDING') ? 'Në pritje të verifikimit' : 'Regjistrim ekzistues'}</div><p className="whw-card-desc">Dispatch-i kontrollon që shpenzimi të llogaritet një herë.</p><div className="whw-card-actions"><button type="button" className="whw-button whw-button-small" disabled={!!expenseForm || selectedIds.has(String(row.paymentId))} onClick={() => { setExpenseForm(newHandoffExpense(current.businessDate, row)); setExpenseError(''); }}>{selectedIds.has(String(row.paymentId)) ? 'Përfshirë në kërkesë' : 'Zgjedhe këtë shpenzim'}</button></div></article>)}</div></details> : null}
            {expenseForm ? <section className="whw-form" aria-label="Përshkrimi i shpenzimit"><div className="whw-form-header"><h3>{expenseForm.existingPaymentId ? 'Burimi i shpenzimit ekzistues' : 'Shpenzim i ri'}</h3></div>{expenseForm.ledgerPosted ? <div className="whw-warning whw-section">Ky shpenzim është regjistruar më parë. Dispatch-i do ta verifikojë burimin para çdo sqarimi të gjendjes.</div> : null}
              <div className="whw-form-grid"><label className="whw-field">Shuma (€)<input className="whw-input" inputMode="decimal" value={expenseForm.amount} readOnly={!!expenseForm.existingPaymentId} onChange={event => setExpenseForm({ ...expenseForm, amount:event.target.value })} /></label><label className="whw-field">Data e shpenzimit<input className="whw-input" type="date" max={current.businessDate} readOnly={!!expenseForm.existingPaymentId} value={expenseForm.spentOn} onChange={event => setExpenseForm({ ...expenseForm, spentOn:event.target.value })} /></label></div>
              <label className="whw-field">Për çfarë është paguar?<input className="whw-input" maxLength={500} readOnly={!!expenseForm.existingPaymentId} value={expenseForm.description} onChange={event => setExpenseForm({ ...expenseForm, description:event.target.value })} placeholder={current.mealPolicy.dailyAllowed ? 'P.sh. ushqimi për ekipin' : 'P.sh. materiale për punë'} /></label><label className="whw-field">Lloji i shpenzimit<select className="whw-select" value={expenseForm.category} onChange={event => setExpenseForm({ ...expenseForm, category:event.target.value, includesOwnMeal:null })}>{Object.entries(EXPENSE_CATEGORIES).filter(([value]) => value !== 'FOOD' || current.mealPolicy.dailyAllowed || !!expenseForm.existingPaymentId).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="whw-field">Për kë / kujt? <small>Opsionale; ndihmon dispatch-in ta identifikojë pagesën.</small><input className="whw-input" maxLength={150} value={expenseForm.recipient} onChange={event => setExpenseForm({ ...expenseForm, recipient:event.target.value })} placeholder="Emri i personit ose vendit" /></label><label className="whw-field">Nga cilat para është paguar?<select className="whw-select" value={expenseForm.fundingSource} onChange={event => setExpenseForm({ ...expenseForm, fundingSource:event.target.value, includesOwnMeal:null })}><option value="">Zgjedhe burimin e parave</option>{Object.entries(FUNDING_SOURCES).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              {expenseForm.fundingSource === 'WORKER_COLLECTIONS' ? <div className="whw-note whw-section">Kërkesa përfshihet te llogaritja e propozuar dhe pret verifikimin e dispatch-it.</div> : expenseForm.fundingSource ? <div className="whw-note whw-section">Kjo kërkesë shfaqet veçmas për verifikim. Paratë e klientëve për dorëzim mbeten të njëjta.</div> : null}
              {expenseForm.category === 'FOOD' && expenseForm.fundingSource === 'WORKER_COLLECTIONS' ? <fieldset className="whw-step whw-section" aria-label="A përfshin ky shpenzim edhe ushqimin tënd?" data-handoff-own-meal-choice="1"><legend className="whw-section-title">A përfshin ky shpenzim edhe ushqimin tënd?</legend><p className="whw-lead">Zgjedh Po ose Jo. Sistemi kontrollon pjesën personale që të llogaritet një herë.</p><label className="whw-checkbox"><input type="radio" name={`${titleId}-own-meal`} value="yes" required checked={expenseForm.includesOwnMeal === true} onChange={() => { setExpenseForm({ ...expenseForm, includesOwnMeal:true }); setExpenseError(''); }} /><span>Po, përfshin edhe ushqimin tim.</span></label><label className="whw-checkbox"><input type="radio" name={`${titleId}-own-meal`} value="no" required checked={expenseForm.includesOwnMeal === false} onChange={() => { setExpenseForm({ ...expenseForm, includesOwnMeal:false }); setExpenseError(''); }} /><span>Jo, është për personat e tjerë.</span></label></fieldset> : null}{expenseError ? <div className="whw-error" role="alert">{expenseError}</div> : null}<div className="whw-form-buttons"><button type="button" className="whw-button" onClick={() => { setExpenseForm(null); setExpenseError(''); }}>Anulo</button><button type="button" className="whw-button whw-button-primary" onClick={addExpense}>Përfshije në kërkesë</button></div>
            </section> : null}{dirty ? <div className="whw-note whw-section">Kur të vazhdosh, sistemi i kontrollon zgjedhjet dhe e rifreskon shumën për dorëzim.</div> : null}
          </> : null}

          {step === 4 ? <><h2 className="whw-step-title" ref={headingRef} tabIndex={-1}>Numëro paratë në dorë</h2><p className="whw-lead">Numëro paratë që po ia jep dispatch-it dhe shkruaje shumën reale.</p><Line label="Pritet sipas llogarisë" value={money(current.totals.projectedCash)} emphasis data-handoff-projected="1" /><label className="whw-field">Sa para po dorëzon realisht? (€)<input className="whw-input whw-physical" data-handoff-physical-input="1" inputMode="decimal" autoComplete="off" placeholder="0,00" value={physical} onChange={event => { setPhysical(event.target.value); setConfirmed(false); setError(''); }} /><small>Shuma duhet të plotësohet nga numërimi yt.</small></label><div className={`${difference === 0 ? 'whw-note' : 'whw-warning'} whw-section`} data-handoff-difference="1" role="status">{handoffDifferenceText(difference)}</div>{difference != null && difference !== 0 ? <label className="whw-field">Pse ka dallim?<textarea className="whw-textarea" maxLength={1000} value={reason} onChange={event => { setReason(event.target.value); setConfirmed(false); setError(''); }} placeholder="Shpjego konkretisht shumën dhe arsyen e dallimit." /><small>Ky sqarim i shfaqet dispatch-it bashkë me shumat.</small></label> : null}<details className="whw-details"><summary>Shiko llogaritjen e plotë</summary><Breakdown preview={current} compact /></details>{current.expenses.length ? <details className="whw-details"><summary>Kontrollo kërkesat e shpenzimeve</summary><ExpenseCards rows={current.expenses} /></details> : null}</> : null}

          {step === 5 ? <><h2 className="whw-step-title" ref={headingRef} tabIndex={-1}>Kontrolli i fundit</h2><p className="whw-lead">Kjo llogaritje dhe deklarata jote ruhen bashkë me dorëzimin. Nëse ke provuar më parë, kontrollo dorëzimet e regjistruara para se të konfirmosh përsëri.</p><Line label="Paratë që po deklaron" value={money(parsedCash)} emphasis /><label className="whw-checkbox"><input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); setError(''); }} /><span>I kontrollova pagesat dhe zbritjet. I numërova paratë dhe po deklaroj <strong>{money(parsedCash)}</strong> për dispatch-in.</span></label><Breakdown preview={current} physical={parsedCash} reason={reason.trim()} /><details className="whw-details"><summary>Pagesat e përfshira ({current.payments.length})</summary><PaymentCards rows={current.payments} /></details>{current.expenses.length ? <details className="whw-details"><summary>Shpenzimet për verifikim ({current.expenses.length})</summary><ExpenseCards rows={current.expenses} /></details> : null}<div className="whw-note whw-section">Dispatch-i regjistron shumën që pranon fizikisht dhe verifikon shpenzimet. Çdo pjesë e mbetur ndiqet në këtë dorëzim.</div></> : null}
          {current.warnings?.length ? <div className="whw-stack whw-section">{current.warnings.map((warning,index) => <div className="whw-warning" key={index}>{warningText(warning)}</div>)}</div> : null}{!current.canSubmit && step >= 4 ? <div className="whw-warning whw-section">Kjo llogaritje kërkon korrigjim para dorëzimit. Kontrollo zgjedhjet e ushqimit dhe shpenzimet.</div> : null}
        </fieldset> : null}
      </div>
      {visible && error ? <div className="whw-error whw-action-error" role="alert">{error}{!pending && !saved && !loading ? <div><button type="button" className="whw-button whw-button-link" onClick={() => loadPreview(options, current ? 3 : 1)}>Rifresko llogaritjen</button></div> : null}</div> : null}
      {saved ? <footer className="whw-footer whw-footer-single"><button className="whw-button whw-button-primary" type="button" onClick={close}>MBYLLE</button></footer> : pending ? <footer className="whw-footer whw-footer-single"><button className="whw-button whw-button-primary" type="button" disabled={saving} onClick={() => save(true)}>{saving ? 'DUKE KONTROLLUAR…' : 'RIPROVO DORËZIMIN'}</button></footer> : showNext ? <footer className="whw-footer"><button className="whw-button" type="button" disabled={busy} onClick={() => { if (step === 1) close(); else { setError(''); setStep(step - 1); } }}>{step === 1 ? 'MBYLLE' : 'KTHEHU'}</button><button className="whw-button whw-button-primary" type="button" disabled={busy || (step === 5 && (!confirmed || !current.canSubmit || dirty))} onClick={step === 5 ? () => save(false) : next}>{saving ? 'DUKE DËRGUAR…' : loading ? 'DUKE KONTROLLUAR…' : step === 5 ? 'KONFIRMO DORËZIMIN' : 'VAZHDO'}</button></footer> : !loading ? <footer className="whw-footer whw-footer-single"><button className="whw-button" type="button" onClick={close}>MBYLLE</button></footer> : null}
    </section>
  </div>;
}
