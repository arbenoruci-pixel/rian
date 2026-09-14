import { useEffect, useRef, useState } from 'react';
import { familyRequest, newFamilyRequestId } from '../lib/clientFamilyClient.js';
import { clientLocationMapUrl } from '../lib/clientLocation.js';
import { familyButtonStyle as button } from './FamilyContactsForm.jsx';

export default function PublicClientLocation({ source, orderId, token }) {
  const [address, setAddress] = useState('');
  const [coords, setCoords] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const live = useRef(true), lock = useRef(false), intent = useRef(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  function locate() {
    if (lock.current || intent.current) return;
    if (!navigator.geolocation) { setError('Shkruaj adresën më poshtë. Ky telefon nuk e ofron lokacionin.'); return; }
    lock.current = true; setBusy('gps'); setError(''); setSaved(false);
    navigator.geolocation.getCurrentPosition(position => {
      if (!live.current) return;
      setCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      setBusy(''); lock.current = false;
    }, () => {
      if (!live.current) return;
      setError('Lokacioni nuk u mor. Lejo qasjen në lokacion ose shkruaj adresën më poshtë.');
      setBusy(''); lock.current = false;
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }
  async function save() {
    if (lock.current) return;
    if (!coords && !address.trim()) { setError('Zgjidh lokacionin ose shkruaj adresën.'); return; }
    lock.current = true; setBusy('save'); setError(''); setSaved(false);
    try {
      intent.current ||= { action: 'PUBLIC_LOCATION', source, orderId: String(orderId), token, requestId: newFamilyRequestId(), location: { ...coords, address: address.trim() } };
      setPending(true);
      await familyRequest(intent.current);
      if (!live.current) return;
      intent.current = null; setPending(false); setSaved(true);
    } catch (err) {
      if (!live.current) return;
      if (err?.status >= 400 && err?.status < 500) { intent.current = null; setPending(false); }
      setError(/LINK_|AUTH|DEVICE/.test(err?.code || '') ? 'Linku ka skaduar. Kërko një link të ri nga kompania.' : 'Dërgimi nuk u konfirmua. Provo përsëri.');
    } finally { if (live.current) { lock.current = false; setBusy(''); } }
  }
  const map = clientLocationMapUrl({ ...coords, address });
  return <div style={{ borderTop: '1px solid #334155', marginTop: 20, paddingTop: 16, display: 'grid', gap: 10 }}>
    <h3 style={{ margin: 0 }}>Ku t’i marrim ose t’i sjellim tepihat?</h3>
    <p style={{ margin: 0 }}>Nëse je te adresa e tepihave, përdor lokacionin e telefonit.</p>
    <button type="button" style={button} disabled={!!busy || pending} onClick={locate}>{busy === 'gps' ? 'Po merret lokacioni…' : 'Përdor lokacionin tim'}</button>
    {coords && <div>Lokacioni u zgjodh. <a href={map} target="_blank" rel="noreferrer" style={{ color: '#7dd3fc' }}>Kontrolloje në hartë</a></div>}
    <label>Adresa / hyrja / kati
      <input aria-label="Adresa e tepihave" maxLength={300} value={address} disabled={!!busy || pending} onChange={event => { setAddress(event.target.value); setSaved(false); }} placeholder="P.sh. rruga, numri i shtëpisë, hyrja" style={{ display: 'block', width: '100%', boxSizing: 'border-box', padding: 12, marginTop: 6, background: '#020617', color: '#f1f5f9', border: '1px solid #475569', borderRadius: 10 }} />
    </label>
    {coords && !pending && <button type="button" disabled={!!busy} style={button} onClick={() => { setCoords(null); setSaved(false); }}>Përdor vetëm adresën e shkruar</button>}
    <button type="button" style={button} disabled={!!busy} onClick={save}>{busy === 'save' ? 'Po dërgohet…' : pending ? 'Riprovo dërgimin' : 'Dërgo lokacionin / adresën'}</button>
    {saved && <p role="status" style={{ margin: 0, color: '#86efac' }}>Lokacioni / adresa iu dërgua kompanisë.</p>}
    {error && <p role="alert" style={{ margin: 0, color: '#fda4af' }}>{error}</p>}
  </div>;
}
