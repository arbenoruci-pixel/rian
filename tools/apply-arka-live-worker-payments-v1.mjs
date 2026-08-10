import fs from 'node:fs';

const path = 'components/ArkaWorkerDailyStatus.jsx';
const marker = 'ARKA_LIVE_WORKER_PAYMENTS_V1';
let src = fs.readFileSync(path, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (src.includes(newText)) return;
  const count = src.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  src = src.replace(oldText, newText);
}

if (!src.includes(marker)) {
  replaceOnce(
    "import { useMemo } from 'react';\nimport '@/components/ArkaWorkerDailyStatus.css';",
    "import { useEffect, useMemo, useState } from 'react';\nimport '@/components/ArkaWorkerDailyStatus.css';\nimport { supabase } from '@/lib/supabaseClient';",
    'imports',
  );

  replaceOnce(
    "const CLOSED_STATUSES = new Set(['REJECTED', 'REFUZUAR', 'VOIDED', 'CANCELLED', 'CANCELED']);",
    "const CLOSED_STATUSES = new Set(['REJECTED', 'REFUZUAR', 'VOIDED', 'CANCELLED', 'CANCELED']);\nconst LIVE_PAYMENT_STATUSES = new Set(['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED']);\nconst NON_CASH_TYPES = new Set(['EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED', 'READY_48H_BONUS']);\n// ARKA_LIVE_WORKER_PAYMENTS_V1",
    'constants',
  );

  replaceOnce(
    "export default function ArkaWorkerDailyStatus({ snapshot, actor }) {\n  // ARKA_WORKER_DAILY_STATUS_V1:COMPONENT\n  const daily = useMemo(() => {",
    `export default function ArkaWorkerDailyStatus({ snapshot, actor }) {\n  // ARKA_WORKER_DAILY_STATUS_V1:COMPONENT\n  const [livePayments, setLivePayments] = useState([]);\n\n  useEffect(() => {\n    const pin = String(actor?.pin || '').trim();\n    if (!pin) { setLivePayments([]); return undefined; }\n    let cancelled = false;\n    let timer = null;\n\n    const load = async () => {\n      try {\n        const { data, error } = await supabase\n          .from('arka_pending_payments')\n          .select('id,amount,type,status,note,client_name,client_phone,order_code,transport_order_id,transport_code_str,transport_m2,source_module,created_by_pin,created_by_name,created_at,updated_at,handed_at')\n          .eq('created_by_pin', pin)\n          .order('created_at', { ascending: false })\n          .limit(120);\n        if (error) throw error;\n        if (!cancelled) setLivePayments(Array.isArray(data) ? data : []);\n      } catch {\n        // Keep the snapshot visible if the live refresh is temporarily unavailable.\n      }\n    };\n\n    const onVisible = () => { if (document.visibilityState !== 'hidden') load(); };\n    load();\n    timer = window.setInterval(load, 15000);\n    window.addEventListener('focus', load);\n    window.addEventListener('pageshow', load);\n    document.addEventListener('visibilitychange', onVisible);\n    return () => {\n      cancelled = true;\n      if (timer) window.clearInterval(timer);\n      window.removeEventListener('focus', load);\n      window.removeEventListener('pageshow', load);\n      document.removeEventListener('visibilitychange', onVisible);\n    };\n  }, [actor?.pin]);\n\n  const daily = useMemo(() => {`,
    'live refresh effect',
  );

  replaceOnce(
    "    const expenseRows = uniqueRows(snapshot?.allExtraRows)",
    `    const liveCashRows = uniqueRows(livePayments)\n      .map((row) => row?.raw || row)\n      .filter((row) => LIVE_PAYMENT_STATUSES.has(upper(row?.status)))\n      .filter((row) => !NON_CASH_TYPES.has(upper(row?.type)))\n      .filter((row) => isToday(row?.created_at, today));\n\n    const paymentActivityRows = uniqueRows([\n      ...cashRows.map((row) => row?.raw || row),\n      ...liveCashRows,\n    ])\n      .map((row) => row?.raw || row)\n      .filter((row) => isToday(row?.created_at, today))\n      .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));\n\n    const expenseRows = uniqueRows(snapshot?.allExtraRows)`,
    'live cash merge',
  );

  replaceOnce(
    "      cashRows,\n      expenseRows,",
    "      cashRows,\n      paymentActivityRows,\n      expenseRows,",
    'return activity rows',
  );

  replaceOnce(
    "      cashGross: sum(cashRows, (row) => row?.gross ?? row?.raw?.amount),",
    "      cashGross: sum(paymentActivityRows, (row) => row?.amount ?? row?.raw?.amount ?? row?.gross),",
    'live cash gross',
  );

  replaceOnce(
    "  }, [snapshot]);\n\n  const movementCount = daily.cashRows.length + daily.expenseRows.length;",
    "  }, [snapshot, livePayments]);\n\n  const movementCount = daily.paymentActivityRows.length + daily.expenseRows.length;",
    'memo dependency and count',
  );

  replaceOnce(
    "          sub={`${daily.cashRows.length} PAGESA`}",
    "          sub={`${daily.paymentActivityRows.length} PAGESA`}",
    'payment metric count',
  );

  replaceOnce(
    "      {daily.expenseRows.length ? (",
    `      {daily.paymentActivityRows.length ? (\n        <div className="arkaDailyExpenseBox">\n          <div className="arkaDailyExpenseHead">\n            <span>PAGESAT E SOTME</span>\n            <b>{daily.paymentActivityRows.length}</b>\n          </div>\n          <div className="arkaDailyExpenseList">\n            {daily.paymentActivityRows.slice(0, 12).map((row) => {\n              const code = String(row?.transport_code_str || row?.order_code || '—').trim().toUpperCase();\n              const client = String(row?.client_name || 'KLIENT').trim().toUpperCase();\n              return (\n                <div className="arkaDailyExpenseRow" key={\`daily_payment_\${row?.id || row?.created_at}\`}>\n                  <div>\n                    <strong>{code} • {client}</strong>\n                    <small>{stamp(row?.created_at)} • {statusLabel(row?.status)}</small>\n                  </div>\n                  <div className="arkaDailyExpenseRight">\n                    <b>{euro(row?.amount)}</b>\n                    <span className={\`arkaDailyStatusPill \${statusTone(row?.status)}\`}>{statusLabel(row?.status)}</span>\n                  </div>\n                </div>\n              );\n            })}\n          </div>\n        </div>\n      ) : null}\n\n      {daily.expenseRows.length ? (`,
    'live payment list',
  );
}

fs.writeFileSync(path, src, 'utf8');
const out = fs.readFileSync(path, 'utf8');
for (const token of [marker, "from('arka_pending_payments')", 'PAGESAT E SOTME', 'paymentActivityRows', 'window.setInterval(load, 15000)']) {
  if (!out.includes(token)) throw new Error(`missing live payment token: ${token}`);
}
console.log('PASS worker ARKA live payments refresh and visible payment list installed');
