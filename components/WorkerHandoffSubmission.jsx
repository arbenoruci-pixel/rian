'use client';
import { useEffect, useRef, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { workerHandoffApi } from '@/lib/workerHandoffClient';
import { handoffExpenseDescription } from './workerHandoffWizardModel.js';

const money = value => new Intl.NumberFormat('de-DE', { style:'currency', currency:'EUR' }).format(Number(value || 0));
const actorKey = actor => String(actor?.id || actor?.user_id || '');
const sources = { WORKER_COLLECTIONS:'Nga paratë e klientëve', DISPATCH_DRAWER:'Nga arka e dispatch-it', OWN_MONEY:'Nga paratë personale' };
const categories = { FOOD:'Ushqim', FUEL:'Karburant', SUPPLIES:'Furnizime', OTHER:'Tjetër' };
const statuses = { PENDING:'Pret verifikimin', APPROVED:'Aprovuar', REJECTED:'Refuzuar', REIMBURSEMENT_PENDING:'Pret rimbursimin veçmas', REIMBURSED:'Rimbursuar nga arka' };
const auditDate = value => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sq-AL', { timeZone:'Europe/Belgrade', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false }).format(date) : '';
};
const block = { display:'grid', gap:10, minWidth:0, border:'1px solid #334155', borderRadius:12, padding:12, background:'#101b2e', overflowWrap:'anywhere' };
const button = { minHeight:44, padding:'10px 12px', border:'1px solid #64748b', borderRadius:10, background:'#1e293b', color:'#fff', fontWeight:750, fontSize:14, cursor:'pointer' };
const muted = { margin:0, color:'#cbd5e1', fontSize:13, lineHeight:1.55 };
const field = { width:'100%', boxSizing:'border-box', minHeight:46, padding:10, border:'1px solid #64748b', borderRadius:10, background:'#0b1220', color:'#fff', fontSize:16 };

function Lines({ children }) {
  return <dl style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) auto', alignItems:'start', gap:'8px 12px', margin:0, fontSize:14 }}>{children}</dl>;
}
function Line({ label, amount, strong = false, color }) {
  return <><dt style={{ fontWeight:strong ? 800 : 400 }}>{label}</dt><dd style={{ margin:0, textAlign:'right', whiteSpace:'nowrap', fontWeight:strong ? 850 : 600, color }}>{money(amount)}</dd></>;
}

function ExpenseReimbursement({ claim, api, onChanged }) {
  const [editing, setEditing] = useState(false), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const saving = useRef(false), mounted = useRef(true);
  const pending = api.pendingReimbursement?.(claim.id);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function reimburse(retry = false) {
    if (saving.current) return;
    if (!retry && (!claim.canReimburse || !confirmed || note.trim().length < 4)) return;
    if (retry && !pending) return;
    saving.current = true; setBusy(true); setError('');
    const requestingActor = actorKey(getActor());
    try {
      // A replay always uses the stored intent. Its amount and payment note
      // remain independent of a refreshed claim or a changed form.
      const payload = retry ? pending : { claimId:claim.id, amount:Number(claim.amount), note:note.trim(), confirmPaid:true };
      await api.reimburseExpense(payload, { retry });
      if (!mounted.current || actorKey(getActor()) !== requestingActor) return;
      setEditing(false); setNote(''); setConfirmed(false);
      await onChanged();
    } catch (err) {
      if (mounted.current && actorKey(getActor()) === requestingActor) setError(err.message || 'Rimbursimi nuk u konfirmua.');
    } finally {
      if (mounted.current && actorKey(getActor()) === requestingActor) { saving.current = false; setBusy(false); }
    }
  }
  const hasAudit = claim.status === 'REIMBURSED' || claim.reimbursementNote || claim.reimbursedAt;
  if (!pending && !claim.canReimburse && !hasAudit) return null;
  return <section style={{ display:'grid', gap:10 }} aria-label="Rimbursimi nga arka">
    {hasAudit && <div style={{ ...block, background:'#102c25', borderColor:'#326953' }} data-handoff-reimbursement-audit="1">
      <strong style={{ color:'#a7f3d0' }}>Rimbursimi nga arka</strong>
      <Lines><Line label="Pagesa e regjistruar për punëtorin" amount={claim.amount} strong /></Lines>
      {(claim.reimbursedByName || claim.reimbursedAt) && <p style={muted}>{claim.reimbursedByName || 'Pagesë e regjistruar'}{claim.reimbursedAt ? ` · ${auditDate(claim.reimbursedAt)}` : ''}</p>}
      {claim.reimbursementNote && <p style={{ ...muted, whiteSpace:'pre-wrap' }}>{claim.reimbursementNote}</p>}
    </div>}
    {pending ? <div style={{ display:'grid', gap:10 }} data-handoff-reimbursement-retry="1">
      <p role="status" style={{ ...muted, color:'#fde68a' }}>Rimbursimi prej {money(pending.amount)} pret përgjigjen përfundimtare. Riprova kontrollon regjistrimin e së njëjtës pagesë.</p>
      <button type="button" style={button} disabled={busy} onClick={() => reimburse(true)}>{busy ? 'Duke verifikuar…' : 'Riprovo të njëjtin rimbursim'}</button>
    </div> : claim.canReimburse && (editing ? <div style={{ display:'grid', gap:10 }} data-handoff-reimbursement-form="1">
      <strong>Regjistro pagesën që ia dhe punëtorit</strong>
      <Lines><Line label="Shuma e plotë e rimbursimit" amount={claim.amount} strong /></Lines>
      <p style={muted}>Ky konfirmim regjistron daljen e parave nga arka. Shuma për dorëzim nga punëtori mbetet e njëjtë.</p>
      <label style={{ display:'grid', gap:6, fontSize:14 }}>Shënimi i rimbursimit<textarea autoFocus rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} style={field} disabled={busy} /></label>
      <label style={{ display:'flex', alignItems:'flex-start', gap:10, fontSize:14, lineHeight:1.5 }}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} style={{ flexShrink:0, width:22, height:22 }} />Konfirmoj se ia pagova fizikisht {money(claim.amount)} nga arka.</label>
      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        <button type="button" style={button} disabled={busy} onClick={() => { setEditing(false); setNote(''); setConfirmed(false); setError(''); }}>Anulo</button>
        <button type="button" style={{ ...button, background:'#166534' }} disabled={busy || !confirmed || note.trim().length < 4} onClick={() => reimburse(false)}>{busy ? 'Duke regjistruar…' : 'Konfirmo rimbursimin'}</button>
      </div>
    </div> : <button type="button" style={{ ...button, background:'#166534', justifySelf:'start' }} onClick={() => { setEditing(true); setNote(''); setConfirmed(false); setError(''); }}>Regjistro rimbursimin</button>)}
    {error && <div role="alert" style={{ color:'#fecaca', fontSize:14 }}>{error}</div>}
  </section>;
}

function ExpenseClaim({ claim, canDecide, api, onChanged }) {
  const description = handoffExpenseDescription(claim.description) || 'Shpenzim';
  const [editing, setEditing] = useState(null), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const saving = useRef(false);
  const pending = api.pendingExpense?.(claim.id);
  const cashFunded = claim.fundingSource === 'WORKER_COLLECTIONS';
  const extraDeduction = Number(claim.deductionAmount ?? (cashFunded ? claim.amount : 0));
  const fundingText = cashFunded
    ? `Konfirmoj që ${money(claim.amount)} u paguan nga paratë e klientëve dhe nuk janë rimbursuar veçmas nga arka. Sqarohen ${money(extraDeduction)} të këtij dorëzimi.`
    : claim.fundingSource === 'DISPATCH_DRAWER'
      ? `Konfirmoj që ${money(claim.amount)} u paguan nga arka e dispatch-it. Shuma për dorëzim nga punëtori mbetet e njëjtë.`
      : `Konfirmoj shpenzimin me para personale. Rimbursimi i tij trajtohet veçmas; shuma për dorëzim mbetet e njëjtë.`;
  async function decide(retry = false) {
    if (saving.current) return;
    if (!retry && (note.trim().length < 4 || (editing === true && !confirmed))) {
      setError('Shkruaje shënimin e verifikimit dhe konfirmo burimin e parave.'); return;
    }
    saving.current = true; setBusy(true); setError('');
    try {
      await api.decideExpense({ claimId:claim.id, approve:editing === true, note:note.trim(), confirmFunding:confirmed }, { retry });
      setEditing(null); setNote(''); setConfirmed(false);
      await onChanged();
    } catch (err) { setError(err.message || 'Vendimi nuk u konfirmua.'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <article style={block} aria-label={`Shpenzimi ${description}`}>
    <div style={{ display:'flex', justifyContent:'space-between', flexWrap:'wrap', gap:8 }}><strong>{description} · {money(claim.amount)}</strong><span style={{ color:['APPROVED','REIMBURSED'].includes(claim.status) ? '#86efac' : claim.status === 'REJECTED' ? '#fca5a5' : '#fde68a', fontSize:13 }}>{statuses[claim.status] || claim.status}</span></div>
    <p style={muted}>{categories[claim.category] || claim.category} · {claim.spentOn}{claim.recipient ? ` · Për: ${claim.recipient}` : ''}<br />{sources[claim.fundingSource] || claim.fundingSource}</p>
    {cashFunded && <Lines>
      {Number(claim.mealAlreadyDeducted) > 0 && <Line label="Ushqim personal i zbritur tashmë" amount={claim.mealAlreadyDeducted} />}
      <Line label={claim.status === 'APPROVED' ? 'Sqarim i aprovuar në dorëzim' : 'Kërkesë për ulje të dorëzimit'} amount={extraDeduction} strong />
    </Lines>}
    {claim.fundingSource === 'OWN_MONEY' && <p style={muted}>{claim.status === 'REIMBURSED' ? 'Ky shpenzim u rimbursua veçmas nga arka.' : 'Ky shpenzim ndiqet për rimbursim veçmas. Verifikimi ruan vendimin; pagesa nga arka konfirmohet në hapin e rimbursimit.'}</p>}
    {claim.decisionNote && <div style={{ ...block, gap:6 }} data-handoff-decision-audit="1"><strong style={{ fontSize:13 }}>Vendimi për shpenzimin</strong><p style={muted}>{claim.decidedByName || 'Personi i autorizuar'}{claim.decidedAt ? ` · ${auditDate(claim.decidedAt)}` : ''}</p><p style={{ ...muted, whiteSpace:'pre-wrap' }}>{claim.decisionNote}</p></div>}
    {pending ? <div style={{ display:'grid', gap:10 }}>
      <p role="status" style={{ ...muted, color:'#fde68a' }}>Vendimi i mëparshëm pret përgjigjen. Riprovohet i njëjti {pending.approve ? 'aprovim' : 'refuzim'} pa u regjistruar dy herë.</p>
      <button type="button" style={button} disabled={busy} onClick={() => decide(true)}>{busy ? 'Duke verifikuar…' : 'Riprovo të njëjtin vendim'}</button>
    </div> : canDecide && claim.canDecide && <>
      {claim.requiresActualReceipt && <p style={{ ...muted, color:'#fde68a' }}>Përpara aprovimit, te “Prano paratë” regjistro shumën që e numërove fizikisht. Edhe kur pranon 0 €, regjistroje me shënim.</p>}
      {editing === null ? <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        <button type="button" style={{ ...button, background:'#166534', opacity:claim.requiresActualReceipt ? .55 : 1 }} disabled={claim.requiresActualReceipt} onClick={() => { setEditing(true); setError(''); }}>{claim.fundingSource === 'OWN_MONEY' ? 'Verifiko shpenzimin' : 'Aprovo shpenzimin'}</button>
        <button type="button" style={button} onClick={() => { setEditing(false); setError(''); }}>Refuzo kërkesën</button>
      </div> : <div style={{ display:'grid', gap:10 }}>
        <strong>{editing ? 'Verifiko burimin dhe shumën' : 'Shpjego refuzimin'}</strong>
        <label style={{ display:'grid', gap:6, fontSize:14 }}>Shënimi i verifikimit<textarea autoFocus rows={3} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} style={field} disabled={busy} /></label>
        {editing && <label style={{ display:'flex', alignItems:'flex-start', gap:10, fontSize:14, lineHeight:1.5 }}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} style={{ flexShrink:0, width:22, height:22 }} />{fundingText}</label>}
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}><button type="button" style={button} disabled={busy} onClick={() => { setEditing(null); setConfirmed(false); setNote(''); setError(''); }}>Anulo</button><button type="button" style={{ ...button, background:editing ? '#166534' : '#991b1b' }} disabled={busy || note.trim().length < 4 || (editing && !confirmed)} onClick={() => decide(false)}>{busy ? 'Duke ruajtur…' : editing ? 'Konfirmo aprovimin' : 'Konfirmo refuzimin'}</button></div>
      </div>}
    </>}
    {error && <div role="alert" style={{ color:'#fecaca', fontSize:14 }}>{error}</div>}
    {claim.fundingSource === 'OWN_MONEY' && <ExpenseReimbursement claim={claim} api={api} onChanged={onChanged} />}
  </article>;
}

export default function WorkerHandoffSubmission({ actor, handoffId, receiptVersion = '', onChange, api = workerHandoffApi }) {
  const actorId = actorKey(actor), scope = `${actorId}:${handoffId}`;
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const generation = useRef(0), callbacks = useRef({ onChange }); callbacks.current = { onChange };
  const visible = data?.scope === scope && actorKey(getActor()) === actorId ? data : null;
  async function refresh() {
    if (!actorId || actorKey(getActor()) !== actorId) return;
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const result = await api.read(handoffId);
      if (request === generation.current && actorKey(getActor()) === actorId) setData({ ...result, scope });
    } catch (err) { if (request === generation.current) { setData(null); setError(err.message || 'Nuk u lexua deklarimi.'); } }
    finally { if (request === generation.current) setLoading(false); }
  }
  useEffect(() => {
    const clear = () => { generation.current++; setData(null); setOpen(false); setError(''); };
    window.addEventListener('tepiha:session-changed', clear);
    return () => { generation.current++; window.removeEventListener('tepiha:session-changed', clear); };
  }, [scope]);
  useEffect(() => { if (open) void refresh(); return () => { generation.current++; }; }, [open, scope, receiptVersion]);
  async function changed() {
    await refresh();
    try { await callbacks.current.onChange?.(); } catch {}
  }
  const submission = visible?.submission, snapshot = submission?.snapshot || {}, totals = snapshot.totals || {};
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary style={{ cursor:'pointer', padding:'10px 0', fontSize:14, color:'#93c5fd', fontWeight:750 }}>Deklarimi i punëtorit · Klientët, bonuset dhe shpenzimet</summary>
    {open && <div style={{ display:'grid', gap:12, paddingTop:8 }}>
      {loading && <p role="status" style={muted}>Duke lexuar deklarimin…</p>}
      {error && <div role="alert" style={{ color:'#fecaca', fontSize:14 }}>{error} <button type="button" style={button} disabled={loading} onClick={refresh}>Riprovo</button></div>}
      {visible && !submission && <p style={muted}>Ky dorëzim është bërë përpara formularit të ri. Deklarimi me hapa fillon me dorëzimet e reja.</p>}
      {submission && <>
        <div style={block}>
          <strong>Llogaritja e ruajtur në dorëzim</strong>
          <Lines>
            <Line label="Pagesat e klientëve" amount={totals.grossCash} />
            {Number(totals.commission) > 0 && <Line label="Komision i mbajtur" amount={-Number(totals.commission)} />}
            <Line label="Bonuse të mbajtura" amount={-Number(totals.bonusDeduction || 0)} />
            <Line label="Ushqim i llogaritur" amount={-Number(totals.mealDeduction || 0)} />
            <Line label="Pritej pas zbritjeve" amount={submission.expectedCash} strong />
            <Line label="Shpenzime nga klientët · kërkesë" amount={-Number(totals.claimedCollectionExpenses || 0)} />
            <Line label="Nëse aprovohen këto shpenzime" amount={submission.projectedCash} strong />
            <Line label="Punëtori numëroi dhe deklaroi" amount={submission.physicalCash} strong color="#93c5fd" />
          </Lines>
          <p style={muted}>Kjo është deklarata e punëtorit. Pranimi real nga dispatch-i regjistrohet te “Prano paratë”. Shpenzimet më poshtë kanë vendimin e tyre.</p>
          {Number(submission.differenceAmount) !== 0 && <p style={{ ...muted, color:'#fde68a' }}><strong>{Number(submission.differenceAmount) < 0 ? 'Më pak se llogaritja' : 'Më shumë se llogaritja'}: {money(Math.abs(Number(submission.differenceAmount)))}</strong><br />{submission.differenceReason}</p>}
        </div>
        <details><summary style={{ cursor:'pointer', padding:'10px 0', fontSize:14 }}>Pagesat e klientëve ({snapshot.payments?.length || 0})</summary><div style={{ display:'grid', gap:8 }}>{(snapshot.payments || []).map(payment => <div key={payment.id} style={{ ...block, gap:4, fontSize:14 }}><div style={{ display:'flex', justifyContent:'space-between', gap:8 }}><strong>{payment.clientName || 'Klienti'}</strong><strong style={{ whiteSpace:'nowrap' }}>{money(payment.amount)}</strong></div><span style={{ color:'#94a3b8', fontSize:12 }}>{payment.code ? `Kodi ${payment.code} · ` : ''}Pagesa #{payment.id}{payment.collectedAt ? ` · ${new Intl.DateTimeFormat('sq-AL', { timeZone:'Europe/Belgrade', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(payment.collectedAt))}` : ''}</span></div>)}</div></details>
        {(snapshot.bonuses || []).length > 0 && <details><summary style={{ cursor:'pointer', padding:'10px 0', fontSize:14 }}>Burimi i bonuseve ({snapshot.bonuses.length})</summary><div style={{ display:'grid', gap:8 }}>{snapshot.bonuses.map((bonus, index) => <div key={bonus.bonusId || bonus.paymentId || index} style={{ ...block, fontSize:13 }}><span>{bonus.kind === 'TRANSPORT' ? 'Transport' : 'Bazë'} · #{bonus.bonusId || bonus.paymentId} · {money(bonus.remainingAmount ?? bonus.amount)}</span></div>)}</div><p style={{ ...muted, marginTop:8 }}>Në këtë dorëzim janë llogaritur gjithsej {money(totals.bonusDeduction)}. Mbeten për herën tjetër {money(totals.bonusRemaining)}.</p></details>}
        <div style={{ display:'grid', gap:10 }}><strong style={{ fontSize:14 }}>Shpenzimet e deklaruara ({visible.claims?.length || 0})</strong>{(visible.claims || []).length === 0 ? <p style={muted}>Nuk u deklaruan shpenzime në këtë dorëzim.</p> : visible.claims.map(claim => <ExpenseClaim key={`${scope}:${claim.id}`} claim={claim} canDecide={visible.canDecide} api={api} onChanged={changed} />)}</div>
      </>}
    </div>}
  </details>;
}
