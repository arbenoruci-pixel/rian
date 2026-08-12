import fs from 'node:fs';

const path = 'app/arka/puntor/[pin]/page.jsx';
const marker = 'ADMIN_WORKER_DETAIL_STRAIGHT_SALARY_V1';
let src = fs.readFileSync(path, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (src.includes(newText)) return;
  const count = src.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  src = src.replace(oldText, newText);
  console.log(`PATCH ${label}`);
}

if (!src.includes(marker)) {
  replaceOnce(
    "function buildCashDueRow(row, { transportOrdersById = {}, commissionRateM2 = 0.5 } = {}) {\n  const isTransport = isTransportPaymentRow(row);\n  const gross = n(row?.amount);\n  const m2 = isTransport ? readPaymentTransportM2(row, transportOrdersById) : 0;\n  const commission = isTransport ? +(m2 * n(commissionRateM2)).toFixed(2) : 0;",
    `function buildCashDueRow(row, { transportOrdersById = {}, commissionRateM2 = 0, isHybridTransport = false } = {}) {\n  // ${marker}: commission exists only for explicitly hybrid workers.\n  const isTransport = isTransportPaymentRow(row);\n  const gross = n(row?.amount);\n  const m2 = isTransport ? readPaymentTransportM2(row, transportOrdersById) : 0;\n  const commission = isTransport && isHybridTransport ? +(m2 * n(commissionRateM2)).toFixed(2) : 0;`,
    'cash due hybrid gate',
  );

  replaceOnce(
    "    const commissionRate = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;\n    const dueOptions = {\n      transportOrdersById: transportOrdersById && typeof transportOrdersById === 'object' ? transportOrdersById : {},\n      commissionRateM2: commissionRate,\n    };",
    "    const isHybridTransport = worker?.is_hybrid_transport === true || String(worker?.is_hybrid_transport || '').toLowerCase() === 'true';\n    const commissionRate = isHybridTransport && n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0;\n    const dueOptions = {\n      transportOrdersById: transportOrdersById && typeof transportOrdersById === 'object' ? transportOrdersById : {},\n      commissionRateM2: commissionRate,\n      isHybridTransport,\n    };",
    'admin detail authoritative worker finance flags',
  );

  replaceOnce(
    "  }, [payments, extras, pin, worker?.commission_rate_m2, transportOrdersById]);",
    "  }, [payments, extras, pin, worker?.commission_rate_m2, worker?.is_hybrid_transport, transportOrdersById]);",
    'cash account hybrid dependency',
  );
}

fs.writeFileSync(path, src, 'utf8');
const out = fs.readFileSync(path, 'utf8');
for (const token of [marker, 'isTransport && isHybridTransport', 'commissionRateM2: commissionRate,', 'isHybridTransport,']) {
  if (!out.includes(token)) throw new Error(`VERIFY_MISSING ${token}`);
}
console.log('PASS admin worker detail respects straight salary and zero commission');
