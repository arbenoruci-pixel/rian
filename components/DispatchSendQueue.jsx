import React, { useEffect, useState } from 'react';
import { DISPATCH_OUTBOX_EVENT, getDispatchOutbox, wakeDispatchOutbox } from '../lib/dispatchOutboxRuntime.js';

function explanation(item) {
  if (item.state === 'sent') return item.deduplicatedActive ? `Porosia ${item.code} ekziston — u konfirmua.` : `U dërgua ${item.code} ✓`;
  if (item.state === 'pending') return item.sending
    ? 'Duke dërguar…'
    : 'Ruajtur në këtë pajisje. Dërgohet automatikisht kur të lidhet.';
  if (/AUTH|DEVICE|ACTOR|ROLE|DISABLED|RETIRED/.test(item.error)) return 'Duhet të hysh me llogarinë e autorizuar. Porosia është ruajtur në këtë pajisje.';
  if (item.error === 'DISPATCH_OUTBOX_REVIEW_REQUIRED') return 'Ka kaluar një ditë. Kontrollo orarin para se ta vazhdosh dërgimin.';
  if (/FINGERPRINT_CONFLICT/.test(item.error)) return 'Ky tentim është ruajtur më herët me të dhëna të tjera. Kontrollo porosinë e klientit në listë.';
  return `Porosia kërkon kontroll: ${item.error}`;
}

export default function DispatchSendQueue({ onInspect }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const read = async () => {
      const current = ++sequence;
      try {
        const saved = await getDispatchOutbox().list();
        if (alive && current === sequence) { setItems(saved); setError(''); }
      } catch {
        if (alive && current === sequence) setError('Ruajtja në pajisje nuk është e disponueshme. Mbaje formularin hapur.');
      }
    };
    const failed = () => { sequence++; setError('Ruajtja në pajisje nuk u konfirmua. Kontrollo porosinë para se ta krijosh përsëri.'); };
    read();
    window.addEventListener(DISPATCH_OUTBOX_EVENT, read);
    window.addEventListener('tepiha:dispatch-outbox-storage-error', failed);
    return () => { alive = false; sequence++; window.removeEventListener(DISPATCH_OUTBOX_EVENT, read); window.removeEventListener('tepiha:dispatch-outbox-storage-error', failed); };
  }, []);
  const visible = [...items.filter((item) => item.state !== 'sent'), ...items.filter((item) => item.state === 'sent').slice(-3).reverse()];
  if (!visible.length && !error) return null;
  return <section aria-label="Dërgimi i porosive" style={{ marginBottom: 16, padding: 16, border: '1px solid #cbd5e1', borderRadius: 16, background: '#fff', color: '#0f172a' }}>
    <strong>DËRGIMI I POROSIVE</strong>
    {error ? <p role="alert">{error}</p> : null}
    <div aria-live="polite">{visible.map((item) => <div key={item.id} style={{ paddingTop: 12, fontSize: 14, overflowWrap: 'anywhere' }}>
      <strong>{item.name}</strong> · {item.phone}
      {item.payload?.data?.pickup_date ? <div style={{ marginTop: 4 }}>Marrja: {item.payload.data.pickup_date} · {item.payload.data.pickup_slot === 'evening' ? 'Mbrëmje' : 'Paradite'}</div> : null}
      <div style={{ marginTop: 4, color: item.state === 'sent' ? '#166534' : item.state === 'blocked' ? '#991b1b' : '#475569' }}>{explanation(item)}</div>
      {item.state === 'blocked' && /AUTH|DEVICE|ACTOR|ROLE|DISABLED|RETIRED|REVIEW_REQUIRED/.test(item.error) ? <button type="button" style={{ marginTop: 8, minHeight: 44, padding: '8px 12px' }} onClick={async () => {
        try {
          await getDispatchOutbox().retry(item.id);
          await getDispatchOutbox().send(item.id, { force: true });
          wakeDispatchOutbox();
        } catch { setError('Tentimi nuk u konfirmua. Porosia mbetet e ruajtur në këtë pajisje.'); }
      }}>KONTROLLOVA — VAZHDO DËRGIMIN</button> : null}
      {item.state === 'blocked' && onInspect ? <button type="button" style={{ marginTop: 8, minHeight: 44, padding: '8px 12px' }} onClick={() => onInspect(item.phone)}>KONTROLLO POROSITË E KLIENTIT</button> : null}
    </div>)}</div>
  </section>;
}
