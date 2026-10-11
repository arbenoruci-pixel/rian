import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getActor } from '@/lib/actorSession';
import { canAuditInventory } from '@/lib/inventoryAudit';
import { approvedApiRequest } from '@/lib/approvedApiRequest';
import './style.css';

const labels = { unverified: 'Pa kontrolluar', seen_in_depot: 'U gjet', not_found: 'Nuk u gjet' };
const errors = {
  AUDIT_STALE: 'Porosia ndryshoi në pajisje tjetër. Rifreskoje.',
  AUDIT_STATUS_CHANGED: 'Porosia nuk është më në këtë fazë.',
  AUDIT_NOT_OVER_FOUR_DAYS: 'Nuk i ka kaluar 4 ditë në Pastrim.',
  AUDIT_DATE_UNKNOWN: 'Mungon data e hyrjes në Pastrim.',
  AUDIT_STATUS_CONFLICT: 'Statusi ka një pengesë në sistem. Duhet kontrolluar veçmas.',
  AUDIT_ORDER_NOT_FOUND: 'Porosia nuk gjendet më në sistem.',
  AUDIT_FORBIDDEN: 'Auditimi lejohet vetëm për Admin dhe Dispatch.',
  DISPATCH_ORDER_ACTOR_NOT_ALLOWED: 'Auditimi lejohet vetëm për Admin dhe Dispatch.',
  AUTH_REQUIRED: 'Hyr përsëri në llogari.', DEVICE_NOT_APPROVED: 'Kjo pajisje nuk është e aprovuar.',
};
const errorText = error => errors[error?.code || error?.message || error] || 'Ruajtja nuk u konfirmua. Rifresko listën dhe provo përsëri.';
const dateText = value => value ? new Date(value).toLocaleString('sq-AL', { timeZone: 'Europe/Belgrade', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

export default function InventoryAuditPage() {
  const [params, setParams] = useSearchParams();
  const stage = params.get('stage') === 'processing' ? 'processing' : 'ready';
  const allowed = canAuditInventory(getActor()?.role);
  const [items, setItems] = useState([]), [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('unverified'), [search, setSearch] = useState(params.get('code') || '');
  const [selected, setSelected] = useState(new Set()), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [rowErrors, setRowErrors] = useState({});
  const [notes, setNotes] = useState({}), [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);
  const lock = useRef(false), alive = useRef(true), operations = useRef(new Map());

  async function refresh() {
    if (lock.current) return;
    setLoading(true); setError('');
    try {
      const r = await approvedApiRequest('/api/inventory-audit', { action: 'LIST' }, { timeoutMs: 30000 });
      if (!r.complete || !Array.isArray(r.items)) throw new Error('AUDIT_LIST_INCOMPLETE');
      if (!alive.current) return;
      setItems(r.items); setLoaded(true); setSelected(new Set()); setRowErrors({});
    } catch (e) { if (alive.current) { setError(errors[e.code] || 'Lista e plotë nuk u ngarkua. Kontrollo internetin dhe rifresko.'); setLoaded(false); } }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    if (allowed) void refresh(); else setLoading(false);
    const network = () => setOnline(navigator.onLine);
    window.addEventListener('online', network); window.addEventListener('offline', network);
    return () => { alive.current = false; window.removeEventListener('online', network); window.removeEventListener('offline', network); };
  }, [allowed]);

  const ready = items.filter(r => r.stage === 'ready');
  const overdue = items.filter(r => r.stage === 'processing' && r.overdue);
  const counts = Object.fromEntries(Object.keys(labels).map(k => [k, ready.filter(r => r.result === k).length]));
  const visible = useMemo(() => {
    const q = search.trim().toLocaleLowerCase();
    return items.filter(r => r.stage === stage && (stage === 'processing' ? r.overdue : filter === 'all' || r.result === filter))
      .filter(r => !q || `${r.code} ${r.name} ${r.phone} ${r.location}`.toLocaleLowerCase().includes(q))
      .sort((a, b) => stage === 'processing' ? (b.ageDays || 0) - (a.ageDays || 0) || a.code.localeCompare(b.code, undefined, { numeric: true })
        : a.location.localeCompare(b.location, 'sq') || a.code.localeCompare(b.code, undefined, { numeric: true }));
  }, [items, stage, filter, search]);
  const selectedRows = overdue.filter(r => selected.has(r.key));
  const disabled = busy || loading || !online || !loaded;
  function switchStage(value) { if (busy) return; setParams({ stage: value }); setFilter('unverified'); setSearch(''); setSelected(new Set()); setNotice(''); setError(''); }
  function toggle(key) { setSelected(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; }); }

  async function act(action, rows, result = 'unverified', note = '') {
    if (lock.current || disabled || !rows.length) return;
    lock.current = true; setBusy(true); setConfirm(false); setNotice(''); setError('');
    let done = 0, failed = 0;
    try {
      for (let from = 0; from < rows.length; from += 10) {
        const batch = rows.slice(from, from + 10);
        const payload = batch.map(r => {
          const k = `${action}:${result}:${r.key}:${r.revision}:${note}`;
          if (!operations.current.has(k)) operations.current.set(k, crypto.randomUUID());
          return { table: r.table, id: r.id, revision: r.revision, operationId: operations.current.get(k) };
        });
        const response = await approvedApiRequest('/api/inventory-audit', { action, result, note, items: payload }, { timeoutMs: 55000 });
        if (!Array.isArray(response.results) || response.results.length !== batch.length) throw new Error('AUDIT_RESPONSE_INVALID');
        const patches = new Map();
        const issues = {};
        for (const r of response.results) {
          if (r.ok && r.item) { done++; patches.set(r.key, r.item); issues[r.key] = ''; }
          else { failed++; issues[r.key] = errorText(r.error); }
        }
        if (!alive.current) return;
        setItems(prev => prev.map(r => patches.get(r.key) || r));
        setSelected(prev => new Set([...prev].filter(k => !patches.has(k))));
        setRowErrors(prev => ({ ...prev, ...issues }));
        setNotice(`${done} u ${action === 'MOVE_READY' ? 'kaluan në Gati për kontroll' : 'ruajtën'}.${failed ? ` ${failed} kërkojnë rishikim.` : ''}`);
      }
    } catch (e) {
      if (alive.current) { setError(`${done ? `${done} u ruajtën. ` : ''}${errorText(e)}`); setLoaded(false); }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }

  if (!allowed) return <main className="inventory-audit"><h1>Auditimi</h1><p>Kjo faqe është vetëm për Admin dhe Dispatch.</p><Link to="/">Kthehu te kryefaqja</Link></main>;
  return <main className="inventory-audit">
    <header className="ia-header"><div><Link to={stage === 'processing' ? '/pastrimi' : '/gati'}>← Kthehu te {stage === 'processing' ? 'Pastrimi' : 'Gati'}</Link><h1>Auditimi i tepihave</h1><p>Kontrollo porositë, një nga një.</p></div><button type="button" onClick={refresh} disabled={busy || loading || !online}>Rifresko</button></header>
    <nav className="ia-tabs" aria-label="Faza e auditimit"><button aria-pressed={stage === 'processing'} disabled={busy} onClick={() => switchStage('processing')}>1. Pastrim mbi 4 ditë <b>{loaded ? overdue.length : '—'}</b></button><button aria-pressed={stage === 'ready'} disabled={busy} onClick={() => switchStage('ready')}>2. Kontroll fizik në Gati <b>{loaded ? ready.length : '—'}</b></button></nav>
    {!online && <p className="ia-error" role="alert">Pa internet. Lidhu për ta ruajtur auditimin.</p>}
    {error && <p className="ia-error" role="alert">{error}</p>}
    {notice && <p className="ia-notice" role="status">{notice} {stage === 'processing' && <button disabled={busy} onClick={() => switchStage('ready')}>Vazhdo te kontrolli fizik →</button>}</p>}
    {stage === 'ready' ? <><p className="ia-help">Shiko tepihat fizikisht dhe shtyp <strong>U gjet</strong> ose <strong>Nuk u gjet</strong>. Porositë që mungojnë mbeten në Gati për rishikim.</p><div className="ia-filters" aria-label="Rezultati i kontrollit">{[...Object.keys(labels), 'all'].map(k => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{labels[k] || 'Të gjitha'} <b>{loaded ? k === 'all' ? ready.length : counts[k] : '—'}</b></button>)}</div></>
      : <p className="ia-help">Zgjidh porositë që i kanë kaluar 4 ditë në Pastrim. Kalojnë në Gati si <strong>Pa kontrolluar</strong>, për t’i verifikuar në depo.</p>}
    <label className="ia-search">Kërko kodin, klientin ose raftin<input value={search} onChange={e => setSearch(e.target.value)} placeholder="P.sh. 1344, T25 ose A12" type="search" /></label>
    {stage === 'processing' && visible.length > 0 && <label className="ia-select-all"><input type="checkbox" disabled={disabled} checked={visible.every(r => selected.has(r.key))} onChange={e => setSelected(prev => { const next = new Set(prev); visible.forEach(r => e.target.checked ? next.add(r.key) : next.delete(r.key)); return next; })} />Zgjidhi të gjitha në këtë listë ({visible.length})</label>}
    {loading && <p role="status">Po ngarkohen porositë…</p>}
    {!loading && loaded && !visible.length && <div className="ia-empty">{search ? 'Nuk ka porosi me këtë kërkim.' : stage === 'processing' ? 'Nuk ka porosi mbi 4 ditë në Pastrim.' : 'Nuk ka porosi në këtë filtër.'}</div>}
    <div className="ia-list">{visible.map(r => <article className={`ia-order ia-${r.result}`} key={r.key}>
      <div className="ia-order-head">{stage === 'processing' && <input aria-label={`Zgjidh porosinë ${r.code}`} type="checkbox" checked={selected.has(r.key)} disabled={disabled} onChange={() => toggle(r.key)} />}<strong className="ia-code">{r.code}</strong><div className="ia-identity"><h2>{r.name}</h2><span>{r.table === 'orders' ? 'Bazë' : 'Transport'} · {r.pieces} copë · {r.m2.toFixed(1)} m²</span></div><span className="ia-state">{stage === 'processing' ? `${r.ageDays} ditë` : labels[r.result]}</span></div>
      <div className="ia-location">📍 {r.location || 'Rafti nuk është shënuar'}</div>
      {stage === 'ready' && <><div className="ia-audit-info">{r.checkedAt ? `${r.movedForAudit ? 'Kaloi për kontroll' : 'Kontrolluar'}: ${dateText(r.checkedAt)} · ${r.checkedBy}` : 'Ende pa kontroll fizik.'}{r.note && <p>{r.note}</p>}</div>
        <details><summary>Shënim / hollësi</summary><label>Shënim (opsional)<input maxLength={500} value={notes[r.key] ?? r.note} onChange={e => setNotes(prev => ({ ...prev, [r.key]: e.target.value }))} placeholder="P.sh. u gjetën 2 nga 3 tepihat" /></label><p>{r.phone || 'Pa telefon'} · Vlera: {r.total.toFixed(2)} € · Porosia #{r.id}</p></details>
        <div className="ia-actions"><button className="ia-found" disabled={disabled} onClick={() => act('VERIFY', [r], 'seen_in_depot', notes[r.key] ?? r.note)}>✓ U gjet</button><button className="ia-missing" disabled={disabled} onClick={() => act('VERIFY', [r], 'not_found', notes[r.key] ?? r.note)}>✕ Nuk u gjet</button>{r.result !== 'unverified' && <button className="ia-reset" disabled={disabled} onClick={() => act('VERIFY', [r], 'unverified', notes[r.key] ?? r.note)}>Rikontrollo</button>}</div></>}
      {rowErrors[r.key] && <p className="ia-error" role="alert">{rowErrors[r.key]}</p>}
    </article>)}</div>
    {stage === 'processing' && <footer className="ia-bulk"><span><b>{selectedRows.length}</b> të zgjedhura</span><button disabled={disabled || !selectedRows.length} onClick={() => setConfirm(true)}>{busy ? 'Duke ruajtur…' : `Kalo ${selectedRows.length || ''} në Gati`}</button></footer>}
    {confirm && <div className="ia-overlay" onKeyDown={e => { if (e.key === 'Escape') setConfirm(false); if (e.key === 'Tab') { const buttons = e.currentTarget.querySelectorAll('button'); const first = buttons[0], last = buttons[buttons.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } }}><section role="dialog" aria-modal="true" aria-labelledby="ia-confirm-title" className="ia-dialog"><h2 id="ia-confirm-title">Kalo {selectedRows.length} porosi në Gati?</h2><p>Do të shënohen “Pa kontrolluar”. Pastaj verifiko fizikisht cilat gjenden në depo.</p><div className="ia-actions"><button autoFocus onClick={() => setConfirm(false)}>Anulo</button><button className="ia-confirm" onClick={() => act('MOVE_READY', selectedRows)}>Po, kaloji në Gati</button></div></section></div>}
  </main>;
}
