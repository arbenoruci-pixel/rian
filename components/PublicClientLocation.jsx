import { useEffect, useRef, useState } from 'react';
import { familyRequest, newFamilyRequestId } from '../lib/clientFamilyClient.js';
import { clientLocationMapUrl } from '../lib/clientLocation.js';
import { CustomerIcon, portal } from './CustomerPortalUi.jsx';

export default function PublicClientLocation({ source, orderId, token }) {
  const [address, setAddress] = useState('');
  const [addressOpen, setAddressOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [savedLocation, setSavedLocation] = useState(null);
  const [pending, setPending] = useState(false);
  const live = useRef(true), lock = useRef(false), intent = useRef(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function save(location) {
    if (lock.current) return;
    if (!intent.current && !location) return;
    lock.current = true; setBusy('save'); setError(''); setSavedLocation(null);
    try {
      intent.current ||= { action: 'PUBLIC_LOCATION', source, orderId: String(orderId), token, requestId: newFamilyRequestId(), location };
      setPending(true);
      const request = intent.current;
      const result = await familyRequest(request);
      if (result.saved !== true) throw new Error('LOCATION_NOT_CONFIRMED');
      if (!live.current) return;
      intent.current = null; setPending(false); setSavedLocation(request.location);
    } catch (err) {
      if (!live.current) return;
      if (err?.status >= 400 && err?.status < 500) { intent.current = null; setPending(false); }
      setError(/LINK_|AUTH|DEVICE/.test(err?.code || '') ? 'Linku ka skaduar. Kërko një link të ri nga kompania.' : 'Dërgimi nuk u konfirmua. Provo përsëri.');
    } finally { if (live.current) { lock.current = false; setBusy(''); } }
  }
  function locateAndSend() {
    if (lock.current || intent.current) return;
    if (!navigator.geolocation) { setAddressOpen(true); setError('Ky telefon nuk e ofron GPS-in. Shkruaj adresën më poshtë.'); return; }
    lock.current = true; setBusy('gps'); setError(''); setSavedLocation(null);
    navigator.geolocation.getCurrentPosition(position => {
      if (!live.current) return;
      lock.current = false;
      void save({ latitude: position.coords.latitude, longitude: position.coords.longitude, address: address.trim() });
    }, () => {
      if (!live.current) return;
      setAddressOpen(true);
      setError('Lejo qasjen në lokacion ose shkruaj adresën më poshtë.');
      setBusy(''); lock.current = false;
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }
  return <section aria-label="Lokacioni i tepihave" className="portal-card" style={portal.card}>
    <div style={portal.heading}><span style={{ ...portal.icon, background: '#eaf0f9', color: '#355c89' }}><CustomerIcon name="pin" /></span><h2 style={portal.title}>{source === 'TRANSPORT' ? 'Ku të vijë shoferi?' : 'Lokacioni i tepihave'}</h2></div>
    <button type="button" style={portal.button} disabled={!!busy || pending} onClick={locateAndSend}><CustomerIcon name="pin" size={18} />{busy === 'gps' ? 'Po merret lokacioni…' : busy === 'save' ? 'Po dërgohet…' : 'Dërgo lokacionin tim'}</button>
    <p style={{ ...portal.copy, margin: '10px 0 0', fontSize: 13 }}>{source === 'TRANSPORT' ? 'Nëse je aty ku duhet të vijë shoferi, preke butonin. Lokacioni i dërgohet shoferit që ta hapë direkt në hartë.' : 'Nëse je te adresa e tepihave, preke butonin për t’ia dërguar lokacionin kompanisë.'}</p>
    {savedLocation && <>
      <p role="status" style={portal.success}><CustomerIcon name="check" size={18} />{source === 'TRANSPORT' ? 'Lokacioni u dërgua. Shoferi mund ta hapë në hartë.' : 'Lokacioni iu dërgua kompanisë.'}</p>
      <a href={clientLocationMapUrl(savedLocation)} target="_blank" rel="noreferrer" style={{ display: 'inline-block', padding: '10px 0', color: '#236150', fontSize: 13, textDecoration: 'underline' }}>Shiko në hartë</a>
    </>}
    {error && <p role="alert" style={portal.error}>{error}</p>}
    {pending && !busy && <button type="button" style={{ ...portal.button, ...portal.secondary, marginTop: 12 }} onClick={() => save()}>Riprovo dërgimin</button>}
    <details open={addressOpen} onToggle={event => setAddressOpen(event.currentTarget.open)} style={{ borderTop: '1px solid #e5ebf0', marginTop: 16, paddingTop: 12 }}>
      <summary style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 13, color: '#456176', fontWeight: 500 }}>Shkruaj adresën / hyrjen<CustomerIcon name="chevron" size={16} className="portal-chevron" /></summary>
      <div style={{ marginTop: 12 }}>
        <label style={{ color: '#506477', fontSize: 13 }}>Adresa, hyrja ose kati
          <input aria-label="Adresa e tepihave" maxLength={300} value={address} disabled={!!busy || pending} onChange={event => setAddress(event.target.value)} placeholder="Rruga, numri, hyrja…" style={portal.input} />
        </label>
        <button type="button" style={{ ...portal.button, ...portal.secondary, marginTop: 10 }} disabled={!!busy || pending || !address.trim()} onClick={() => save({ address: address.trim() })}>Dërgo adresën</button>
      </div>
    </details>
  </section>;
}
