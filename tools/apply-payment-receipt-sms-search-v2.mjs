import fs from 'node:fs';

const HOME = 'lib/homeSearch.js';
const SEARCH = 'components/GlobalHomeSearch.jsx';
const MARKER = 'PAYMENT_RECEIPT_SMS_SEARCH_V2';

let home = fs.readFileSync(HOME, 'utf8');
if (!home.includes(MARKER)) {
  const statusAnchor = `function pickStatus(row) {\n  const data = unwrapData(row);\n  return pickFirst(row?.status, data?.status, row?.state, data?.state);\n}`;
  if (!home.includes(statusAnchor)) throw new Error('PAYMENT_SMS_SEARCH_STATUS_ANCHOR_MISSING');
  home = home.replace(statusAnchor, `${statusAnchor}\n\n// ${MARKER}\nfunction pickPaymentNumber(...values) {\n  for (const value of values) {\n    if (value == null || value === '') continue;\n    const parsed = Number(String(value).replace(',', '.').replace(/[^0-9.-]/g, ''));\n    if (Number.isFinite(parsed)) return Math.max(0, +parsed.toFixed(2));\n  }\n  return 0;\n}\n\nfunction pickPaymentReceipt(row) {\n  const data = unwrapData(row);\n  const pay = safeObject(data?.pay || row?.pay);\n  const total = pickPaymentNumber(row?.total, row?.total_amount, row?.amount, data?.total, data?.total_amount, data?.amount, pay?.total, pay?.total_amount);\n  const paid = pickPaymentNumber(row?.last_payment_amount, data?.last_payment_amount, pay?.last_payment_amount, row?.paid_amount, row?.amount_paid, row?.paid_total, row?.paid, data?.paid_amount, data?.amount_paid, data?.paid_total, data?.paid, pay?.paid_amount, pay?.amount_paid, pay?.paid_total, pay?.paid);\n  const explicitDebt = pickPaymentNumber(row?.balance, row?.remaining, row?.debt, row?.borxh, data?.balance, data?.remaining, data?.debt, data?.borxh, pay?.balance, pay?.remaining, pay?.debt, pay?.borxh);\n  const balance = explicitDebt > 0 ? explicitDebt : Math.max(0, +(total - paid).toFixed(2));\n  const date = pickFirst(row?.last_payment_at, data?.last_payment_at, pay?.last_payment_at, row?.paid_at, data?.paid_at, pay?.paid_at, row?.delivered_at, data?.delivered_at, row?.updated_at, data?.updated_at);\n  return { total, paid, balance, date };\n}`);

  const beforeReturn = `  const cleanTransporter = cleanVisiblePersonName(transporter);\n  return {`;
  if (!home.includes(beforeReturn)) throw new Error('PAYMENT_SMS_SEARCH_RETURN_ANCHOR_MISSING');
  home = home.replace(beforeReturn, `  const cleanTransporter = cleanVisiblePersonName(transporter);\n  const paymentReceipt = pickPaymentReceipt(row);\n  return {`);
  const phoneAnchor = `    phone: pickPhone(row),\n    address: pickAddress(row),`;
  if (!home.includes(phoneAnchor)) throw new Error('PAYMENT_SMS_SEARCH_PHONE_ANCHOR_MISSING');
  home = home.replace(phoneAnchor, `    phone: pickPhone(row),\n    paidAmount: paymentReceipt.paid,\n    balanceAmount: paymentReceipt.balance,\n    paymentDate: paymentReceipt.date,\n    address: pickAddress(row),`);
  fs.writeFileSync(HOME, home, 'utf8');
}

let search = fs.readFileSync(SEARCH, 'utf8');
if (!search.includes(MARKER)) {
  const labelStart = search.indexOf('function resultCodeLabel(result) {');
  if (labelStart < 0) throw new Error('PAYMENT_SMS_SEARCH_LABEL_MISSING');
  const labelEnd = search.indexOf('\n}\n', labelStart);
  if (labelEnd < 0) throw new Error('PAYMENT_SMS_SEARCH_LABEL_END_MISSING');
  const helpers = `\n// ${MARKER}\nfunction normalizeReceiptPhone(value) {\n  const digits = String(value || '').replace(/\\D+/g, '');\n  if (!digits) return '';\n  if (digits.startsWith('383')) return '+' + digits;\n  if (digits.startsWith('0')) return '+383' + digits.slice(1);\n  return '+' + digits;\n}\n\nfunction sendPaymentReceiptSms(result, event) {\n  event?.preventDefault?.();\n  event?.stopPropagation?.();\n  const phone = normalizeReceiptPhone(result?.phone);\n  const paid = Math.max(0, Number(result?.paidAmount || 0));\n  if (!phone) return window.alert('Klienti nuk ka numër telefoni.');\n  if (!(paid > 0)) return window.alert('Nuk u gjet pagesa e fundit për këtë porosi.');\n  const balance = Math.max(0, Number(result?.balanceAmount || 0));\n  const code = cleanClientCode(result?.clientCode || result?.code || '');\n  const name = safeText(result?.name, 'klient');\n  const rawDate = result?.paymentDate ? new Date(result.paymentDate) : new Date();\n  const date = Number.isFinite(rawDate.getTime()) ? rawDate.toLocaleDateString('sq-AL', { day: '2-digit', month: '2-digit', year: 'numeric' }) : new Date().toLocaleDateString('sq-AL');\n  const text = [\n    'Përshëndetje ' + name + ',',\n    'Ju konfirmojmë se për tepihat me kod ' + (code || '—') + ' keni paguar ' + paid.toFixed(2) + ' € më ' + date + '.',\n    balance > 0 ? 'Borxhi i mbetur: ' + balance.toFixed(2) + ' €.' : 'Pagesa është përfunduar plotësisht.',\n    '',\n    'Faleminderit, KOMPANIA JONI'\n  ].join('\\n');\n  window.location.href = 'sms:' + phone + '?&body=' + encodeURIComponent(text);\n}\n`;
  search = search.slice(0, labelEnd + 3) + helpers + search.slice(labelEnd + 3);

  const actionAnchor = `                        <div className="ghs-actions">\n                          {isBaseResult(result) ? (`;
  if (!search.includes(actionAnchor)) throw new Error('PAYMENT_SMS_SEARCH_ACTION_ANCHOR_MISSING');
  search = search.replace(actionAnchor, `                        <div className="ghs-actions">\n                          {result?.phone && Number(result?.paidAmount || 0) > 0 ? (\n                            <button type="button" className="ghs-new-order" onClick={(event) => sendPaymentReceiptSms(result, event)}>\n                              📩 SMS PAGESA\n                            </button>\n                          ) : null}\n                          {isBaseResult(result) ? (`);
  fs.writeFileSync(SEARCH, search, 'utf8');
}

console.log('[payment-receipt-sms-search-v2] installed');
