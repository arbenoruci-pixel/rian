import { lazy, Suspense, useEffect, useState } from 'react';
import { familyRequest } from '../lib/clientFamilyClient.js';
const ClientProfileSheet = lazy(() => import('./ClientProfileSheet.jsx'));
export default function FamilySearchResults({ query }) {
  const [revision, setRevision] = useState(0);
  useEffect(() => { const refresh = () => setRevision(v => v + 1); window.addEventListener('tepiha:client-family:updated', refresh); return () => window.removeEventListener('tepiha:client-family:updated', refresh); }, []);
  const [items, setItems] = useState([]);
  const [anchor, setAnchor] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    const q = String(query || '').trim();
    if (!q) return () => controller.abort();
    const timer = setTimeout(() => familyRequest({ action: 'SEARCH', query: q }, { signal: controller.signal }).then(r => {
      if (!controller.signal.aborted) setItems((r.items || []).filter(h => h.family.members.length > 1 || h.family.contacts.length));
    }).catch(() => {}), 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, revision]);
  return <>
    {items.length > 0 && <div aria-label="Kartelat familjare" style={{ marginTop: 12, display: 'grid', gap: 8 }}>
      <strong>KARTELAT FAMILJARE</strong>
      {items.map(hit => <button key={hit.key} type="button" onClick={() => setAnchor({ source: hit.source, client_id: hit.clientId, name: hit.name, phone: hit.phone, code: hit.code })} style={{ padding: 12, borderRadius: 12, background: '#0f172a', color: '#f1f5f9', border: '1px solid #475569', textAlign: 'left' }}>
        <strong>{hit.name}</strong><br />Kodet: {hit.family.members.map(m => `${m.source === 'BASE' ? 'Bazë' : 'Transport'} ${m.code}`).join(' · ')}<br />Hap kartelën e familjes
      </button>)}
    </div>}
    {anchor && <Suspense fallback={null}><ClientProfileSheet open anchor={anchor} onClose={() => setAnchor(null)} /></Suspense>}
  </>;
}
