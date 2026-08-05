import fs from 'node:fs';

const PAGE = 'app/page.jsx';
const MARKER = 'HOME_SCREEN_PAYMENT_RECEIPT_SMS_V1';
let source = fs.readFileSync(PAGE, 'utf8');

if (!source.includes(MARKER)) {
  const helperAnchor = `function cleanClientCode(value) {\n  return String(value || '').replace(/^#+/, '').trim();\n}`;
  if (!source.includes(helperAnchor)) throw new Error('HOME_SMS_HELPER_ANCHOR_MISSING');

  const helpers = `\n\n// ${MARKER}\nfunction normalizeReceiptPhone(value) {\n  const digits = String(value || '').replace(/\\D+/g, '');\n  if (!digits) return '';\n  if (digits.startsWith('383')) return '+' + digits;\n  if (digits.startsWith('0')) return '+383' + digits.slice(1);\n  return '+' + digits;\n}\n\nfunction sendPaymentReceiptSms(result, event) {\n  event?.preventDefault?.();\n  event?.stopPropagation?.();\n  const phone = normalizeReceiptPhone(result?.phone);\n  const paid = Math.max(0, Number(result?.paidAmount || 0));\n  if (!phone) return window.alert('Klienti nuk ka numër telefoni.');\n  if (!(paid > 0)) return window.alert('Nuk u gjet pagesa e fundit për këtë porosi.');\n  const balance = Math.max(0, Number(result?.balanceAmount || 0));\n  const code = cleanClientCode(result?.clientCode || result?.code || '');\n  const name = String(result?.name || 'klient').trim() || 'klient';\n  const rawDate = result?.paymentDate ? new Date(result.paymentDate) : new Date();\n  const date = Number.isFinite(rawDate.getTime())\n    ? rawDate.toLocaleDateString('sq-AL', { day: '2-digit', month: '2-digit', year: 'numeric' })\n    : new Date().toLocaleDateString('sq-AL');\n  const text = [\n    'Përshëndetje ' + name + ',',\n    'Ju konfirmojmë se për tepihat me kod ' + (code || '—') + ' keni paguar ' + paid.toFixed(2) + ' € më ' + date + '.',\n    balance > 0 ? 'Borxhi i mbetur: ' + balance.toFixed(2) + ' €.' : 'Pagesa është përfunduar plotësisht.',\n    '',\n    'Faleminderit, KOMPANIA JONI'\n  ].join('\\n');\n  window.location.href = 'sms:' + phone + '?&body=' + encodeURIComponent(text);\n}`;

  source = source.replace(helperAnchor, helperAnchor + helpers);

  const actionAnchor = `                        <div className="result-actions">\n                          {isBaseResult(result) ? (`;
  if (!source.includes(actionAnchor)) throw new Error('HOME_SMS_ACTION_ANCHOR_MISSING');
  source = source.replace(actionAnchor, `                        <div className="result-actions">\n                          {result?.phone && Number(result?.paidAmount || 0) > 0 ? (\n                            <button className="new-order-btn" type="button" onClick={(event) => sendPaymentReceiptSms(result, event)}>\n                              📩 SMS PAGESA\n                            </button>\n                          ) : null}\n                          {isBaseResult(result) ? (`);

  fs.writeFileSync(PAGE, source, 'utf8');
}

console.log('[home-screen-payment-receipt-sms-v1] installed');
