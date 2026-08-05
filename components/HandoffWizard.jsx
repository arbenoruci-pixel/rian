'use client';

import { useMemo, useState } from 'react';

const money = (value) => `${(Number(value || 0) || 0).toFixed(2)} €`;

function backendMealChoice(choice) {
  if (choice === 'self') return '1';
  if (choice === 'other') return '2';
  if (choice === 'none') return '3';
  return '';
}

export default function HandoffWizard({
  open,
  actor,
  clientCount = 0,
  grossTotal = 0,
  bonusAvailable = 0,
  existingMealCovered = false,
  staffOptions = [],
  onClose,
  onSubmit,
}) {
  const [step, setStep] = useState(1);
  const [mealChoice, setMealChoice] = useState(existingMealCovered ? 'existing' : '');
  const [mealPayerPin, setMealPayerPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mealDeduct = mealChoice === 'self' ? 3 : 0;
  const afterMeal = Math.max(0, Number(grossTotal || 0) - mealDeduct);
  const bonusHeld = Math.min(Math.max(0, afterMeal - 0.01), Math.max(0, Number(bonusAvailable || 0)));
  const finalTotal = Math.max(0, afterMeal - bonusHeld);

  const otherWorkers = useMemo(() => (Array.isArray(staffOptions) ? staffOptions : [])
    .filter((row) => String(row?.pin || '').trim() && String(row?.pin || '').trim() !== String(actor?.pin || '').trim()), [staffOptions, actor?.pin]);

  if (!open) return null;

  const resetAndClose = () => {
    if (busy) return;
    setStep(1);
    setMealChoice(existingMealCovered ? 'existing' : '');
    setMealPayerPin('');
    setError('');
    onClose?.();
  };

  const nextFromMeal = () => {
    if (!mealChoice) return setError('Zgjedhe çka ka ndodh me ushqimin sot.');
    if (mealChoice === 'other' && !mealPayerPin) return setError('Zgjedhe punëtorin që ta ka pagu ushqimin.');
    setError('');
    setStep(3);
  };

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit?.({
        mealChoice: backendMealChoice(mealChoice),
        mealPayerPin: mealChoice === 'other' ? mealPayerPin : '',
      });
      setStep(4);
    } catch (e) {
      const message = String(e?.message || 'Dorëzimi nuk u krye. Provo përsëri.')
        .replace(/ZGJEDHJE E PAVLEFSHME PËR USHQIMIN\.\s*SHKRUAJ 1, 2 OSE 3\.?/gi, 'Zgjedhja e ushqimit nuk u ruajt. Kthehu një hap dhe zgjidhe përsëri.');
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,.82)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', padding: 'max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom))' }}>
      <div style={{ width: '100%', maxWidth: 720, maxHeight: '94dvh', overflowY: 'auto', borderRadius: 28, border: '1px solid #263b5f', background: '#07101f', boxShadow: '0 -18px 70px rgba(0,0,0,.65)', padding: 18, color: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ color: '#79aefc', fontWeight: 900, letterSpacing: 2, fontSize: 13 }}>DORËZIMI TE DISPATCH</div>
            <div style={{ fontSize: 28, fontWeight: 950, marginTop: 4 }}>Hapi {Math.min(step, 3)} nga 3</div>
          </div>
          {step !== 4 ? <button type="button" onClick={resetAndClose} disabled={busy} style={{ width: 48, height: 48, borderRadius: 16, border: '1px solid #31425f', background: '#111a29', color: '#fff', fontSize: 24 }}>×</button> : null}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 7, marginBottom: 18 }}>
          {[1,2,3].map((n) => <div key={n} style={{ height: 7, borderRadius: 999, background: step >= n ? '#22c58b' : '#1c2940' }} />)}
        </div>

        {step === 1 ? <>
          <div style={{ borderRadius: 22, padding: 18, background: 'linear-gradient(145deg,#102849,#0b1930)', border: '1px solid #29538a' }}>
            <div style={{ color: '#9eb6d8', fontWeight: 800 }}>PËRMBLEDHJA E DITËS</div>
            <div style={{ fontSize: 46, fontWeight: 950, marginTop: 8 }}>{money(grossTotal)}</div>
            <div style={{ color: '#b8c5d8', marginTop: 6 }}>{clientCount} klientë me pagesë për dorëzim</div>
          </div>
          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: 15, borderRadius: 17, background: '#101827' }}><span>Punëtori</span><strong>{actor?.name || actor?.pin}</strong></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: 15, borderRadius: 17, background: '#101827' }}><span>Bonus i hapur</span><strong style={{ color: '#ffd166' }}>{money(bonusAvailable)}</strong></div>
          </div>
          <button type="button" onClick={() => setStep(2)} style={{ width: '100%', marginTop: 18, minHeight: 62, border: 0, borderRadius: 19, background: '#246df2', color: '#fff', fontSize: 20, fontWeight: 950 }}>VAZHDO</button>
        </> : null}

        {step === 2 ? <>
          <div style={{ fontSize: 25, fontWeight: 950, marginBottom: 7 }}>A ke marrë ushqim sot?</div>
          <div style={{ color: '#9fb0c8', marginBottom: 16 }}>Zgjedhja përdoret për llogaritjen e shumës që dorëzon.</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {existingMealCovered ? <button type="button" onClick={() => setMealChoice('existing')} style={choiceStyle(mealChoice === 'existing')}><b>✓ Ushqimi është regjistruar</b><small>Sistemi përdor regjistrimin ekzistues</small></button> : null}
            <button type="button" onClick={() => setMealChoice('self')} style={choiceStyle(mealChoice === 'self')}><b>Po, e kam pagu vet</b><small>Zbriten 3.00 € prej dorëzimit</small></button>
            <button type="button" onClick={() => setMealChoice('other')} style={choiceStyle(mealChoice === 'other')}><b>Po, ma ka pagu dikush tjetër</b><small>Nuk zbritet prej dorëzimit tim</small></button>
            <button type="button" onClick={() => setMealChoice('none')} style={choiceStyle(mealChoice === 'none')}><b>Jo, nuk kam marrë ushqim</b><small>Pa zbritje për ushqim</small></button>
          </div>
          {mealChoice === 'other' ? <select value={mealPayerPin} onChange={(e) => setMealPayerPin(e.target.value)} style={{ width: '100%', marginTop: 12, minHeight: 58, borderRadius: 16, border: '1px solid #38527a', background: '#0d1727', color: '#fff', padding: '0 14px', fontSize: 17 }}>
            <option value="">Zgjedhe paguesin…</option>
            {otherWorkers.map((row) => <option key={row.pin} value={row.pin}>{row.name || row.pin} • PIN {row.pin}</option>)}
          </select> : null}
          {error ? <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: '#35131a', color: '#ffb2bb' }}>{error}</div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 10, marginTop: 18 }}>
            <button type="button" onClick={() => setStep(1)} style={backStyle}>KTHEHU</button>
            <button type="button" onClick={nextFromMeal} style={nextStyle}>VAZHDO</button>
          </div>
        </> : null}

        {step === 3 ? <>
          <div style={{ fontSize: 25, fontWeight: 950, marginBottom: 14 }}>Kontrollo shumën finale</div>
          <div style={{ borderRadius: 22, background: '#0d1727', border: '1px solid #273955', overflow: 'hidden' }}>
            <Row label="Cash nga klientët" value={money(grossTotal)} />
            <Row label="Ushqimi" value={mealDeduct ? `− ${money(mealDeduct)}` : '0.00 €'} accent={mealDeduct ? '#ffbd66' : undefined} />
            <Row label="Bonusi që e mban" value={bonusHeld ? `− ${money(bonusHeld)}` : '0.00 €'} accent="#ffd166" />
            <div style={{ padding: 18, background: '#063325' }}>
              <div style={{ color: '#8de6c4', fontWeight: 900 }}>DORËZO TE DISPATCH</div>
              <div style={{ fontSize: 48, fontWeight: 950, marginTop: 5 }}>{money(finalTotal)}</div>
            </div>
          </div>
          <div style={{ marginTop: 12, padding: 13, borderRadius: 14, background: '#111b2b', color: '#aebbd0' }}>Pas konfirmimit, dorëzimi ruhet në DB. Dispatch-i e sheh për pranim.</div>
          {error ? <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: '#35131a', color: '#ffb2bb' }}>{error}</div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.7fr', gap: 10, marginTop: 18 }}>
            <button type="button" disabled={busy} onClick={() => setStep(2)} style={backStyle}>KTHEHU</button>
            <button type="button" disabled={busy} onClick={finish} style={{ ...nextStyle, background: '#15bf83', color: '#03130d' }}>{busy ? 'DUKE DORËZUAR…' : `DORËZO ${money(finalTotal)}`}</button>
          </div>
        </> : null}

        {step === 4 ? <div style={{ textAlign: 'center', padding: '24px 8px 8px' }}>
          <div style={{ width: 82, height: 82, borderRadius: 999, background: '#0c4d38', display: 'grid', placeItems: 'center', margin: '0 auto', fontSize: 42 }}>✓</div>
          <div style={{ fontSize: 30, fontWeight: 950, marginTop: 17 }}>Dorëzimi u regjistrua</div>
          <div style={{ color: '#aebbd0', marginTop: 8 }}>Mundesh me vazhdu punën. Dispatch-i e ka dorëzimin për pranim.</div>
          <button type="button" onClick={resetAndClose} style={{ ...nextStyle, width: '100%', marginTop: 22 }}>MBYLLE</button>
        </div> : null}
      </div>
    </div>
  );
}

function Row({ label, value, accent }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 15, padding: 16, borderBottom: '1px solid #23324a' }}><span style={{ color: '#acb9cd' }}>{label}</span><strong style={{ color: accent || '#fff' }}>{value}</strong></div>;
}

function choiceStyle(active) {
  return { width: '100%', textAlign: 'left', display: 'grid', gap: 4, padding: 16, borderRadius: 17, border: active ? '2px solid #28c98f' : '1px solid #2a3b58', background: active ? '#0b3529' : '#101827', color: '#fff', fontSize: 17 };
}
const backStyle = { minHeight: 58, borderRadius: 17, border: '1px solid #354765', background: '#121c2c', color: '#fff', fontWeight: 900, fontSize: 17 };
const nextStyle = { minHeight: 58, borderRadius: 17, border: 0, background: '#246df2', color: '#fff', fontWeight: 950, fontSize: 18 };
