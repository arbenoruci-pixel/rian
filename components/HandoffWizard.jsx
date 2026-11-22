'use client';

import { useMemo, useRef, useState } from 'react';
import { buildHandoffCashSummary, readConfirmedHandoffReceipt } from '@/lib/handoffCashSummary';

const money = (value) => `${(Number(value || 0) || 0).toFixed(2)} €`;

export default function HandoffWizard({
  open,
  actor,
  clientCount = 0,
  grossTotal = 0,
  baseTotal,
  commissionTotal = 0,
  hybridEnabled,
  bonusAvailable = 0,
  openExpenseTotal = 0,
  existingMealCovered = false,
  existingMealDeduct = 0,
  unsettledMealDeduct,
  staffOptions = [],
  onClose,
  onSubmit,
}) {
  const [step, setStep] = useState(1);
  const [mealChoice, setMealChoice] = useState(existingMealCovered ? 'existing' : '');
  const [mealPayerPin, setMealPayerPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const submitFlight = useRef(false);

  const workerHybrid = typeof hybridEnabled === 'boolean' ? hybridEnabled : actor?.is_hybrid_transport === true || String(actor?.is_hybrid_transport || '').toLowerCase() === 'true';
  // BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:WIZARD
  const carriedMealDeduct = unsettledMealDeduct == null ? null : Math.max(0, Number(unsettledMealDeduct) || 0);
  const legacyMealDeduct = mealChoice === 'self'
    ? 3
    : (mealChoice === 'existing' ? Math.max(0, Number(existingMealDeduct || 0)) : 0);
  const requestedMealDeduct = carriedMealDeduct == null
    ? legacyMealDeduct
    : carriedMealDeduct + (mealChoice === 'self' ? 3 : 0);
  const summary = buildHandoffCashSummary({ grossTotal, baseTotal, commissionTotal, workerHybrid, mealDeduct:requestedMealDeduct, bonusAvailable });
  const safeGross = summary.gross;
  const safeCommission = workerHybrid ? summary.commission : 0;
  const safeBase = summary.baseBeforeDeductions;
  const mealDeduct = summary.mealDeduct;
  const bonusHeld = summary.bonusHeld;
  const finalTotal = summary.netToDispatch;

  const otherWorkers = useMemo(() => (Array.isArray(staffOptions) ? staffOptions : [])
    .filter((row) => String(row?.pin || '').trim() && String(row?.pin || '').trim() !== String(actor?.pin || '').trim()), [staffOptions, actor?.pin]);

  if (!open) return null;

  const resetAndClose = () => {
    if (busy) return;
    setStep(1);
    setMealChoice(existingMealCovered ? 'existing' : '');
    setMealPayerPin('');
    setError('');
    setReceipt(null);
    onClose?.();
  };

  const nextFromMeal = () => {
    if (!mealChoice) return setError('Zgjedhe çka ka ndodh me ushqimin sot.');
    if (mealChoice === 'other' && !mealPayerPin) return setError('Zgjedhe punëtorin që ta ka pagu ushqimin.');
    setError('');
    setStep(3);
  };

  const finish = async () => {
    if (busy || submitFlight.current) return;
    if (!summary.canSubmit) return setError('Nuk mbetet cash për Dispatch pas ushqimit. Kontrollo cash-in dhe regjistrimet e ushqimit.');
    submitFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const submitted = await onSubmit?.({
        mealChoice: mealChoice === 'existing' ? '' : ({ self: '1', other: '2', none: '3' }[mealChoice] || ''),
        mealPayerPin: mealChoice === 'other' ? mealPayerPin : '',
      });
      // The returned handoff is already net of its bonus. Display it directly.
      setReceipt(readConfirmedHandoffReceipt(submitted));
      setStep(4);
    } catch (e) {
      setError(e?.message || 'Dorëzimi nuk u krye. Provo përsëri.');
    } finally {
      submitFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,.86)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 'max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom))' }}>
      <div style={{ width: '100%', maxWidth: 720, maxHeight: '95dvh', overflowY: 'auto', borderRadius: 28, border: '1px solid #263b5f', background: '#07101f', boxShadow: '0 -18px 70px rgba(0,0,0,.65)', padding: 18, color: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ color: '#79aefc', fontWeight: 900, letterSpacing: 2, fontSize: 13 }}>DORËZIMI TE DISPATCH</div>
            <div style={{ fontSize: 28, fontWeight: 950, marginTop: 4 }}>{step === 4 ? 'U KRY' : `Hapi ${step} nga 3`}</div>
          </div>
          {step !== 4 ? <button type="button" onClick={resetAndClose} disabled={busy} style={{ width: 48, height: 48, borderRadius: 16, border: '1px solid #31425f', background: '#111a29', color: '#fff', fontSize: 24 }}>×</button> : null}
        </div>

        {step !== 4 ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 7, marginBottom: 18 }}>
          {[1, 2, 3].map((item) => <div key={item} style={{ height: 7, borderRadius: 999, background: step >= item ? '#22c58b' : '#1c2940' }} />)}
        </div> : null}

        {step === 1 ? <>
          <div style={{ borderRadius: 22, padding: 18, background: 'linear-gradient(145deg,#102849,#0b1930)', border: '1px solid #29538a' }}>
            <div style={{ color: '#9eb6d8', fontWeight: 800 }}>CASH NGA KLIENTËT</div>
            <div style={{ fontSize: 46, fontWeight: 950, marginTop: 8 }}>{money(safeGross)}</div>
            <div style={{ color: '#b8c5d8', marginTop: 6 }}>{clientCount} klientë në këtë dorëzim</div>
          </div>
          <div style={{ display: 'grid', gap: 9, marginTop: 14 }}>
            <SummaryLine label="Punëtori" value={actor?.name || actor?.pin || '—'} />
            {workerHybrid ? <SummaryLine label="Komision transporti që e mban" value={money(safeCommission)} accent="#ffd166" /> : null}
            <SummaryLine label="Cash për bazë para ushqimit/bonusit" value={money(safeBase)} accent="#83d9ff" />
            {carriedMealDeduct > 0 ? <SummaryLine label="Ushqim i mbetur për zbritje" value={money(carriedMealDeduct)} accent="#ffbd66" sub="Përfshin edhe regjistrimet e mëparshme." /> : null}
            <SummaryLine label="Bonus për ta mbajtur nga ky cash" value={money(bonusHeld)} accent="#ffd166" sub="Bazë + kontroll Transporti" />
            <SummaryLine label="Për Dispatch pas bonusit" value={money(finalTotal)} accent="#8de6c4" sub={existingMealCovered ? 'Përfshin ushqimin e regjistruar për këtë dorëzim.' : carriedMealDeduct > 0 ? 'Përfshin ushqimin e mbetur. Zgjedhja për sot bëhet në hapin tjetër.' : 'Ushqimi llogaritet në hapin tjetër.'} />
            <SummaryLine label="Shpenzime në pritje" value={money(openExpenseTotal)} accent="#ffbd66" sub="Nuk zbriten pa aprovim" />
          </div>
          <button type="button" onClick={() => setStep(2)} style={{ width: '100%', marginTop: 18, minHeight: 62, border: 0, borderRadius: 19, background: '#246df2', color: '#fff', fontSize: 20, fontWeight: 950 }}>VAZHDO</button>
        </> : null}

        {step === 2 ? <>
          <div style={{ fontSize: 25, fontWeight: 950, marginBottom: 7 }}>A ke marrë ushqim sot?</div>
          <div style={{ color: '#9fb0c8', marginBottom: 16 }}>Kjo zgjedhje përdoret direkt. Nuk ka pyetje tjetër jashtë wizard-it.</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {existingMealCovered ? <button type="button" onClick={() => { setMealChoice('existing'); setError(''); }} style={choiceStyle(mealChoice === 'existing')}><b>✓ Ushqimi është regjistruar</b><small>{mealDeduct > 0 ? `Zbriten ${money(mealDeduct)} sipas regjistrimit` : 'Pa zbritje nga dorëzimi yt'}</small></button> : null}
            {!existingMealCovered ? <>
              <button type="button" onClick={() => { setMealChoice('self'); setError(''); }} style={choiceStyle(mealChoice === 'self')}><b>Po, e kam pagu vet</b><small>{carriedMealDeduct > 0 ? 'Shtohen 3.00 € për sot mbi ushqimin e mbetur.' : 'Zbriten 3.00 € prej dorëzimit'}</small></button>
              <button type="button" onClick={() => { setMealChoice('other'); setError(''); }} style={choiceStyle(mealChoice === 'other')}><b>Po, ma ka pagu dikush tjetër</b><small>{carriedMealDeduct > 0 ? 'Pa zbritje të re për sot. Ushqimi i mbetur zbritet.' : 'Nuk zbritet prej dorëzimit tim'}</small></button>
              <button type="button" onClick={() => { setMealChoice('none'); setError(''); }} style={choiceStyle(mealChoice === 'none')}><b>Jo, nuk kam marrë ushqim</b><small>{carriedMealDeduct > 0 ? 'Pa zbritje të re për sot. Ushqimi i mbetur zbritet.' : 'Pa zbritje për ushqim'}</small></button>
            </> : null}
          </div>
          {mealChoice === 'other' ? <select value={mealPayerPin} onChange={(e) => { setMealPayerPin(e.target.value); setError(''); }} style={{ width: '100%', marginTop: 12, minHeight: 58, borderRadius: 16, border: '1px solid #38527a', background: '#0d1727', color: '#fff', padding: '0 14px', fontSize: 17 }}>
            <option value="">Zgjedhe paguesin…</option>
            {otherWorkers.map((row) => <option key={row.pin} value={row.pin}>{row.name || row.pin} • PIN {row.pin}</option>)}
          </select> : null}
          {error ? <ErrorBox text={error} /> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 10, marginTop: 18 }}>
            <button type="button" onClick={() => setStep(1)} style={backStyle}>KTHEHU</button>
            <button type="button" onClick={nextFromMeal} style={nextStyle}>VAZHDO</button>
          </div>
        </> : null}

        {step === 3 ? <>
          <div style={{ fontSize: 25, fontWeight: 950, marginBottom: 14 }}>Kontrollo shumën finale</div>
          <div data-handoff-final-summary="1" style={{ borderRadius: 22, background: '#0d1727', border: '1px solid #273955', overflow: 'hidden' }}>
            <Row label="Klientët kanë paguar" value={money(safeGross)} />
            {workerHybrid ? <Row label="Komisioni që e mban" value={safeCommission > 0 ? `− ${money(safeCommission)}` : '0.00 €'} accent="#ffd166" /> : null}
            <Row label="Për bazë para zbritjeve" value={money(safeBase)} accent="#83d9ff" />
            <Row label="Ushqimi" value={mealDeduct > 0 ? `− ${money(mealDeduct)}` : '0.00 €'} accent={mealDeduct > 0 ? '#ffbd66' : undefined} sub={carriedMealDeduct > 0 ? `Përfshin ${money(carriedMealDeduct)} të mbetura nga regjistrimet e ushqimit.` : ''} />
            <Row label="Bonusi që e mban për vete" value={bonusHeld > 0 ? `− ${money(bonusHeld)}` : '0.00 €'} accent="#ffd166" sub="Bazë + kontroll Transporti" />
            {Number(openExpenseTotal || 0) > 0 ? <Row label="Shpenzime në pritje" value={money(openExpenseTotal)} accent="#ffbd66" sub="Nuk janë zbritur" /> : null}
            <div style={{ padding: 18, background: '#063325' }}>
              <div style={{ color: '#8de6c4', fontWeight: 900 }}>JEP DISPATCH-IT · CASH NETO</div>
              <div data-handoff-net="1" style={{ fontSize: 48, fontWeight: 950, marginTop: 5 }}>{money(finalTotal)}</div>
              <div style={{ color:'#b3e7d4', marginTop:8, lineHeight:1.4 }}>Kjo shumë e përfshin zbritjen e bonusit dhe të ushqimit.</div>
            </div>
          </div>
          {!summary.canSubmit ? <ErrorBox text="Nuk mbetet cash për Dispatch pas ushqimit. Kontrollo cash-in dhe regjistrimet e ushqimit." /> : null}
          {bonusHeld > 0 ? <div data-handoff-bonus-held="1" style={{ marginTop:12, padding:14, borderRadius:14, background:'#332a12', color:'#ffe7a3' }}>Mbaj për bonus <strong>{money(bonusHeld)}</strong>. Dispatch-it jepja <strong>{money(finalTotal)}</strong>.</div> : null}
          {summary.bonusRemaining > 0 ? <div style={{ marginTop:9, color:'#b4bfd2', fontSize:14 }}>Edhe {money(summary.bonusRemaining)} bonus mbeten në dispozicion për dorëzimin tjetër.</div> : null}
          <div style={{ marginTop: 12, padding: 13, borderRadius: 14, background: '#111b2b', color: '#aebbd0' }}>Kur e prek butonin, dorëzimi regjistrohet direkt. Nuk hapet asnjë confirm ose prompt tjetër.</div>
          {error ? <ErrorBox text={error} /> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.7fr', gap: 10, marginTop: 18 }}>
            <button type="button" disabled={busy} onClick={() => setStep(2)} style={backStyle}>KTHEHU</button>
            <button type="button" disabled={busy || !summary.canSubmit} onClick={finish} style={{ ...nextStyle, background: '#15bf83', color: '#03130d', opacity:!summary.canSubmit ? 0.5 : 1 }}>{busy ? 'DUKE DORËZUAR…' : `DORËZO ${money(finalTotal)}`}</button>
          </div>
        </> : null}

        {step === 4 ? <div style={{ textAlign: 'center', padding: '24px 8px 8px' }}>
          <div style={{ width: 82, height: 82, borderRadius: 999, background: '#0c4d38', display: 'grid', placeItems: 'center', margin: '0 auto', fontSize: 42 }}>✓</div>
          <div style={{ fontSize: 30, fontWeight: 950, marginTop: 17 }}>Dorëzimi u regjistrua</div>
          {receipt ? <div data-handoff-confirmed-receipt="1" style={{ display:'grid', gap:10, marginTop:18, textAlign:'left' }}>
            <SummaryLine label="Bonus i mbajtur në këtë dorëzim" value={money(receipt.bonusHeld)} accent="#ffd166" sub="Bazë + kontroll Transporti" />
            <SummaryLine label="Cash neto për Dispatch" value={money(receipt.netToDispatch)} accent="#8de6c4" sub={receipt.handoffId ? `Dorëzimi #${receipt.handoffId}` : 'Sipas dorëzimit të regjistruar.'} />
          </div> : null}
          <div style={{ color: '#aebbd0', marginTop: 8 }}>Dispatch-i e ka dorëzimin për pranim. Mundesh me vazhdu punën.</div>
          <button type="button" onClick={resetAndClose} style={{ ...nextStyle, width: '100%', marginTop: 22 }}>MBYLLE</button>
        </div> : null}
      </div>
    </div>
  );
}

function SummaryLine({ label, value, accent, sub }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, padding: 14, borderRadius: 16, background: '#101827' }}><span><span>{label}</span>{sub ? <small style={{ display: 'block', color: '#8796ad', marginTop: 3 }}>{sub}</small> : null}</span><strong style={{ color: accent || '#fff', textAlign: 'right' }}>{value}</strong></div>;
}

function Row({ label, value, accent, sub }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 15, padding: 16, borderBottom: '1px solid #23324a' }}><span style={{ color: '#acb9cd' }}>{label}{sub ? <small style={{ display: 'block', color: '#72839d', marginTop: 3 }}>{sub}</small> : null}</span><strong style={{ color: accent || '#fff', textAlign: 'right' }}>{value}</strong></div>;
}

function ErrorBox({ text }) {
  return <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: '#35131a', color: '#ffb2bb' }}>{text}</div>;
}

function choiceStyle(active) {
  return { width: '100%', textAlign: 'left', display: 'grid', gap: 4, padding: 16, borderRadius: 17, border: active ? '2px solid #28c98f' : '1px solid #2a3b58', background: active ? '#0b3529' : '#101827', color: '#fff', fontSize: 17 };
}
const backStyle = { minHeight: 58, borderRadius: 17, border: '1px solid #354765', background: '#121c2c', color: '#fff', fontWeight: 900, fontSize: 17 };
const nextStyle = { minHeight: 58, borderRadius: 17, border: 0, background: '#246df2', color: '#fff', fontWeight: 950, fontSize: 18 };
