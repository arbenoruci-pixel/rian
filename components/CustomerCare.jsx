'use client';
import { useEffect, useRef, useState } from 'react';
import { approvedApiRequest } from '@/lib/approvedApiRequest';

const issues = { PAYMENT: 'Problem me pagesën', NO_SHOW: 'Nuk ishte në adresë', ACCESS: 'Problem me qasjen/adresën', OTHER: 'Tjetër' };
const field = { width: '100%', boxSizing: 'border-box', minHeight: 42, padding: 10, border: '1px solid #475569', borderRadius: 10, background: '#0f172a', color: '#f8fafc', fontSize: 16 };
const button = { ...field, width: 'auto', cursor: 'pointer', fontWeight: 800 };

export default function CustomerCare({ clientId = '', orderId = '', onSaved, compact = false }) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState('');
  const [rating, setRating] = useState('');
  const [note, setNote] = useState('');
  const [issue, setIssue] = useState('');
  const [flag, setFlag] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [revision, setRevision] = useState(0);
  const intent = useRef(null);
  const saving = useRef(false);
  useEffect(() => {
    let alive = true;
    setRecord(null);
    setError('');
    approvedApiRequest('/api/client-profile', { action: 'GET_CUSTOMER_CARE', clientId, orderId })
      .then((value) => { if (alive) setRecord(value); })
      .catch(() => { if (alive) setError('SHËNIMET NUK U NGARKUAN. PROVO PËRSËRI.'); });
    return () => { alive = false; };
  }, [clientId, orderId, revision]);

  async function save() {
    if (saving.current) return;
    if (!rating && !note.trim() && !issue && !flag) { setError('ZGJIDH VLERËSIM OSE SHKRUAJ NJË SHËNIM.'); return; }
    if (flag === 'yes' && !note.trim()) { setError('SHKRUAJ ARSYEN PSE NUK DUHET MARRË PËRSËRI.'); return; }
    // Keep the exact payload and ID after ambiguous failures; retry cannot duplicate feedback.
    intent.current ||= { action: 'ADD_CUSTOMER_FEEDBACK', id: crypto.randomUUID(), clientId, orderId,
      rating: rating ? Number(rating) : null, note, issue: issue || null,
      noPickup: flag ? flag === 'yes' : null };
    saving.current = true;
    setBusy(true); setError(''); setSaved(false);
    try {
      await approvedApiRequest('/api/client-profile', intent.current);
      intent.current = null;
      setRating(''); setNote(''); setIssue(''); setFlag(''); setSaved(true);
      setRevision((n) => n + 1);
      onSaved?.();
    } catch {
      setError('SHËNIMI NUK U KONFIRMUA. “PROVO RUAJTJEN PËRSËRI” E DËRGON TË NJËJTIN SHËNIM.');
    } finally { saving.current = false; setBusy(false); }
  }

  return (
    <section style={{ background: '#111c30', border: '1px solid #475569', borderRadius: 14, padding: 14, color: '#f8fafc', marginTop: 12 }} aria-label="Shënimet e brendshme të klientit">
      <strong>SHËNIME TË BRENDSHME TË KLIENTIT</strong>
      <p style={{ fontSize: 12, color: '#cbd5e1' }}>Ruhen te klienti për vizitat e ardhshme. Nuk i dërgohen klientit.</p>
      {record?.flag?.no_pickup ? <div role="alert" style={{ padding: 12, border: '2px solid #f87171', borderRadius: 10, marginBottom: 10 }}><strong>MOS E MERR PËRSËRI</strong><div style={{ whiteSpace: 'pre-wrap' }}>{record.flag.note}</div><small>{record.flag.author_name}</small></div> : null}
      {record?.legacyNotes ? <p style={{ whiteSpace: 'pre-wrap' }}>{record.legacyNotes}</p> : null}
      {record?.entries?.find((entry) => entry.rating) ? <p>VLERËSIMI I FUNDIT: <strong>{record.entries.find((entry) => entry.rating).rating}/5</strong></p> : null}
      {error ? <p role="alert" style={{ color: '#fecaca' }}>{error} <button type="button" style={button} disabled={busy} onClick={() => setRevision((n) => n + 1)}>RIFRESKO</button></p> : null}
      {!record && !error ? <p role="status">Po ngarkohen shënimet…</p> : null}
      {saved ? <p role="status" style={{ color: '#86efac' }}>SHËNIMI U RUAJT.</p> : null}
      <details open={!compact}>
        <summary style={{ cursor: 'pointer', padding: '8px 0', fontWeight: 800 }}>VLERËSIM / SHËNIM I RI</summary>
        <fieldset disabled={busy || !!intent.current} style={{ border: 0, padding: 0, display: 'grid', gap: 10 }}>
          <label>Vlerësimi (opsional)<select aria-label="Vlerësimi i klientit" style={field} value={rating} onChange={(e) => setRating(e.target.value)}><option value="">Pa vlerësim</option>{[1,2,3,4,5].map((n) => <option key={n} value={n}>{n} / 5{n === 1 ? ' · Dobët' : n === 5 ? ' · Shumë mirë' : ''}</option>)}</select></label>
          <label>Çështja<select style={field} value={issue} onChange={(e) => setIssue(e.target.value)}><option value="">Asnjë</option>{Object.entries(issues).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
          <label>Shënim specifik<textarea aria-label="Shënim specifik për klientin" style={{ ...field, minHeight: 85 }} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="P.sh. telefono para mbërritjes; hyrja nga ana e oborrit." /></label>
          {record?.canManage ? <label>Marrjet e ardhshme<select style={field} value={flag} onChange={(e) => setFlag(e.target.value)}><option value="">Mbaje udhëzimin aktual</option><option value="yes">Mos e merr përsëri</option><option value="no">Lejo marrjet përsëri</option></select></label> : null}
        </fieldset>
        <button type="button" style={{ ...button, background: '#1d4ed8', marginTop: 10 }} onClick={save} disabled={busy}>{busy ? 'DUKE RUAJTUR…' : intent.current ? 'PROVO RUAJTJEN PËRSËRI' : 'RUAJ SHËNIMIN'}</button>
      </details>
      {record?.entries?.length ? <details style={{ marginTop: 12 }}><summary>HISTORIA ({record.entries.length}{record.entries.length === 30 ? ' të fundit' : ''})</summary>{record.entries.map((entry) => <div key={entry.id} style={{ borderTop: '1px solid #475569', padding: '10px 0' }}><strong>{entry.rating ? `${entry.rating}/5 · ` : ''}{entry.author_name}</strong><small> · {new Date(entry.created_at).toLocaleDateString('sq')}</small>{entry.issue ? <div>{issues[entry.issue]}</div> : null}<div style={{ whiteSpace: 'pre-wrap' }}>{entry.note}</div>{entry.no_pickup !== null ? <small>{entry.no_pickup ? 'Mos e merr përsëri' : 'Marrjet u lejuan përsëri'}</small> : null}</div>)}</details> : null}
    </section>
  );
}

export function PaymentCustomerCare({ orderId, onClose }) {
  const panel = useRef(null);
  useEffect(() => { panel.current?.querySelector('button')?.focus(); }, []);
  function onKeyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const controls = [...panel.current.querySelectorAll('button:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')].filter((node) => node.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  return <div ref={panel} onKeyDown={onKeyDown} role="dialog" aria-modal="true" aria-label="Pagesa u regjistrua" style={{ position: 'fixed', inset: 0, zIndex: 20000, background: 'rgba(2,6,23,.94)', overflowY: 'auto', padding: 'max(20px, env(safe-area-inset-top)) 14px 30px' }}><div style={{ maxWidth: 520, margin: '0 auto' }}><h2 style={{ color: '#86efac' }}>PAGESA U REGJISTRUA ✓</h2><p style={{ color: '#f8fafc' }}>Dëshiron ta vlerësosh klientin ose të lësh një shënim?</p><button type="button" style={button} onClick={onClose}>KALO / VAZHDO</button><CustomerCare key={orderId} orderId={orderId} onSaved={onClose} /></div></div>;
}
