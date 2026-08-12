import fs from 'node:fs';

const ARKA_PATH = 'app/arka/page.jsx';
const DAILY_PATH = 'components/ArkaWorkerDailyStatus.jsx';
const WIZARD_PATH = 'components/HandoffWizard.jsx';
const PAY_PATH = 'app/transport/pay/page.jsx';
const API_PATH = 'app/api/arka/transaction/route.js';
const MARKER = 'BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  console.log(`PATCH ${label}`);
  return source.replace(oldText, newText);
}

function scanMatching(source, start, openChar, closeChar) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1] || '';
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    if (ch === closeChar && --depth === 0) return i;
  }
  return -1;
}

function functionRange(source, name) {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`${name}: function not found`);
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanMatching(source, paramsStart, '(', ')');
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart])) bodyStart += 1;
  const bodyEnd = scanMatching(source, bodyStart, '{', '}');
  if (paramsEnd < 0 || source[bodyStart] !== '{' || bodyEnd < 0) throw new Error(`${name}: invalid function range`);
  return { start: match.index, end: bodyEnd + 1 };
}

function replaceNamedFunction(source, name, nextFunction) {
  if (source.includes(nextFunction)) return source;
  const range = functionRange(source, name);
  console.log(`PATCH function ${name}`);
  return `${source.slice(0, range.start)}${nextFunction}${source.slice(range.end)}`;
}

function patchArkaPage() {
  let source = fs.readFileSync(ARKA_PATH, 'utf8');
  if (!source.includes(`${MARKER}:ARKA_PROFILE`)) {
    source = replaceNamedFunction(source, 'reconcileActorWithUser', `function reconcileActorWithUser(actor, userRow) {
  // ${MARKER}:ARKA_PROFILE — DB finance flags are authoritative; stale PWA data cannot restore commission.
  if (!actor) return actor;
  if (!userRow || typeof userRow !== 'object') return actor;
  const hasDbHybridFlag = Object.prototype.hasOwnProperty.call(userRow, 'is_hybrid_transport');
  const nextIsHybrid = hasDbHybridFlag ? isHybridWorker(userRow) : isHybridWorker(actor);
  const dbCommissionRaw = [
    userRow?.commission_rate_m2,
    userRow?.commissionRateM2,
    userRow?.transport_commission_rate_m2,
    userRow?.transportCommissionRateM2,
  ].find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  const parsedDbCommission = Number(dbCommissionRaw);
  const actorCommission = firstPositiveNumber(
    actor?.commission_rate_m2,
    actor?.commissionRateM2,
    actor?.transport_commission_rate_m2,
    actor?.transportCommissionRateM2
  );
  const nextCommissionRate = nextIsHybrid
    ? (Number.isFinite(parsedDbCommission) ? Math.max(0, parsedDbCommission) : (actorCommission > 0 ? actorCommission : 0.5))
    : 0;
  return {
    ...actor,
    pin: String(userRow?.pin || actor?.pin || '').trim(),
    name: String(userRow?.name || actor?.name || '').trim(),
    role: String(userRow?.role || actor?.role || '').trim(),
    user_id: userRow?.id || actor?.user_id || actor?.id || null,
    id: userRow?.id || actor?.id || actor?.user_id || null,
    is_hybrid_transport: nextIsHybrid,
    commission_rate_m2: nextCommissionRate,
    transport_id: userRow?.transport_id || actor?.transport_id || null,
  };
}`);
  }
  source = replaceOnce(
    source,
    "  const visibleCommission = n(item?.visibleCommissionHistoryTotal ?? item?.commissionHeldTotal);\n  const clientCount = cashRows.length || historyRows.length || (Array.isArray(item?.collectedRows) ? item.collectedRows.length : 0);",
    "  const visibleCommission = n(item?.visibleCommissionHistoryTotal ?? item?.commissionHeldTotal);\n  const workerHybrid = isHybridWorker(item?.worker || {});\n  const clientCount = cashRows.length || historyRows.length || (Array.isArray(item?.collectedRows) ? item.collectedRows.length : 0);",
    'manager straight-salary flag',
  );
  source = replaceOnce(
    source,
    "        <Stat label={`KOMISION ${workerFirstName.toUpperCase()}`} value={euro(visibleCommission)} tone=\"warn\" small />",
    "        {workerHybrid ? <Stat label={`KOMISION ${workerFirstName.toUpperCase()}`} value={euro(visibleCommission)} tone=\"warn\" small /> : null}",
    'hide manager commission',
  );
  source = replaceOnce(
    source,
    `                  <div className="arkaWorkerFoot" style={{ alignItems: 'center', gap: 10 }}>
                    <span>Komisioni im</span>
                    <b>{euro(workerCommissionTotal)}</b>
                  </div>`,
    `                  {workerIsHybrid ? (
                    <div className="arkaWorkerFoot" style={{ alignItems: 'center', gap: 10 }}>
                      <span>Komisioni im</span>
                      <b>{euro(workerCommissionTotal)}</b>
                    </div>
                  ) : null}`,
    'hide expanded commission',
  );
  source = replaceOnce(
    source,
    "              <div className=\"arkaSectionTitle\">DORËZO TE DISPATCH</div>",
    "              <div className=\"arkaSectionTitle\">DORËZO TE DISPATCH</div>\n              <div className=\"arkaSectionSub\">KËTU HYJNË VETËM PAGESAT E RUAJTURA NË ARKA. POROSIA ‘PËR PAGESË’ NË TRANSPORT ENDE NUK ËSHTË CASH I REGJISTRUAR.</div>",
    'clarify cash versus route debt',
  );
  fs.writeFileSync(ARKA_PATH, source, 'utf8');
}

function patchDailyStatus() {
  let source = fs.readFileSync(DAILY_PATH, 'utf8');
  if (!source.includes(`${MARKER}:DAILY`)) {
    source = replaceOnce(
      source,
      "  const movementCount = daily.paymentActivityRows.length + daily.expenseRows.length;\n  const workerName = String(actor?.name || snapshot?.worker?.name || 'PUNTORI').trim().toUpperCase();",
      "  const movementCount = daily.paymentActivityRows.length + daily.expenseRows.length;\n  const workerName = String(actor?.name || snapshot?.worker?.name || 'PUNTORI').trim().toUpperCase();\n  const workerHybrid = snapshot?.worker?.is_hybrid_transport === true || String(snapshot?.worker?.is_hybrid_transport || '').toLowerCase() === 'true';\n  // BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:DAILY",
      'daily hybrid flag',
    );
    source = replaceOnce(
      source,
      `        <Metric
          label="KOMISIONI IM SOT"
          value={euro(daily.commission)}
          sub={\`PËR BAZË NGA PAGESAT: \${euro(daily.cashForBase)}\`}
          tone="info"
        />`,
      `        {workerHybrid ? (
          <Metric label="KOMISIONI IM SOT" value={euro(daily.commission)} sub={\`PËR BAZË NGA PAGESAT: \${euro(daily.cashForBase)}\`} tone="info" />
        ) : (
          <Metric label="CASH PËR BAZË SOT" value={euro(daily.cashForBase)} sub="RROGË FIKSE • PA KOMISION" tone="info" />
        )}`,
      'daily salary metric',
    );
  }
  fs.writeFileSync(DAILY_PATH, source, 'utf8');
}

function patchHandoffWizard() {
  let source = fs.readFileSync(WIZARD_PATH, 'utf8');
  if (!source.includes(`${MARKER}:WIZARD`)) {
    source = replaceOnce(
      source,
      "  const safeGross = Math.max(0, Number(grossTotal || 0));\n  const safeCommission = Math.max(0, Number(commissionTotal || 0));\n  const safeBase = Math.max(0, Number(baseTotal || (safeGross - safeCommission) || 0));",
      "  const safeGross = Math.max(0, Number(grossTotal || 0));\n  const workerHybrid = actor?.is_hybrid_transport === true || String(actor?.is_hybrid_transport || '').toLowerCase() === 'true';\n  const safeCommission = workerHybrid ? Math.max(0, Number(commissionTotal || 0)) : 0;\n  const safeBase = Math.max(0, Number(baseTotal || (safeGross - safeCommission) || 0));\n  // BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:WIZARD",
      'wizard salary commission gate',
    );
    source = replaceOnce(
      source,
      "            <SummaryLine label=\"Komision transporti që e mban\" value={money(safeCommission)} accent=\"#ffd166\" />",
      "            {workerHybrid ? <SummaryLine label=\"Komision transporti që e mban\" value={money(safeCommission)} accent=\"#ffd166\" /> : null}",
      'wizard summary commission visibility',
    );
    source = replaceOnce(
      source,
      "            <Row label=\"Komisioni që e mban\" value={safeCommission > 0 ? `− ${money(safeCommission)}` : '0.00 €'} accent=\"#ffd166\" />",
      "            {workerHybrid ? <Row label=\"Komisioni që e mban\" value={safeCommission > 0 ? `− ${money(safeCommission)}` : '0.00 €'} accent=\"#ffd166\" /> : null}",
      'wizard final commission visibility',
    );
  }
  fs.writeFileSync(WIZARD_PATH, source, 'utf8');
}

function patchTransportPay() {
  let source = fs.readFileSync(PAY_PATH, 'utf8');
  if (!source.includes(`${MARKER}:TRANSPORT_PAY`)) {
    source = replaceOnce(
      source,
      "import { getTransportSession } from \"@/lib/transportAuth\";",
      "import { getTransportSession } from \"@/lib/transportAuth\";\nimport { getActor } from '@/lib/actorSession';\nimport { resolveActorPin } from '@/lib/pinIdentity';",
      'canonical PIN imports',
    );
    source = replaceNamedFunction(source, 'getActorPin', `function getActorPin(session) {
  // ${MARKER}:TRANSPORT_PAY — a UUID/transport_id is never a worker PIN.
  const sessionPin = resolveActorPin(session || {});
  if (sessionPin) return sessionPin;
  return resolveActorPin(getActor() || {});
}`);
    source = replaceOnce(
      source,
      "    } catch (e) {\n      alert(translateTransportDbError(e));\n    } finally {",
      "    } catch (e) {\n      const message = translateTransportDbError(e);\n      try { console.error('[TRANSPORT_PAYMENT_FAILED]', { orderId: row?.id || id, code: row?.code_str || row?.client_tcode || '', actorPin: getActorPin(getTransportSession()), error: String(e?.message || e || '') }); } catch {}\n      alert(`${message}\\n\\nPAGESA NUK U RUAJT NË ARKA. MOS E LLOGARIT SI TË KRYER; RIFRESKO OSE HYR PËRSËRI DHE PROVO.`);\n    } finally {",
      'explicit failed-payment warning',
    );
  }
  fs.writeFileSync(PAY_PATH, source, 'utf8');
}

function patchApiLogging() {
  let source = fs.readFileSync(API_PATH, 'utf8');
  if (!source.includes(`${MARKER}:API_LOG`)) {
    source = replaceOnce(source, `export async function POST(req) {
  try {
    const body = await req.json();
    const supabase = createAdminClientOrThrow();
    const result = await runArkaTransaction(body || {}, { supabase });
    return NextResponse.json({ ok: true, ...(result || {}) }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error || 'ARKA_TRANSACTION_FAILED') }, { status: 400 });
  }
}`, `export async function POST(req) {
  let body = null;
  try {
    body = await req.json();
    const supabase = createAdminClientOrThrow();
    const result = await runArkaTransaction(body || {}, { supabase });
    return NextResponse.json({ ok: true, ...(result || {}) }, { status: 200 });
  } catch (error) {
    const message = String(error?.message || error || 'ARKA_TRANSACTION_FAILED');
    // ${MARKER}:API_LOG — safe context for future failed payments.
    try {
      console.error('[ARKA_TRANSACTION_FAILED]', {
        action: String(body?.action || ''),
        actorPin: String(body?.actorPin || body?.actor_pin || ''),
        orderId: body?.orderId || body?.order_id || null,
        transportOrderId: body?.transportOrderId || body?.transport_order_id || null,
        transportCode: String(body?.transportCode || body?.transport_code_str || ''),
        amount: body?.amount ?? null,
        error: message,
      });
    } catch {}
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}`, 'ARKA API diagnostics');
  }
  fs.writeFileSync(API_PATH, source, 'utf8');
}

patchArkaPage();
patchDailyStatus();
patchHandoffWizard();
patchTransportPay();
patchApiLogging();

for (const [path, token] of [
  [ARKA_PATH, `${MARKER}:ARKA_PROFILE`],
  [ARKA_PATH, 'KËTU HYJNË VETËM PAGESAT E RUAJTURA NË ARKA'],
  [DAILY_PATH, `${MARKER}:DAILY`],
  [DAILY_PATH, 'RROGË FIKSE • PA KOMISION'],
  [WIZARD_PATH, `${MARKER}:WIZARD`],
  [PAY_PATH, `${MARKER}:TRANSPORT_PAY`],
  [PAY_PATH, 'resolveActorPin(getActor() || {})'],
  [API_PATH, `${MARKER}:API_LOG`],
]) {
  if (!fs.readFileSync(path, 'utf8').includes(token)) throw new Error(`VERIFY_MISSING ${path}: ${token}`);
}
console.log('PASS Beli straight salary, canonical transport PIN and ARKA diagnostics installed');
