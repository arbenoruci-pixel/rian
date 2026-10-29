import React, { useEffect, useRef, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { BONUS_SHELVES, isBujar, canReviewBonusEvidence, evidenceStatusLabel } from '@/lib/baseBonusEvidence';
import { bonusEvidenceRequest, compressBonusEvidenceImage, submitBonusEvidence } from '@/lib/baseBonusEvidenceClient';
import './BaseBonusEvidencePanel.css';

const stamp = value => value ? new Date(value).toLocaleString('sq-AL', { timeZone: 'Europe/Belgrade', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const shelfLabel = value => value.replace('FURRA_POSHT_', 'Furra poshtë · ').replace('FURRA_NALT_', 'Furra nalt · ');

function PhotoInput({ label, file, setFile, camera = false, disabled = false }) {
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!file) { setPreview(''); return; } const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  return <div className="bbePhotoInput">
    <label>{label}<input aria-label={label} type="file" accept="image/*" {...(camera ? { capture: 'environment' } : {})} disabled={disabled || busy} onChange={async event => {
      const next = event.target.files?.[0]; if (!next) return; setError(''); setBusy(true);
      try { setFile(await compressBonusEvidenceImage(next)); } catch (e) { setError(e.message); } finally { setBusy(false); event.target.value = ''; }
    }} /></label>
    {busy ? <p role="status">Duke përgatitur foton…</p> : null}
    {preview ? <img src={preview} alt={label} /> : null}
    {error ? <p className="bbeError" role="alert">{error}</p> : null}
  </div>;
}

export function BonusEvidenceWizard({ order, onClose, onSubmitted }) {
  const [step, setStep] = useState(0), [shelf, setShelf] = useState(''), [room, setRoom] = useState('BAZA');
  const [carpet, setCarpet] = useState(null), [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [error, setError] = useState('');
  const [saved, setSaved] = useState({}), [resuming, setResuming] = useState(!!order.draft);
  const [alreadyEarned, setAlreadyEarned] = useState(false);
  const firstRef = useRef(null);
  useEffect(() => {
    if (!order.draft) return;
    let active = true;
    setShelf(order.draft.shelf);
    bonusEvidenceRequest({ action: 'VIEW', requestId: order.draft.id }).then(async result => {
      for (const item of result.images) {
        const response = await fetch(item.url, { cache: 'no-store' });
        if (!response.ok) throw new Error('Provat e ruajtura nuk u hapën. Mbylle dhe provo përsëri.');
        const blob = await response.blob();
        if (active) { (item.kind === 'carpet' ? setCarpet : setMessage)(blob); setSaved(v => ({ ...v, [item.kind]: true })); }
      }
      if (active) setResuming(false);
    }).catch(e => active && setError(e.message));
    return () => { active = false; };
  }, [order.draft?.id]);
  useEffect(() => { firstRef.current?.focus(); const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = previous; }; }, []);
  const spots = BONUS_SHELVES.filter(s => room === 'BAZA' ? !s.startsWith('FURRA') : s.startsWith(room));
  const valid = step === 0 ? !!shelf : step === 1 ? !!carpet : step === 2 ? !!message : !!shelf && !!carpet && !!message;
  return <div className="bbeOverlay"><section className="bbeDialog" role="dialog" aria-modal="true" aria-labelledby="bbeTitle" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(); }}>
    <header><div><small>POROSIA #{order.code}</small><h2 id="bbeTitle">Fito edhe 24 orë</h2></div><button ref={firstRef} type="button" aria-label="Mbylle kërkesën" disabled={busy} onClick={onClose}>×</button></header>
    <p>Hapi {step + 1} nga 4 · Dorëzo para <b>{stamp(order.deadline)}</b></p>
    <div className="bbeSteps" aria-label={`Hapi ${step + 1} nga 4`}>{['Rafti', 'Tepihat', 'Mesazhi', 'Dorëzo'].map((name, i) => <span key={name} className={i <= step ? 'active' : ''}>{i + 1}. {name}</span>)}</div>
    {step === 0 ? <><h3>Ku janë tepihat gati?</h3>{order.shelf ? <p>Rafti i regjistruar: {order.shelf}</p> : null}<div className="bbeRooms">{[['BAZA', 'Baza'], ['FURRA_POSHT', 'Furra poshtë'], ['FURRA_NALT', 'Furra nalt']].map(([key, label]) => <button type="button" key={key} aria-pressed={room === key} onClick={() => setRoom(key)}>{label}</button>)}</div><div className="bbeShelves">{spots.map(s => <button key={s} type="button" aria-pressed={shelf === s} onClick={() => setShelf(s)}>{s.split('_').at(-1)}</button>)}</div>{shelf ? <p className="bbeSelected">Rafti: {shelfLabel(shelf)}</p> : null}</> : null}
    {step === 1 ? <><h3>Fotografo tepihat në raft</h3><p>Duhet të shihen tepihat e kësaj porosie dhe kodi <b>#{order.code}</b>. Kontrollo që numri lexohet.</p>{saved.carpet ? <p>Fotoja është ruajtur nga tentativa e kaluar.</p> : null}<PhotoInput label="Bëj foto të tepihave" file={carpet} setFile={setCarpet} camera disabled={saved.carpet} /></> : null}
    {step === 2 ? <><h3>Dëshmo njoftimin e klientit</h3><p>Ngarko screenshot-in ku shihet marrësi, mesazhi që tepihat janë gati dhe data/ora e dërgimit.</p>{saved.message ? <p>Screenshot-i është ruajtur nga tentativa e kaluar.</p> : null}<PhotoInput label="Ngarko screenshot-in e mesazhit" file={message} setFile={setMessage} disabled={saved.message} /></> : null}
    {step === 3 ? <><h3>Kontrollo dhe dorëzo</h3><p><b>#{order.code} · {order.client_name}</b><br />Rafti: <b>{shelfLabel(shelf)}</b></p><p>Fotoja e tepihave ✓<br />Screenshot-i i mesazhit ✓</p><p>Dispeçeri i kontrollon provat. Pas aprovimit, afati bëhet <b>96 orë prej pranimit</b>. Deri atëherë kërkesa është në pritje.</p></> : null}
    {error ? <p className="bbeError" role="alert">{error}</p> : null}{busy ? <p role="status">{progress}</p> : null}
    {resuming ? <p role="status">Duke hapur provat e ruajtura…</p> : null}
    <footer>{alreadyEarned ? <button type="button" className="bbePrimary" onClick={onClose}>Mbyll dhe rifresko</button> : <>{step > 0 ? <button type="button" disabled={busy} onClick={() => setStep(step - 1)}>Prapa</button> : null}<button className="bbePrimary" type="button" disabled={!valid || busy || resuming} onClick={async () => {
      if (step < 3) { setStep(step + 1); return; }
      setBusy(true); setError('');
      try { const result = await submitBonusEvidence({ orderId: order.id, shelf, carpet, message, onProgress: setProgress, onUploaded: kind => setSaved(v => ({ ...v, [kind]: true })) }); onSubmitted(result); }
      catch (e) { setError(e.message); if (e.code === 'BONUS_EVIDENCE_ALREADY_EARNED') setAlreadyEarned(true); } finally { setBusy(false); }
    }}>{busy ? 'Duke dërguar…' : step === 3 ? 'Submit · Dërgo për aprovim' : 'Vazhdo'}</button></>}</footer>
  </section></div>;
}

export function BonusEvidenceReview({ request, onClose, onReviewed }) {
  const [images, setImages] = useState([]), [loaded, setLoaded] = useState({}), [error, setError] = useState('');
  const [carpet, setCarpet] = useState(false), [message, setMessage] = useState(false), [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; bonusEvidenceRequest({ action: 'VIEW', requestId: request.id }).then(r => { if (active) { setImages(r.images); if (r.deleted) setError('Provat janë fshirë pas marrjes së tepihave.'); } }).catch(e => active && setError(e.message)); return () => { active = false; }; }, [request.id]);
  async function review(decision) {
    setBusy(true); setError('');
    try { await bonusEvidenceRequest({ action: 'REVIEW', requestId: request.id, decision, checkedCarpet: carpet, checkedMessage: message, note }); onReviewed(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="bbeOverlay"><section className="bbeDialog" role="dialog" aria-modal="true" aria-labelledby="bbeReviewTitle"><header><div><small>BUJAR · VETËM BAZA</small><h2 id="bbeReviewTitle">Kontrollo provat · #{request.order?.code}</h2></div><button type="button" aria-label="Mbyll kontrollin" disabled={busy} onClick={onClose}>×</button></header>
    <p>{request.order?.client_name} · Rafti <b>{shelfLabel(request.shelf)}</b><br />Dorëzuar: {stamp(request.submitted_at)}<br />Afati pas aprovimit: <b>{stamp(request.extended_deadline)}</b></p>
    {request.collected_at ? <p>Tepihat janë marrë. Provat fshihen pas këtij kontrolli.</p> : null}
    {images.map(image => <figure key={image.kind}><figcaption>{image.kind === 'carpet' ? 'Tepihat fizikisht dhe kodi' : 'Mesazhi i dërguar klientit'}</figcaption><a href={image.url} target="_blank" rel="noreferrer">Hape foton të plotë</a><img src={image.url} alt={image.kind === 'carpet' ? 'Foto e tepihave me kodin' : 'Screenshot i njoftimit'} onLoad={() => setLoaded(v => ({ ...v, [image.kind]: true }))} onError={() => setError('Fotoja nuk u ngarkua. Hape përsëri kontrollin.')} /></figure>)}
    <label className="bbeCheck"><input type="checkbox" checked={carpet} disabled={!loaded.carpet || busy} onChange={e => setCarpet(e.target.checked)} />Tepihat dhe kodi përputhen me porosinë dhe raftin.</label>
    <label className="bbeCheck"><input type="checkbox" checked={message} disabled={!loaded.message || busy} onChange={e => setMessage(e.target.checked)} />Klienti është njoftuar para afatit; marrësi dhe data përputhen.</label>
    <label>Shënim / arsye e refuzimit<textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)} disabled={busy} /></label>
    {error ? <p className="bbeError" role="alert">{error}</p> : null}<footer><button type="button" disabled={busy || !note.trim()} onClick={() => review('REJECTED')}>Refuzo</button><button type="button" className="bbePrimary" disabled={busy || !carpet || !message || !loaded.carpet || !loaded.message} onClick={() => review('APPROVED')}>{busy ? 'Duke ruajtur…' : 'Aprovo +24 orë'}</button></footer>
  </section></div>;
}

export default function BaseBonusEvidencePanel({ actor: suppliedActor }) {
  const actor = suppliedActor || getActor(); const allowed = isBujar(actor) || canReviewBonusEvidence(actor);
  const [data, setData] = useState(null), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const [wizard, setWizard] = useState(null), [review, setReview] = useState(null), [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  async function load() {
    if (!allowed || inFlight.current) return; inFlight.current = true; setLoading(true);
    try { setData(await bonusEvidenceRequest({ action: 'LIST' })); setError(''); } catch (e) { setError(e.message); } finally { setLoading(false); inFlight.current = false; }
  }
  useEffect(() => { if (!allowed) return; void load(); const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30000); const refresh = () => void load(); window.addEventListener('focus', refresh); window.addEventListener('base-ready-bonus:refresh', refresh); return () => { clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('base-ready-bonus:refresh', refresh); }; }, [actor?.id, allowed]);
  if (!allowed) return null;
  const requests = data?.requests || [], manager = !!data?.manager;
  const pending = requests.filter(r => r.status === 'PENDING');
  const activeRequests = manager ? [...pending, ...requests.filter(r => r.status !== 'PENDING' && r.status !== 'DRAFT').slice(0, 12)] : requests.filter(r => r.status !== 'DRAFT').slice(0, 30);
  const candidates = (data?.candidates || []).filter(o => !requests.some(r => r.order_id === o.id && r.status !== 'DRAFT')).map(o => ({ ...o, draft: requests.find(r => r.order_id === o.id && r.status === 'DRAFT') }));
  return <section className="bbePanel" data-bonus-evidence-panel="1"><div className="bbePanelHeading"><div><h2>{manager ? `Provat e Bujarit · ${pending.length} në pritje` : 'Fito edhe 24 orë me prova'}</h2><p>72 orë + 24 orë me aprovim · 0,10 €/m² · vetëm baza</p></div><button type="button" onClick={load} disabled={loading}>Rifresko</button></div>
    {error ? <p className="bbeError" role="alert">{error}</p> : null}{success ? <p className="bbeSuccess" role="status">{success}</p> : null}
    {!manager ? candidates.map(o => <div className="bbeRow" key={o.id}><div><b>#{o.code} · {o.client_name}</b><small>GATI · Dorëzo deri {stamp(o.deadline)}</small></div><button className="bbePrimary" type="button" onClick={() => { setSuccess(''); setWizard(o); }}>Fito +24 orë</button></div>) : null}
    {!manager && !candidates.length && data ? <p>S’ka porosi GATI brenda 72 orëve për kërkesë të re.</p> : null}
    {!manager ? (data?.earnedOrders || []).map(o => <div className="bbeRow" key={`earned-${o.id}`}><div><b>#{o.code} · {o.client_name}</b><small>Bonusi është fituar · {Number(o.amount).toFixed(2).replace('.', ',')} €</small><small>Nuk nevojitet zgjatje +24 orë.</small></div></div>) : null}
    {activeRequests.map(r => <div className="bbeRow" key={r.id}><div><b>#{r.order?.code || r.order_id} · {r.order?.client_name}</b><small>{evidenceStatusLabel(r.status)}{r.status === 'APPROVED' ? ` · deri ${stamp(r.extended_deadline)}` : ''}</small>{r.review_note ? <small>{r.review_note}</small> : null}{r.files_deleted_at ? <small>Fotot u fshinë pas përfundimit të kontrollit/marrjes.</small> : null}</div>{manager && r.status === 'PENDING' ? <button type="button" className="bbePrimary" onClick={() => setReview(r)}>Kontrollo provat</button> : null}</div>)}
    {wizard ? <BonusEvidenceWizard order={wizard} onClose={() => { setWizard(null); void load(); }} onSubmitted={() => { setWizard(null); setSuccess('Provat u dorëzuan. Kërkesa pret aprovimin e dispeçerit.'); void load(); }} /> : null}
    {review ? <BonusEvidenceReview request={review} onClose={() => setReview(null)} onReviewed={() => { setReview(null); setSuccess('Vendimi u ruajt.'); window.dispatchEvent(new CustomEvent('base-ready-bonus:refresh')); void load(); }} /> : null}
  </section>;
}
