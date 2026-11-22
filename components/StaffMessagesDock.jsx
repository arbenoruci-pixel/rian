import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { clearStaffMessagesCache, newStaffMessageRequestKey, readStaffMessagesActor, staffMessagesIdentity, staffMessagesRequest } from '../lib/staffMessagesClient.js';
import './StaffMessagesDock.css';

const PUBLIC_PREFIXES = ['/login', '/transport/login', '/porosit', '/k', '/debug', '/diag', '/offline'];
const dateLabel = value => {
  try { return new Intl.DateTimeFormat('sq-AL', { timeZone: 'Europe/Belgrade', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
  catch { return ''; }
};
const isPublic = location => PUBLIC_PREFIXES.some(path => location.pathname === path || location.pathname.startsWith(path + '/') || (path === '/debug' || path === '/diag') && location.pathname.startsWith(path)) || new URLSearchParams(location.search).get('public') === '1';

export default function StaffMessagesDock() {
  const location = useLocation();
  const [actor, setActor] = useState(readStaffMessagesActor);
  const actorKey = staffMessagesIdentity(actor);
  const publicRoute = isPublic(location);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('inbox');
  const [capability, setCapability] = useState(null);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recipients, setRecipients] = useState([]);
  const [selected, setSelected] = useState([]);
  const [allWorkers, setAllWorkers] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const requestRef = useRef(null);
  const listSequence = useRef(0);
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  const latest = useRef({ actorKey, open, mode, publicRoute });
  latest.current = { actorKey, open, mode, publicRoute };
  const current = key => key === staffMessagesIdentity(readStaffMessagesActor()) && key === latest.current.actorKey;

  useEffect(() => {
    const sync = () => setActor(readStaffMessagesActor());
    window.addEventListener('tepiha:session-changed', sync);
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    return () => { window.removeEventListener('tepiha:session-changed', sync); window.removeEventListener('storage', sync); window.removeEventListener('focus', sync); };
  }, []);

  useEffect(() => {
    listSequence.current++;
    setOpen(false); setMode('inbox'); setCapability(null); setUnread(0); setItems([]); setDetail(null); setNextCursor(null);
    setRecipients([]); setSelected([]); setAllWorkers(false); setTitle(''); setBody(''); setError(''); setNotice(''); setBusy(false); setLoading(false);
    requestRef.current = null;
    return () => { clearStaffMessagesCache(actorKey); };
  }, [actorKey]);

  const loadBadge = useCallback(async force => {
    const key = latest.current.actorKey;
    if (!key || latest.current.publicRoute || document.visibilityState === 'hidden' || navigator.onLine === false) return;
    try {
      const data = await staffMessagesRequest({ action: 'badge' }, { force });
      if (!current(key)) return;
      setCapability(data.actor); setUnread(data.unreadCount || 0);
    } catch (err) {
      if (current(key) && [401, 403].includes(err.httpStatus)) { setCapability(null); setUnread(0); setItems([]); setDetail(null); }
    }
  }, []);

  const loadList = useCallback(async (listMode, cursor = null, force = true) => {
    const key = latest.current.actorKey;
    if (!key) return;
    const sequence = ++listSequence.current;
    setLoading(true); setError('');
    if (!cursor) { setItems([]); setNextCursor(null); }
    try {
      const data = await staffMessagesRequest({ action: 'list', mode: listMode, ...(cursor ? { cursor } : {}) }, { force });
      if (!current(key) || sequence !== listSequence.current) return;
      setCapability(data.actor); setUnread(data.unreadCount || 0); setNextCursor(data.nextCursor || null);
      setItems(previous => cursor ? [...previous, ...data.items.filter(item => !previous.some(old => old.id === item.id))] : data.items || []);
    } catch (err) { if (current(key) && sequence === listSequence.current) setError(err.message); }
    finally { if (current(key) && sequence === listSequence.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!actorKey || publicRoute) return;
    void loadBadge(false);
    const refresh = () => { if (document.visibilityState !== 'hidden') void loadBadge(false); };
    const changed = () => { if (document.visibilityState !== 'hidden') void loadBadge(true); };
    // The badge uses a small count-only response. No background/hidden-tab polling.
    const timer = setInterval(refresh, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('tepiha:staff-messages-changed', changed);
    return () => {
      clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh); window.removeEventListener('tepiha:staff-messages-changed', changed);
    };
  }, [actorKey, publicRoute, loadBadge]);

  useEffect(() => {
    const show = () => {
      if (!latest.current.actorKey || latest.current.publicRoute || document.querySelector('[data-meal-policy-notice="open"]')) return;
      setMode('inbox'); setDetail(null); setNotice(''); setOpen(true);
    };
    const policyOpened = () => setOpen(false);
    window.addEventListener('tepiha:open-staff-messages', show);
    window.addEventListener('tepiha:meal-policy-open', policyOpened);
    return () => { window.removeEventListener('tepiha:open-staff-messages', show); window.removeEventListener('tepiha:meal-policy-open', policyOpened); };
  }, []);

  useEffect(() => {
    if (!open || !actorKey || publicRoute) return;
    if (mode === 'compose') {
      const key = actorKey;
      let cancelled = false;
      listSequence.current++;
      setLoading(true); setError('');
      staffMessagesRequest({ action: 'recipients' }, { force: true }).then(data => {
        if (cancelled || !current(key)) return;
        setCapability(data.actor); setRecipients(data.recipients || []);
        setSelected(previous => previous.filter(id => data.recipients.some(user => user.id === id)));
      }).catch(err => { if (!cancelled && current(key)) setError(err.message); }).finally(() => { if (!cancelled && current(key)) setLoading(false); });
      return () => { cancelled = true; };
    } else void loadList(mode);
  }, [open, mode, actorKey, publicRoute, loadList]);

  useEffect(() => {
    if (publicRoute) setOpen(false);
  }, [publicRoute]);

  useEffect(() => {
    if (!capability || capability.canSend) return;
    setRecipients([]); setSelected([]); setAllWorkers(false); setTitle(''); setBody(''); requestRef.current = null;
    if (mode !== 'inbox') { setMode('inbox'); setItems([]); setDetail(null); setNextCursor(null); }
  }, [capability?.id, capability?.canSend, mode]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus?.(); };
  }, [open]);

  function onKeyDown(event) {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); setOpen(false); }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(panelRef.current?.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]') || []).filter(node => node.getClientRects().length);
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  async function showDetail(item) {
    setDetail(item); setError('');
    if (mode !== 'inbox' || item.readAt) return;
    const key = actorKey;
    try {
      const receipt = await staffMessagesRequest({ action: 'read', messageId: item.id });
      if (!current(key)) return;
      setItems(previous => previous.map(row => row.id === item.id ? { ...row, ...receipt } : row));
      setDetail(previous => previous?.id === item.id ? { ...previous, ...receipt } : previous);
      setUnread(receipt.unreadCount || 0);
    } catch (err) { if (current(key)) setError(err.message); }
  }

  async function acknowledge() {
    if (!detail || busy) return;
    const key = actorKey, messageId = detail.id;
    setBusy(true); setError('');
    try {
      const receipt = await staffMessagesRequest({ action: 'acknowledge', messageId });
      if (!current(key)) return;
      setItems(previous => previous.map(row => row.id === messageId ? { ...row, ...receipt } : row));
      setUnread(receipt.unreadCount || 0);
      setDetail(null); setNotice('Leximi u konfirmua.');
    } catch (err) { if (current(key)) setError(err.message); }
    finally { if (current(key)) setBusy(false); }
  }

  async function send(event) {
    event.preventDefault();
    if (busy || loading || !capability?.canSend) return;
    const key = actorKey;
    const payload = { title: title.trim(), body: body.trim(), ...(allWorkers ? { allWorkers: true } : { recipientIds: [...selected].sort() }) };
    const fingerprint = JSON.stringify(payload);
    if (!requestRef.current || requestRef.current.fingerprint !== fingerprint) requestRef.current = { fingerprint, key: newStaffMessageRequestKey() };
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await staffMessagesRequest({ action: 'send', ...payload, requestKey: requestRef.current.key });
      if (!current(key)) return;
      setTitle(''); setBody(''); setSelected([]); setAllWorkers(false); requestRef.current = null;
      setNotice('Mesazhi u dërgua te ' + result.recipientCount + ' punëtorë.'); setDetail(null); setMode('sent');
    } catch (err) { if (current(key)) setError(err.message); }
    finally { if (current(key)) setBusy(false); }
  }

  if (!actorKey || publicRoute) return null;
  return <>
    <button type="button" className="staffMessageDock" aria-label={'Mesazhet' + (unread ? ', ' + unread + ' të palexuara' : '')} onClick={() => {
      if (document.querySelector('[data-meal-policy-notice="open"]')) return;
      setOpen(true); setMode('inbox'); setDetail(null); setNotice('');
    }}><span aria-hidden="true">✉</span> Mesazhet {unread > 0 && <strong>{unread > 99 ? '99+' : unread}</strong>}</button>

    {open && <div className="staffMessageOverlay" data-staff-messages-open="true" onKeyDown={onKeyDown}>
      <section ref={panelRef} className="staffMessagePanel" role="dialog" aria-modal="true" aria-labelledby="staff-message-title">
        <header className="staffMessageHeader"><div><h2 id="staff-message-title">Mesazhet</h2><p>{capability?.name || actor.name}</p></div><button ref={closeRef} type="button" className="staffMessageClose" aria-label="Mbyll mesazhet" disabled={busy} onClick={() => setOpen(false)}>×</button></header>
        <nav className="staffMessageTabs" aria-label="Dosjet e mesazheve">
          <button type="button" aria-pressed={mode === 'inbox'} disabled={busy} onClick={() => { setMode('inbox'); setDetail(null); setNotice(''); }}>Të marra {unread > 0 ? '(' + unread + ')' : ''}</button>
          {capability?.canSend && <><button type="button" aria-pressed={mode === 'sent'} disabled={busy} onClick={() => { setMode('sent'); setDetail(null); setNotice(''); }}>Të dërguara</button><button type="button" aria-pressed={mode === 'compose'} disabled={busy} onClick={() => { setMode('compose'); setDetail(null); setNotice(''); }}>+ Shkruaj</button></>}
        </nav>
        <div className="staffMessageContent">
          {notice && <p role="status" className="staffMessageNotice">{notice}</p>}
          {error && <p role="alert" className="staffMessageError">{error}</p>}
          {mode === 'compose' ? <form onSubmit={send} className="staffMessageForm">
            <fieldset disabled={busy || loading}><legend>Marrësit</legend>
              <label className="staffMessageRecipient"><input type="checkbox" checked={allWorkers} onChange={event => setAllWorkers(event.target.checked)} /><span>Të gjithë punëtorët <small>{recipients.length} aktivë</small></span></label>
              {!allWorkers && <div className="staffMessageRecipientList">{recipients.map(user => <label className="staffMessageRecipient" key={user.id}><input type="checkbox" checked={selected.includes(user.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, user.id] : previous.filter(id => id !== user.id))} /><span>{user.name}</span></label>)}</div>}
              {!loading && recipients.length === 0 && <p>Nuk ka punëtorë aktivë në listë.</p>}
            </fieldset>
            <label>Titulli<input name="title" maxLength={120} required value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="P.sh. Organizimi i punës" /></label>
            <label>Mesazhi<textarea name="body" rows={7} maxLength={4000} required value={body} disabled={busy} onChange={event => setBody(event.target.value)} placeholder="Shkruaje mesazhin për punëtorët…" /></label>
            <small>{body.length}/4000 · Shfaqet brenda aplikacionit</small>
            <button type="submit" className="staffMessagePrimary" disabled={busy || loading || !title.trim() || !body.trim() || (allWorkers ? recipients.length === 0 : selected.length === 0)}>{busy ? 'Duke dërguar…' : 'Dërgo mesazhin'}</button>
          </form> : detail ? <article className="staffMessageDetail">
            <button type="button" className="staffMessageBack" disabled={busy} onClick={() => setDetail(null)}>← Te lista</button>
            <h3>{detail.title}</h3><p className="staffMessageMeta">{detail.senderName} · {dateLabel(detail.createdAt)}</p><div className="staffMessageBody">{detail.body}</div>
            {mode === 'sent' ? <div className="staffMessageDelivery"><h4>Gjendja te punëtorët</h4>{(detail.recipients || []).map(user => <div key={user.id}><strong>{user.name}</strong><span>{user.acknowledgedAt ? 'Konfirmuar · ' + dateLabel(user.acknowledgedAt) : user.readAt ? 'Lexuar · ' + dateLabel(user.readAt) : 'Pa lexuar'}</span></div>)}<button type="button" disabled={loading} onClick={() => { setDetail(null); void loadList('sent'); }}>Rifresko gjendjen</button></div>
              : detail.acknowledgedAt ? <p className="staffMessageNotice">Leximi i konfirmuar · {dateLabel(detail.acknowledgedAt)}</p> : <button type="button" className="staffMessagePrimary" disabled={busy} onClick={acknowledge}>{busy ? 'Duke ruajtur…' : 'E lexova'}</button>}
          </article> : <>
            <div className="staffMessageListHead"><span>{mode === 'sent' ? 'Mesazhet që ke dërguar' : 'Mesazhet për ty'}</span><button type="button" disabled={loading} onClick={() => void loadList(mode)}>Rifresko</button></div>
            {loading && <p role="status">Duke ngarkuar…</p>}
            {!loading && !error && items.length === 0 && <p className="staffMessageEmpty">{mode === 'sent' ? 'Ende nuk ke dërguar mesazhe.' : 'Nuk ke mesazhe.'}</p>}
            {items.map(item => <button type="button" key={item.id} className={'staffMessageCard' + (mode === 'inbox' && !item.readAt ? ' unread' : '')} onClick={() => void showDetail(item)}><div><strong>{item.title}</strong>{mode === 'inbox' && !item.readAt && <span className="staffMessageUnread">I ri</span>}</div><span className="staffMessagePreview">{item.body.slice(0, 130)}{item.body.length > 130 ? '…' : ''}</span><small>{mode === 'sent' ? (item.recipients || []).filter(user => user.acknowledgedAt).length + '/' + (item.recipients || []).length + ' konfirmime' : item.senderName} · {dateLabel(item.createdAt)}</small></button>)}
            {nextCursor && <button type="button" className="staffMessageMore" disabled={loading} onClick={() => void loadList(mode, nextCursor)}>Shfaq më shumë</button>}
          </>}
        </div>
      </section>
    </div>}
  </>;
}
