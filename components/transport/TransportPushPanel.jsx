import React, { useEffect, useState } from 'react';
import { getActor } from '../../lib/actorSession';
import { getTransportSession } from '../../lib/transportAuth';
import { usePathname, useRouter } from '../../lib/routerCompat.jsx';
import { pushRequest, pushSupport, applicationServerKey, subscriptionHash, readPushConsent, writePushConsent, ensurePushWorker } from '../../lib/transportPushClient.js';

export default function TransportPushPanel() {
  const path = usePathname(), router = useRouter();
  const actor = getActor() || getTransportSession();
  const actorId = String(actor?.id || actor?.user_id || actor?.transport_id || '');
  const visible = ['/transport/board', '/transport/menu'].includes(path);
  const [state, setState] = useState({ loading: true }), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const changed = () => setRefresh(n => n + 1);
    window.addEventListener('tepiha:session-changed', changed);
    return () => window.removeEventListener('tepiha:session-changed', changed);
  }, []);
  useEffect(() => {
    if (!visible || !actorId) return;
    let active = true;
    const support = pushSupport();
    if (support !== 'supported') { setState({ support, loading: false }); return; }
    setState({ support, loading: true });
    const run = async () => {
      const status = await pushRequest('STATUS', actorId);
      let timeout;
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('App-i po përgatitet. Shtyp Rifresko pas pak.')), 20000); })])
        .finally(() => clearTimeout(timeout));
      await ensurePushWorker(reg);
      let sub = await reg.pushManager.getSubscription();
      const consent = readPushConsent();
      if (Notification.permission === 'denied' && status.enabled) await pushRequest('DISABLE', actorId);
      let enabled = Notification.permission === 'granted' && sub && status.enabled && status.endpointHash === await subscriptionHash(sub);
      // Renew an existing opt-in; permission is never requested automatically.
      if (!enabled && sub && Notification.permission === 'granted' && consent?.actorId === actorId) {
        await pushRequest('SUBSCRIBE', actorId, { subscription: sub.toJSON() }); enabled = true;
      }
      if (active) setState({ support, loading: false, enabled: !!enabled, publicKey: status.publicKey, reg });
    };
    run().catch(error => { if (active) setState({ support, loading: false, error: error.message }); });
    return () => { active = false; };
  }, [visible, actorId, refresh]);

  useEffect(() => {
    if (!visible || !actorId) return;
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('push_order');
    if (!orderId) return;
    let active = true;
    if (params.get('push_user') !== actorId) { setMessage('Ky njoftim i takon llogarisë tjetër. Hyr me llogarinë e shoferit përkatës.'); return; }
    pushRequest('OPEN', actorId, { orderId }).then(result => { if (active) router.replace(result.href); })
      .catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, [visible, actorId, router]);

  async function enable() {
    setBusy(true); setMessage('');
    try {
      // subscribe is invoked immediately from the tap, preserving iOS gesture.
      const sub = await state.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(state.publicKey) });
      const result = await pushRequest('SUBSCRIBE', actorId, { subscription: sub.toJSON() });
      writePushConsent({ actorId, endpointHash: result.endpointHash });
      setState(s => ({ ...s, enabled: true })); setMessage('Njoftimet u aktivizuan. Mund ta mbyllësh app-in.');
    } catch (error) { setMessage(Notification.permission === 'denied' ? 'Lejo njoftimet për TEPIHA te Settings / Notifications, pastaj provo përsëri.' : error.message); }
    finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setMessage('');
    try {
      await pushRequest('DISABLE', actorId);
      const sub = await state.reg.pushManager.getSubscription();
      await sub?.unsubscribe(); writePushConsent(null); setState(s => ({ ...s, enabled: false }));
      setMessage('Njoftimet u çaktivizuan në këtë telefon.');
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setMessage('');
    try { await pushRequest('TEST', actorId); setMessage('Prova u nis. Kontrollo njoftimet e telefonit.'); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  if (!visible || !actorId || (actor?.role !== 'TRANSPORT' && actor?.is_hybrid_transport !== true)) return null;
  const button = { minHeight: 42, padding: '8px 12px', borderRadius: 10, border: '1px solid #48627c', color: '#fff', background: '#19374d', fontWeight: 700 };
  return <section aria-label="Njoftimet e porosive" style={{ background: '#0d1c2b', color: '#edf5ff', padding: 12, borderBottom: '1px solid #2a4054', fontSize: 14 }}>
    <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
      <strong>Njoftimet e porosive {state.enabled ? '✓ Aktive' : ''}</strong>
      {state.support === 'install' ? <span>Në iPhone: Share → Add to Home Screen. Hape TEPIHA nga ikona për t’i aktivizuar.</span>
        : state.support === 'unsupported' ? <span>Ky shfletues nuk i mbështet njoftimet. Përdor një shfletues të përditësuar; në iPhone kërkohet iOS 16.4+.</span>
        : state.loading ? <span>Duke kontrolluar…</span>
        : state.error ? <><span role="status">{state.error}</span><button type="button" style={button} onClick={() => setRefresh(n => n + 1)}>Rifresko</button></>
        : state.enabled ? <><button type="button" style={button} disabled={busy} onClick={test}>Provo njoftimin</button><button type="button" style={button} disabled={busy} onClick={disable}>Çaktivizo</button></>
        : <button type="button" style={button} disabled={busy || !state.reg} onClick={enable}>{busy ? 'Duke aktivizuar…' : 'Aktivizo njoftimet'}</button>}
      {message ? <span role="status" style={{ flexBasis: '100%' }}>{message}</span> : null}
    </div>
  </section>;
}
