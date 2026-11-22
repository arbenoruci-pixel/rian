'use client';
import { useEffect, useRef, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { getActor } from '@/lib/actorSession';
import WorkerBonusHandoffSummary, { shouldShowWorkerBonusHandoff } from './WorkerBonusHandoffSummary.jsx';
import { requestHandoffReceipts, readHandoffReceiptIntent, saveHandoffReceipt } from '../lib/handoffReceiptClient.js';
import { getHandoffReceiptTotals, receiptStateLabel, validateReceiptAmount } from '../lib/handoffReceipts.js';

const money = value => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(value || 0));
const stamp = value => value ? new Intl.DateTimeFormat('sq-AL', { timeZone: 'Europe/Belgrade', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '';
const panel = { border: '1px solid rgba(148,163,184,.25)', borderRadius: 16, padding: 14, background: '#101b2e', color: '#f8fafc', display: 'grid', gap: 12 };
const button = { border: '1px solid #475569', background: '#1e293b', color: '#fff', borderRadius: 11, padding: '11px 14px', minHeight: 44, fontWeight: 750, fontSize: 14, cursor: 'pointer' };
const field = { width: '100%', boxSizing: 'border-box', border: '1px solid #64748b', borderRadius: 10, background: '#0b1220', color: '#fff', padding: 12, fontSize: 16, minHeight: 46 };

export default function HandoffReceiptsPanel({ actor, targetPin, onChange, onSummary, title = 'Dorëzimet dhe diferencat' }) {
  const actorId = String(actor?.id || actor?.user_id || '');
  const scope = `${actorId}:${targetPin || ''}`;
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState(null), [amount, setAmount] = useState(''), [note, setNote] = useState('');
  const [confirmNoCash, setConfirmNoCash] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [focus, setFocus] = useState(() => {
    const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
    return { handoff: params.get('handoff') || '', worker: params.get('worker') || '' };
  });
  const [bonusOpen, setBonusOpen] = useState({});
  const generation = useRef(0), saving = useRef(false), editorRef = useRef(null), callbacks = useRef({}), focused = useRef('');
  editorRef.current = editor; callbacks.current = { onChange, onSummary };
  const currentSession = String(getActor()?.id || getActor()?.user_id || '');
  const visible = data?.scope === scope && currentSession === actorId ? data : null;
  async function refresh() {
    if (!actorId || String(getActor()?.id || getActor()?.user_id || '') !== actorId) { setData(null); callbacks.current.onSummary?.(null); return; }
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const result = await requestHandoffReceipts({ action: 'list', ...(targetPin ? { targetPin } : {}) });
      if (request === generation.current) { setData({ ...result, scope }); callbacks.current.onSummary?.(result.summary); }
    } catch (err) { if (request === generation.current) { setData(null); setError(err.message); callbacks.current.onSummary?.(null); } }
    finally { if (request === generation.current) setLoading(false); }
  }
  useEffect(() => {
    setData(null); setEditor(null); setNotice(''); setError('');
    setBonusOpen({}); callbacks.current.onSummary?.(null);
    void refresh();
    const renew = () => { if (document.visibilityState !== 'hidden' && !saving.current && !editorRef.current) void refresh(); };
    const sessionChanged = () => { generation.current++; setData(null); setEditor(null); callbacks.current.onSummary?.(null); };
    window.addEventListener('arka:refresh', renew);
    window.addEventListener('focus', renew);
    window.addEventListener('tepiha:session-changed', sessionChanged);
    document.addEventListener('visibilitychange', renew);
    const timer = window.setInterval(renew, 30000);
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener('arka:refresh',renew); window.removeEventListener('focus',renew); window.removeEventListener('tepiha:session-changed',sessionChanged); document.removeEventListener('visibilitychange',renew); };
  }, [actorId, targetPin]);
  const all = Array.isArray(visible?.handoffs) ? visible.handoffs : [];
  const filtered = all.filter(row => (!focus.handoff || String(row.id) === focus.handoff) && (!focus.worker || row.worker_id === focus.worker));
  const open = filtered.filter(row => getHandoffReceiptTotals(row).outstanding > 0);
  const settled = filtered.filter(row => getHandoffReceiptTotals(row).outstanding === 0).sort((a, b) => String(b.receipt_updated_at || '').localeCompare(String(a.receipt_updated_at || ''))).slice(0, 20);
  useEffect(() => {
    if (!focus.handoff || !visible || focused.current === focus.handoff) return;
    const element = document.getElementById(`handoff-receipt-${focus.handoff}`);
    if (element) { focused.current = focus.handoff; element.scrollIntoView?.({ behavior:'smooth',block:'center' }); element.focus?.({ preventScroll:true }); }
  }, [focus.handoff, visible]);
  const current = all.find(row => row.id === editor?.id);
  const totals = getHandoffReceiptTotals(current);
  const parsed = String(amount).trim() === '' ? null : validateReceiptAmount(String(amount).replace(',', '.'), { allowZero: editor?.mode === 'receive' });
  const intent = editor ? readHandoffReceiptIntent(actorId, editor.id) : null;
  function edit(row, mode) {
    setEditor({ id: row.id, mode }); setAmount(''); setNote(''); setConfirmNoCash(false); setError(''); setNotice('');
  }
  async function submit(retry = false) {
    if (!current || saving.current) return;
    if (!retry && (parsed == null || parsed > totals.outstanding || (editor.mode === 'resolve' && (!confirmNoCash || note.trim().length < 4)) || (parsed < totals.outstanding && note.trim().length < 4))) {
      setError('Kontrollo shumën dhe shkruaje arsyen e diferencës.'); return;
    }
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await saveHandoffReceipt({ handoffId: current.id, action: editor.mode, amount: parsed, expectedOutstanding: totals.outstanding, note: note.trim(), confirmNoCash }, { retry });
      setEditor(null);
      setNotice(result.event.event_kind === 'RECEIPT' ? `U pranuan ${money(result.event.amount)}. Mbeten ${money(result.handoff.outstanding)}.` : `U sqaruan ${money(result.event.amount)} pa hyrje cash në arkë. Mbeten ${money(result.handoff.outstanding)}.`);
      await refresh();
      try { await callbacks.current.onChange?.(result); } catch {}
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
    } catch (err) { setError(err.message); await refresh(); setError(err.message); }
    finally { saving.current = false; setBusy(false); }
  }
  function card(row) {
    const values = getHandoffReceiptTotals(row);
    const history = (visible?.events || []).filter(event => Number(event.handoff_id) === Number(row.id));
    const showBonus = row.has_bonus_allocations === true || shouldShowWorkerBonusHandoff({ id:row.worker_id, pay_ready_bonus_enabled:row.pay_ready_bonus_enabled });
    return <article key={row.id} id={`handoff-receipt-${row.id}`} tabIndex={-1} style={{ ...panel, background: '#0b1220', ...(String(row.id) === focus.handoff ? { borderColor:'#60a5fa' } : {}) }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 16 }}>{row.worker_name || 'Punëtori'} · #{row.id}</strong><span style={{ color: values.outstanding ? '#fcd34d' : '#86efac', fontSize: 13 }}>{receiptStateLabel(row)}</span></div>
      <div style={{ fontSize: 12, color: '#94a3b8' }}>{stamp(row.submitted_at)}</div>
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '7px 12px', margin: 0, fontSize: 14 }}>
        <dt>Pritej pas zbritjeve</dt><dd style={{ margin: 0 }}>{money(values.expected)}</dd>
        <dt>Pranuar realisht</dt><dd style={{ margin: 0, color: '#86efac' }}>{money(values.received)}</dd>
        {values.resolved > 0 && <><dt>Sqaruar pa hyrje cash</dt><dd style={{ margin: 0 }}>{money(values.resolved)}</dd></>}
        <dt><strong>Mbetet për dorëzim</strong></dt><dd style={{ margin: 0, fontWeight: 850, color: values.outstanding ? '#fcd34d' : '#86efac' }}>{money(values.outstanding)}</dd>
      </dl>
      {values.outstanding > 0 && visible.manager && row.can_receive === true && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" style={{ ...button, background: '#166534' }} onClick={() => edit(row, 'receive')}>Prano paratë</button>
        {values.tracked && <button type="button" style={button} onClick={() => edit(row, 'resolve')}>Sqaro diferencën</button>}
      </div>}
      {values.outstanding > 0 && visible.manager && row.worker_id === actorId && <p style={{ color: '#cbd5e1', fontSize: 13, margin: 0 }}>Dorëzimin tënd e pranon një person tjetër i autorizuar.</p>}
      {showBonus && <details onToggle={event => { const open = event.currentTarget.open; setBonusOpen(previous => ({ ...previous, [row.id]:open })); }}><summary style={{ cursor:'pointer',padding:'10px 0',fontSize:14 }}>Bonuset e mbajtura · Baza / Transporti</summary>{bonusOpen[row.id] && <WorkerBonusHandoffSummary actor={actor} targetPin={row.worker_pin} handoffId={row.id} submittedAt={row.submitted_at} receiptTracking={values.tracked} />}</details>}
      {row.worker_pin && <Link href={`/arka/puntor/${encodeURIComponent(row.worker_pin)}`} style={{ color:'#93c5fd',fontSize:14,padding:'8px 0' }}>Hap llogarinë e punëtorit →</Link>}
      {history.length > 0 && <details><summary style={{ cursor: 'pointer', padding: '8px 0', fontSize: 14 }}>Historiku i pranimeve ({history.length})</summary><div style={{ display: 'grid', gap: 8 }}>{history.map(event => <div key={event.id} style={{ borderTop: '1px solid #334155', paddingTop: 8, fontSize: 13 }}><strong>{event.event_kind === 'RECEIPT' ? 'Pranim cash' : 'Sqarim pa cash'} · {money(event.amount)}</strong><div style={{ color: '#94a3b8' }}>{event.actor_name} · {stamp(event.created_at)}</div><div>Mbetja: {money(event.outstanding_before)} → {money(event.outstanding_after)}</div>{event.note && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{event.note}</div>}</div>)}</div></details>}
    </article>;
  }
  return <section style={panel} aria-label={title}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}><h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2><button type="button" disabled={loading || busy} style={button} onClick={refresh}>{loading ? 'Duke lexuar…' : 'Rifresko'}</button></div>
    <p style={{ margin: 0, fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>Arka regjistron paratë e pranuara. Pjesa e mbetur ndiqet në të njëjtin dorëzim.</p>
    {error && <div role="alert" style={{ color: '#fecaca', fontSize: 14 }}>{error}</div>}
    {notice && <div role="status" style={{ color: '#86efac', fontSize: 14 }}>{notice}</div>}
    {(focus.handoff || focus.worker) && <div style={{ display:'flex',justifyContent:'space-between',gap:8,alignItems:'center',fontSize:13 }}><span>{focus.handoff ? `Dorëzimi #${focus.handoff}` : filtered[0]?.worker_name || 'Dorëzimet e punëtorit të zgjedhur'}</span><button type="button" style={button} onClick={() => setFocus({ handoff:'',worker:'' })}>Shfaq të gjitha</button></div>}
    {visible && !open.length && <div style={{ color: '#cbd5e1' }}>Nuk ka dorëzime ose diferenca të hapura{focus.handoff || focus.worker ? ' në këtë përzgjedhje' : ''}.</div>}
    {open.sort((a, b) => a.id - b.id).map(card)}
    {settled.length > 0 && <details open={focus.handoff ? true : undefined}><summary style={{ padding: '10px 0', cursor: 'pointer' }}>Dorëzimet e mbyllura së fundi ({settled.length})</summary><div style={{ display: 'grid', gap: 12 }}>{settled.map(card)}</div></details>}
    {current && editor && <div role="dialog" aria-modal="true" aria-label={editor.mode === 'receive' ? 'Prano paratë e dorëzimit' : 'Sqaro diferencën pa cash'} onKeyDown={event => { if (event.key === 'Escape' && !busy) setEditor(null); }} style={{ position: 'fixed', inset: 0, zIndex: 10050, background: 'rgba(0,0,0,.78)', overflowY: 'auto', padding: 'max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))', display: 'grid', alignItems: 'center' }}><div style={{ ...panel, width: '100%', maxWidth: 520, boxSizing: 'border-box', margin: 'auto' }}>
      <h3 style={{ margin: 0 }}>{editor.mode === 'receive' ? 'Sa para i pranove realisht?' : 'Sqaro diferencën pa hyrje cash'}</h3>
      <div>{current.worker_name} · Dorëzimi #{current.id}<br /><strong>Mbeten {money(totals.outstanding)}</strong></div>
      {intent ? <div role="status" style={{ color: '#fde68a' }}>Veprimi i mëparshëm pret konfirmimin: {intent.action === 'receive' ? 'Pranim' : 'Sqarim'} {money(intent.amount)}. Riprovohet i njëjti veprim.</div> : <>
        {editor.mode === 'resolve' && <p style={{ margin: 0, color: '#fde68a', lineHeight: 1.5 }}>Kjo ul diferencën e punëtorit pa shtuar para në arkë. Shkruaje saktë pse kjo shumë nuk pritet më.</p>}
        <label style={{ display: 'grid', gap: 6 }}>{editor.mode === 'receive' ? 'Shuma e numëruar (€)' : 'Shuma për sqarim (€)'}<input autoFocus inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} style={field} disabled={busy} /></label>
        <label style={{ display: 'grid', gap: 6 }}>Arsyeja / shënimi<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={1000} rows={3} style={field} disabled={busy} /></label>
        {editor.mode === 'resolve' && <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14 }}><input type="checkbox" checked={confirmNoCash} onChange={event => setConfirmNoCash(event.target.checked)} style={{ width: 22, height: 22 }} />Konfirmoj sqarimin e kësaj shume pa pranim parash. Arsyeja dhe emri im ruhen në historik.</label>}
        {parsed != null && parsed <= totals.outstanding && <strong style={{ color: '#fcd34d' }}>Pas veprimit mbeten {money(totals.outstanding - parsed)}</strong>}
      </>}
      {error && <div role="alert" style={{ color: '#fecaca' }}>{error}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><button type="button" disabled={busy} style={button} onClick={() => setEditor(null)}>Mbyll</button><button type="button" disabled={busy} style={{ ...button, background: editor.mode === 'receive' ? '#166534' : '#92400e', flex: 1 }} onClick={() => submit(!!intent)}>{busy ? 'Duke konfirmuar…' : intent ? 'Riprovo të njëjtin veprim' : editor.mode === 'receive' ? `Prano ${money(parsed)}` : `Sqaro ${money(parsed)} pa cash`}</button></div>
    </div></div>}
  </section>;
}
