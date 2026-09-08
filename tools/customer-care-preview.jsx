import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import CustomerCare, { PaymentCustomerCare } from '../components/CustomerCare.jsx';
import DispatchMeasurements from '../components/DispatchMeasurements.jsx';
import { fixtureOrder } from './customer-care-fixtures.mjs';

function Preview() {
  const [driver, setDriver] = useState(false);
  const [payment, setPayment] = useState(false);
  const [closed, setClosed] = useState(false);
  const [row, setRow] = useState(fixtureOrder);
  const [measures, setMeasures] = useState({ tepiha: row.data.tepiha, staza: [], shkallore: { qty: 0, per: .3 } });
  const [result, setResult] = useState('');
  async function role(next) { await fetch('/test/role', { method: 'POST', body: next ? 'driver' : 'dispatch' }); setDriver(next); setClosed(false); }
  async function saveMeasures() {
    const res = await fetch('/test/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: row.id, expectedUpdatedAt: row.updated_at, name: 'Klient Test', address: 'Adresë Test', note: 'Ndryshim mase', measurements: measures }) });
    const body = await res.json();
    if (body.order) { setRow(body.order); setResult(`U ruajt: ${body.order.status} · punëtori ${body.order.data.worker_pin} · shoferi ${body.order.data.transport_name} · ${body.order.data.pay.euro} €`); }
    else setResult(body.error);
  }
  return <main style={{ maxWidth: 390, margin: '20px auto', color: '#f8fafc', fontFamily: 'Arial', padding: 12 }}><h1>Test lokal · të dhëna fiktive</h1><p>Asnjë pagesë ose klient real.</p><button onClick={() => role(false)}>DISPATCH TEST</button> <button onClick={() => role(true)}>SHOFER TEST</button><p>Roli: {driver ? 'SHOFER' : 'DISPATCH'}</p>{driver ? <><button onClick={() => { setPayment(true); setClosed(false); }}>Simulo pagesën e konfirmuar</button>{closed ? <p role="status">U kthye te lista. Pagesa mbeti e konfirmuar.</p> : null}{payment ? <PaymentCustomerCare orderId={row.id} onClose={() => { setPayment(false); setClosed(true); }} /> : null}</> : <><CustomerCare key="dispatch" clientId={row.client_id} /><DispatchMeasurements value={measures} onChange={setMeasures} /><button onClick={saveMeasures}>RUAJ MASAT TEST</button><p role="status">{result}</p></>}</main>;
}
createRoot(document.getElementById('root')).render(<Preview />);
