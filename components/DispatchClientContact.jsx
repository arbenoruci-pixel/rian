import { useEffect, useRef, useState } from 'react';
import SmartSmsModal from './SmartSmsModal.jsx';
import { familyRequest } from '../lib/clientFamilyClient.js';
import { clientLocationMapUrl } from '../lib/clientLocation.js';

const button = { minHeight: 46, padding: '10px 12px', borderRadius: 12, border: '1px solid #3b82f6', background: '#172e56', color: '#e0f2fe', fontSize: 14, fontWeight: 800, cursor: 'pointer', textAlign: 'center', textDecoration: 'none' };

// Mounted with a visit key: leaving a client aborts link preparation and location reads.
export default function DispatchClientContact({ orderId, name, phone, code, messageText }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [location, setLocation] = useState(null), [locationError, setLocationError] = useState('');
  const [loading, setLoading] = useState(true);
  const controller = useRef(null), preparing = useRef(false), readController = useRef(null);
  const phoneHref = String(phone || '').replace(/[^\d+]/g, '');
  async function refreshLocation() {
    readController.current?.abort();
    const request = new AbortController(); readController.current = request;
    setLoading(true); setLocationError('');
    try {
      const result = await familyRequest({ action: 'GET_LOCATION', source: 'TRANSPORT', orderId: String(orderId) }, { signal: request.signal });
      if (!request.signal.aborted) setLocation(result.location);
    } catch {
      if (!request.signal.aborted) setLocationError('Lokacioni nuk u ngarkua. Prek Rifresko.');
    } finally { if (!request.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    void refreshLocation();
    return () => { controller.current?.abort(); readController.current?.abort(); };
  }, [orderId]);
  async function invite() {
    if (preparing.current) return;
    const request = new AbortController(); controller.current = request;
    preparing.current = true; setBusy(true); setError('');
    try {
      const result = await familyRequest({ action: 'SIGN_LINK', source: 'TRANSPORT', orderId: String(orderId) }, { signal: request.signal });
      if (request.signal.aborted) return;
      if (!result.token || !/^https:\/\/tepiha\.vercel\.app\/k\/s_[A-Za-z0-9_-]{22}$/.test(result.shortUrl || '')) throw new Error('LINK_UNAVAILABLE');
      setMessage(`Përshëndetje ${String(name || '').trim() || 'klient'}, shtoni emrat e telefonat e familjarëve dhe dërgoni lokacionin e tepihave këtu:\n${result.shortUrl}\nKompania JONI · ${code || ''}`.trim());
    } catch {
      if (!request.signal.aborted) setError('Linku nuk u përgatit. Kontrollo internetin dhe provo përsëri.');
    } finally { if (!request.signal.aborted) { preparing.current = false; setBusy(false); } }
  }
  const map = clientLocationMapUrl(location);
  return <section aria-label="Kontakti dhe linku i klientit" style={{ display: 'grid', gap: 10, marginTop: 14 }}>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }}>
      {phoneHref && <a href={`tel:${phoneHref}`} style={button}>Thirr klientin</a>}
      <button type="button" style={button} disabled={!phoneHref || busy} onClick={() => setMessage(messageText || '')}>Dërgo mesazh</button>
    </div>
    <button type="button" style={{ ...button, background: '#075985', textAlign: 'left' }} disabled={!phoneHref || busy} onClick={invite}>
      {busy ? 'Po përgatitet linku…' : 'Dërgo linkun: familjarë dhe lokacion'}
    </button>
    <div style={{ color: '#cbd5e1', fontSize: 12 }}>Klienti shton emrat, telefonat dhe adresën nga telefoni i vet.</div>
    {!phoneHref && <div role="status" style={{ color: '#fde68a' }}>Klientit i mungon numri i telefonit.</div>}
    {error && <div role="alert" style={{ color: '#fda4af' }}>{error}</div>}
    <div style={{ padding: 12, background: '#0b1223', border: '1px solid #334155', borderRadius: 12, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>Lokacioni nga klienti</strong>
        <button type="button" style={{ ...button, minHeight: 36, fontSize: 12, padding: '6px 10px' }} disabled={loading} onClick={refreshLocation}>Rifresko</button>
      </div>
      {loading ? <span style={{ fontSize: 12 }}>Po kontrollohet…</span> : locationError ? <span role="alert" style={{ color: '#fda4af', fontSize: 12 }}>{locationError}</span> : location ? <>
        {location.address && <span style={{ overflowWrap: 'anywhere' }}>{location.address}</span>}
        <span style={{ fontSize: 12, color: '#cbd5e1' }}>Dërguar më {new Date(location.created_at).toLocaleString('sq-AL', { timeZone: 'Europe/Belgrade' })}</span>
        {map && <a href={map} target="_blank" rel="noreferrer" style={button}>Hap lokacionin në hartë</a>}
      </> : <span style={{ fontSize: 12, color: '#cbd5e1' }}>Klienti ende s’ka dërguar lokacion për këtë porosi.</span>}
    </div>
    <SmartSmsModal isOpen={!!message} onClose={() => setMessage('')} phone={phone} messageText={message} />
  </section>;
}
