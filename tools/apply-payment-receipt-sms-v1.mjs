import fs from 'node:fs';

const PAGE = 'app/pastrimi/page.jsx';
const MARKER = 'PAYMENT_RECEIPT_SMS_V1';
let source = fs.readFileSync(PAGE, 'utf8');
if (source.includes(MARKER)) {
  console.log('[payment-receipt-sms] already installed');
  process.exit(0);
}

const stateAnchor = "  const [rowPayBusy, setRowPayBusy] = useState(false);";
if (!source.includes(stateAnchor)) throw new Error('PAYMENT_SMS_STATE_ANCHOR_NOT_FOUND');
source = source.replace(stateAnchor, `${stateAnchor}\n  // ${MARKER}\n  const [paymentSmsReceipt, setPaymentSmsReceipt] = useState(null);`);

const successAnchor = `          setRowPaySheet(false);\n          setRowPayOrder(null);\n          setRowPayAmount(0);\n          alert('✅ PAGESA U REGJISTRUA.');`;
if (!source.includes(successAnchor)) throw new Error('PAYMENT_SMS_SUCCESS_ANCHOR_NOT_FOUND');
source = source.replace(successAnchor, `          setPaymentSmsReceipt({\n            code: String(rowPayOrder?.code || rowPayOrder?.order_code || rowPayOrder?.fullOrder?.code || '').replace(/^T/i, ''),\n            name: String(rowPayOrder?.name || rowPayOrder?.client_name || rowPayOrder?.fullOrder?.client_name || rowPayOrder?.fullOrder?.client?.name || 'Klient').trim(),\n            phone: String(rowPayOrder?.phone || rowPayOrder?.client_phone || rowPayOrder?.fullOrder?.client_phone || rowPayOrder?.fullOrder?.client?.phone || '').trim(),\n            amount: Number(rowPayAmount || 0),\n          });\n          setRowPaySheet(false);\n          setRowPayOrder(null);\n          setRowPayAmount(0);`);

const modalAnchor = `      {rowPaySheet && rowPayOrder && (`;
if (!source.includes(modalAnchor)) throw new Error('PAYMENT_SMS_MODAL_ANCHOR_NOT_FOUND');
const receiptUi = `      {paymentSmsReceipt ? (\n        <div style={{ position: 'fixed', left: 8, right: 8, bottom: 'max(10px, env(safe-area-inset-bottom))', zIndex: 100500, borderRadius: 20, border: '1px solid rgba(34,197,94,.55)', background: 'linear-gradient(145deg,#052e24,#071a17)', boxShadow: '0 18px 60px rgba(0,0,0,.72)', padding: 15, color: '#fff' }}>\n          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>\n            <div>\n              <div style={{ color: '#86efac', fontSize: 12, fontWeight: 950, letterSpacing: 1.5 }}>PAGESA U REGJISTRUA</div>\n              <div style={{ marginTop: 5, fontSize: 21, fontWeight: 950 }}>{Number(paymentSmsReceipt.amount || 0).toFixed(2)} € • Kodi {paymentSmsReceipt.code || '—'}</div>\n              <div style={{ marginTop: 3, color: '#cbd5e1' }}>{paymentSmsReceipt.name}</div>\n            </div>\n            <button type=\"button\" onClick={() => setPaymentSmsReceipt(null)} style={{ width: 42, height: 42, borderRadius: 13, border: '1px solid #355047', background: '#0b1f1a', color: '#fff', fontSize: 22 }}>×</button>\n          </div>\n          <button\n            type=\"button\"\n            disabled={!String(paymentSmsReceipt.phone || '').trim()}\n            onClick={() => {\n              const phone = String(paymentSmsReceipt.phone || '').replace(/[^+\\d]/g, '');\n              const amount = Number(paymentSmsReceipt.amount || 0).toFixed(2);\n              const code = String(paymentSmsReceipt.code || '').trim();\n              const name = String(paymentSmsReceipt.name || 'Klient').trim();\n              const text = \`Pershendetje \\${name}, pagesa juaj prej \\${amount} € per porosine me kodin \\${code} u regjistrua me sukses. Faleminderit!\`;\n              if (!phone) return;\n              window.location.href = \`sms:\\${phone}?&body=\\${encodeURIComponent(text)}\`;\n            }}\n            style={{ width: '100%', minHeight: 56, marginTop: 13, borderRadius: 17, border: 0, background: String(paymentSmsReceipt.phone || '').trim() ? '#22c55e' : '#334155', color: '#04130a', fontSize: 18, fontWeight: 950 }}\n          >\n            {String(paymentSmsReceipt.phone || '').trim() ? 'DËRGO SMS TË PAGESËS' : 'KLIENTI NUK KA TELEFON'}\n          </button>\n        </div>\n      ) : null}\n\n`;
source = source.replace(modalAnchor, receiptUi + modalAnchor);

fs.writeFileSync(PAGE, source, 'utf8');
console.log('[payment-receipt-sms] installed');
