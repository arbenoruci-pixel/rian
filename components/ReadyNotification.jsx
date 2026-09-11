import { useEffect, useState } from 'react';
import SmartSmsModal from './SmartSmsModal';
import { notificationSummary } from '../lib/readyNotificationModel.js';
import { NOTIFICATION_CHANGE, currentNotificationActorId, localNotifications, fetchReadyNotifications, recordReadyNotification } from '../lib/readyNotifications.js';
export function useReadyNotifications(ids) {
  const [events,setEvents] = useState([]);
  const [status,setStatus] = useState('Duke lexuar lajmërimet…');
  const key = [...new Set(ids.map(String))].sort().join(',');
  useEffect(() => {
    let active = true;
    const loadLocal = () => { try { if (active) setEvents(localNotifications()); } catch { if (active) setStatus('Historia lokale nuk lexohet.'); } };
    const refresh = async () => {
      loadLocal();
      try { const result = await fetchReadyNotifications(key ? key.split(',') : []); if (active) setStatus(result?.offline ? 'Offline • historia e ruajtur në këtë telefon' : ''); }
      catch { if (active) setStatus('Historia nuk u rifreskua • provo kur të kthehet lidhja.'); }
    };
    void refresh();
    window.addEventListener(NOTIFICATION_CHANGE,loadLocal);
    window.addEventListener('focus',refresh);
    window.addEventListener('online',refresh);
    const timer = window.setInterval(refresh,60000);
    return () => { active=false; clearInterval(timer); window.removeEventListener(NOTIFICATION_CHANGE,loadLocal); window.removeEventListener('focus',refresh); window.removeEventListener('online',refresh); };
  },[key]);
  const forOrder = id => events.filter(e => String(e.order_id) === String(id));
  return { events, status, forOrder, summary: id => notificationSummary(forOrder(id)) };
}
export function ReadyNotificationBadge({ event, onClick }) {
  return <button type="button" onClick={onClick} style={{display:'block',background:'transparent',border:0,padding:'5px 0',textAlign:'left',fontSize:11,color:event?.kind==='confirmed'?'#86efac':'#fde68a'}}>
    {event?.kind==='confirmed' ? '✓ Dërgimi u konfirmua nga punëtori' : event?.kind==='opened' ? 'Mesazhi u hap • pa konfirmim dërgimi' : 'Pa konfirmim dërgimi'}
    {event ? <span style={{display:'block',fontSize:10}}>{event.author_name} • {event.channel.toUpperCase()} • {new Date(event.occurred_at).toLocaleString('sq-AL')} {event.pending?'• vetëm në këtë telefon':''}</span> : null}
  </button>;
}
export function TrackedReadySmsModal({ orderId, ...props }) {
  const history = useReadyNotifications(props.isOpen && orderId ? [orderId] : []);
  const [attempt,setAttempt] = useState(null);
  const [error,setError] = useState('');
  useEffect(() => { setAttempt(null); setError(''); },[orderId,props.isOpen]);
  const activeAttempt = attempt || notificationSummary(history.forOrder(orderId).filter(e => e.actor_id === currentNotificationActorId()));
  const record = (kind,channel,attemptId) => {
    try { const e = recordReadyNotification({orderId,kind,channel,attemptId}); setAttempt(e); setError(''); return true; }
    catch(e) { setError(e.message); return false; }
  };
  return <SmartSmsModal {...props} onAction={channel => record('opened',channel)}>
    <div style={{padding:12,border:'1px solid #475569',borderRadius:12,fontSize:12}}>
      <b>LAJMËRIMI “GATI”</b>
      <div>Pas dërgimit, kthehu këtu dhe konfirmo. Telefoni nuk na jep dëshmi automatike të dorëzimit.</div>
      {history.status ? <p>{history.status}</p> : null}
      {activeAttempt?.kind==='opened' ? <div style={{display:'flex',gap:8,marginTop:10}}>
        <button type="button" className="btn primary" onClick={() => record('confirmed',activeAttempt.channel,activeAttempt.attempt_id)}>E DËRGOVA</button>
        <button type="button" className="btn secondary" onClick={() => record('cancelled',activeAttempt.channel,activeAttempt.attempt_id)}>S’E DËRGOVA</button>
      </div> : null}
      {error ? <p role="alert" style={{color:'#fca5a5'}}>{error}</p> : null}
      {history.forOrder(orderId).slice().sort((a,b)=>Date.parse(b.occurred_at)-Date.parse(a.occurred_at)).slice(0,8).map(e => <div key={e.id} style={{marginTop:7}}>
        {e.kind==='confirmed'?'Konfirmoi dërgimin':e.kind==='cancelled'?'Nuk e dërgoi':'Hapi mesazhin'} • {e.author_name} • {e.channel.toUpperCase()} • {new Date(e.occurred_at).toLocaleString('sq-AL')}
        {e.pending?<div style={{color:'#fde68a'}}>Ruajtur në telefon • {e.sync_error?'sinkronizimi në pritje':'duke u sinkronizuar'}</div>:null}
      </div>)}
    </div>
  </SmartSmsModal>;
}
