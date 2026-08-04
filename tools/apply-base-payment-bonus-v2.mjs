import fs from 'node:fs';

const CLIENT_PATH = 'lib/baseReadyBonusClient.js';
const PASTRIMI_PATH = 'app/pastrimi/page.jsx';
const ENGINE_PATH = 'lib/arka/arkaEngine.js';
const PAY_SERVICE_PATH = 'components/payments/payService.js';
const LIVE_CARD_PATH = 'components/ReadyBonusLiveCard.jsx';
const BONUS_PAGE_PATH = 'app/arka/bonuset/page.jsx';
const MARKER = 'BASE_PAYMENT_48H_BONUS_V2';

function scanMatchingDelimiter(source, start, openChar, closeChar, label) {
  if (source[start] !== openChar) throw new Error(`${label}_OPEN_NOT_FOUND`);
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
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`${label}_UNTERMINATED`);
}

function findNamedFunctionRange(source, name) {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`${name}_FUNCTION_NOT_FOUND`);
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanMatchingDelimiter(source, paramsStart, '(', ')', `${name}_PARAMS`);
  let bodyStart = paramsEnd + 1;
  while (bodyStart < source.length && /\s/.test(source[bodyStart])) bodyStart += 1;
  if (source[bodyStart] !== '{') throw new Error(`${name}_BODY_NOT_FOUND`);
  const bodyEnd = scanMatchingDelimiter(source, bodyStart, '{', '}', `${name}_BODY`);
  return { start: match.index, end: bodyEnd + 1 };
}

function replaceNamedFunction(source, name, replacement) {
  const range = findNamedFunctionRange(source, name);
  return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}

function functionBlock(source, name) {
  const range = findNamedFunctionRange(source, name);
  return source.slice(range.start, range.end);
}

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function patchClient() {
  let source = fs.readFileSync(CLIENT_PATH, 'utf8');
  if (source.includes(`${MARKER}:CLIENT`)) return false;

  source = replaceNamedFunction(source, 'markBaseOrderReadyWithBonus', `export async function markBaseOrderReadyWithBonus({
  orderRef,
  worker,
  readySlots = [],
  readyNote = '',
  readyAt = new Date().toISOString(),
  idempotencyKey = '',
  forceQueue = false,
} = {}) {
  const ref = text(orderRef);
  const stageActor = normalizeWorker(worker || getActor() || {});
  const slots = normalizeSlots(readySlots);
  const idem = text(idempotencyKey) || buildBaseReadyBonusIdempotencyKey(ref);
  if (!ref) throw new Error('MUNGON ORDER ID PËR BONUSIN 48H.');
  if (!stageActor.pin) throw new Error('MUNGON PIN-I I PËRDORUESIT QË PO E BËN GATI.');
  if (!slots.length) throw new Error('MUNGON RAFTI / LOKACIONI FINAL.');

  const rpcArgs = {
    p_order_ref: ref,
    p_worker_pin: stageActor.pin,
    p_ready_slots: slots,
    p_ready_note: text(readyNote) || null,
    p_ready_at: readyAt || new Date().toISOString(),
    p_idempotency_key: idem,
  };

  if (!forceQueue && isOnline()) {
    const { data, error } = await supabase.rpc('mark_base_order_ready_with_bonus_v1', rpcArgs);
    if (!error && data?.ok) {
      return {
        ...data,
        offlineQueued: false,
        idempotencyKey: idem,
        stageActor,
      };
    }
    if (error && !isNetworkLikeError(error)) throw error;
  }

  const queuedOpId = await queueOp('base_ready_bonus_transition', {
    ...rpcArgs,
    table: 'orders',
    id: ref,
    order_id: ref,
    worker: stageActor,
    idempotency_key: idem,
    queued_at: new Date().toISOString(),
    activation_rule: 'FULL_PAYMENT_ACTOR',
  });

  return {
    ok: true,
    waitingForPayment: true,
    offlineQueued: true,
    queuedOpId,
    worker: stageActor,
    stageActor,
    idempotencyKey: idem,
    bonus: null,
    summary: null,
  };
}`);

  source = replaceNamedFunction(source, 'describeReadyBonusResult', `export function describeReadyBonusResult(result = {}) {
  if (result?.offlineQueued) {
    return 'U RUAJT OFFLINE. GATI DHE BONUSI VERIFIKOHEN AUTOMATIKISHT KUR VJEN RRJETI.';
  }
  const bonus = result?.bonus || result?.activation?.bonus || null;
  const summary = result?.summary || result?.activation?.summary || {};
  const totals = summary?.totals || {};
  if (bonus?.eligible) {
    return [
      \`BONUS +\${number(bonus?.amount, 0).toFixed(2)}€\`,
      \`PIN-I I PAGESËS: \${text(bonus?.worker_pin || '—')}\`,
      \`SOT \${number(totals?.today_earned, 0).toFixed(2)}€\`,
      \`PËR ME MBAJT \${number(totals?.available_to_keep, 0).toFixed(2)}€\`,
    ].join(' • ');
  }
  if (result?.waitingForPayment !== false) {
    return 'GATI U RUAJT. BONUSI 48H AKTIVIZOHET KUR REGJISTROHET PAGESA QË E MBYLL POROSINË.';
  }
  return \`PA BONUS • \${text(bonus?.reason || result?.activation?.reason || 'NUK U AKTIVIZUA NË PAGESË')}\`;
}`);

  source += `\n// ${MARKER}:CLIENT — GATI stages eligibility; the full-payment actor owns activation.\n`;
  fs.writeFileSync(CLIENT_PATH, source, 'utf8');
  return true;
}

function patchPastrimi() {
  let source = fs.readFileSync(PASTRIMI_PATH, 'utf8');
  if (source.includes(`${MARKER}:PASTRIMI`)) return false;

  const promptBlock = `    let readyBonusWorker = null;
    if (!isPastrimTransportScopedRow(o)) {
      readyBonusWorker = await resolveBaseReadyBonusWorker({
        label: 'JEP PIN-IN E BAZISTIT QË E PËRFUNDOI DHE E PAKETOI KËTË POROSI',
      });
      if (!readyBonusWorker) {
        if (btn) { btn.disabled = false; btn.innerText = 'GATI'; }
        return;
      }
    }`;

  const stageBlock = `    let readyBonusWorker = null;
    if (!isPastrimTransportScopedRow(o)) {
      try { readyBonusWorker = getActor?.() || null; } catch {}
      if (!readyBonusWorker?.pin) {
        alert('MUNGON SESIONI I PËRDORUESIT. HYR PËRSËRI PARA SE TA BËSH GATI.');
        if (btn) { btn.disabled = false; btn.innerText = 'GATI'; }
        return;
      }
    }
    // ${MARKER}:PASTRIMI — ky PIN ruan veprimin GATI; bonusin e merr PIN-i i pagesës së plotë.`;

  source = replaceRequired(source, promptBlock, stageBlock, 'PASTRIMI_REMOVE_READY_BONUS_PROMPT');
  source = source.replace(
    `var readyBonusResult = null;\n    // BASE_READY_48H_BONUS_V1:PASTRIMI`,
    `var readyBonusResult = null;\n    // BASE_READY_48H_BONUS_V1:PASTRIMI\n    // ${MARKER}:PASTRIMI_RESULT`
  );
  fs.writeFileSync(PASTRIMI_PATH, source, 'utf8');
  return true;
}

function patchEngine() {
  let source = fs.readFileSync(ENGINE_PATH, 'utf8');
  if (source.includes(`${MARKER}:ENGINE`)) return false;

  const helper = `async function activateBaseReadyBonusAfterPaymentV2(sb, { order, payment, actor } = {}) {
  const orderId = normalizeDbId(order?.id);
  const paymentId = normalizeDbId(payment?.id);
  const actorPin = normalizePin(actor?.pin);
  if (!orderId || !paymentId || !actorPin) {
    return { ok: true, activated: false, reason: 'BONUS_ACTIVATION_INPUT_INCOMPLETE' };
  }

  const { data, error } = await sb.rpc('activate_base_ready_bonus_on_full_payment_v2', {
    p_order_id: orderId,
    p_actor_pin: actorPin,
    p_payment_id: paymentId,
    p_paid_at: payment?.created_at || nowIso(),
    p_idempotency_key: \`BASE_READY_48H_PAYMENT:\${orderId}\`,
  });
  if (error) throw error;
  if (data?.ok === false) throw new Error(data?.error || data?.reason || 'BASE_READY_BONUS_ACTIVATION_FAILED');
  return data || { ok: true, activated: false, reason: 'EMPTY_BONUS_ACTIVATION_RESPONSE' };
}

// ${MARKER}:ENGINE — bonus activation is attached to the verified base payment.

`;

  if (!source.includes('async function baseOrderPayment(sb, payload = {}) {')) {
    throw new Error('ENGINE_BASE_PAYMENT_ANCHOR_NOT_FOUND');
  }
  source = source.replace('async function baseOrderPayment(sb, payload = {}) {', `${helper}async function baseOrderPayment(sb, payload = {}) {`);

  source = replaceNamedFunction(source, 'baseOrderPayment', `async function baseOrderPayment(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  const orderId = normalizeDbId(payload.orderId || payload.order_id);
  const amount = positiveMoney(payload.amount, 'AMOUNT_INVALID');
  if (!orderId) throw new Error('ORDER_ID_INVALID');
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');

  const deterministicKey = buildBaseCashIdempotencyKey({ orderId, amount, actorPin: actor.pin });
  const idempotencyKey = cleanText(payload.idempotencyKey || payload.idempotency_key || deterministicKey, '');
  const guardedPayload = { ...payload, idempotencyKey, idempotency_key: idempotencyKey };
  const lockKey = \`base_cash:\${orderId}:\${idempotentMoneyKey(amount)}:\${actor.pin}\`;

  return withRuntimeLock(lockKey, async () => {
    const order = await fetchOrder(sb, orderId);
    const duplicateByKey = await findActivePaymentByIdempotencyKey(sb, idempotencyKey);
    if (duplicateByKey && !isVerifiedBasePaymentRow(duplicateByKey, { orderId, amount, actorPin: actor.pin })) {
      throw new Error('BASE_ARKA_IDEMPOTENCY_CONFLICT');
    }
    const duplicate = duplicateByKey || await findDuplicateBasePayment(sb, { orderId, amount });
    let payment = duplicate || null;
    let reusedExistingPayment = Boolean(duplicate);
    if (!payment) {
      try {
        payment = await insertRow(sb, PENDING_TABLE, buildBasePaymentRow(guardedPayload, order, actor), pendingInsertVariants);
      } catch (error) {
        const errorText = String(error?.code || error?.message || error || '').toLowerCase();
        const mightBeIdempotentRace = errorText.includes('23505') || errorText.includes('duplicate key') || errorText.includes('idemp');
        if (!mightBeIdempotentRace) throw error;
        const raced = await findActivePaymentByIdempotencyKey(sb, idempotencyKey);
        if (!raced || !isVerifiedBasePaymentRow(raced, { orderId, amount, actorPin: actor.pin })) throw error;
        payment = raced;
        reusedExistingPayment = true;
      }
    }

    const verifiedPayment = await verifyBasePaymentOrThrow(sb, { orderId, amount, payment, idempotencyKey });

    let updatedOrder = null;
    try {
      updatedOrder = await updateOrderAfterPayment(sb, order, amount, {
        duplicate: reusedExistingPayment,
        statusOnFullPayment:
          guardedPayload.statusOnFullPayment ||
          guardedPayload.status_on_full_payment ||
          guardedPayload.fullPaymentStatus ||
          guardedPayload.full_payment_status,
      });
    } catch (error) {
      return {
        ok: false,
        action: ARKA_ACTION.BASE_ORDER_PAYMENT,
        needsManualRepair: true,
        repairCode: 'BASE_ORDER_UPDATE_FAILED_AFTER_PAYMENT_INSERT',
        error: String(error?.message || error || 'BASE_ORDER_UPDATE_FAILED_AFTER_PAYMENT_INSERT'),
        duplicate: reusedExistingPayment,
        existing: reusedExistingPayment,
        payment: verifiedPayment,
        row: verifiedPayment,
        verifiedPayment,
        paymentVerified: true,
        orderId,
      };
    }

    await verifyBasePaymentOrThrow(sb, { orderId, amount, payment: verifiedPayment, idempotencyKey });

    let readyBonusResult = null;
    let readyBonusActivationError = '';
    try {
      readyBonusResult = await activateBaseReadyBonusAfterPaymentV2(sb, {
        order: updatedOrder,
        payment: verifiedPayment,
        actor,
      });
    } catch (error) {
      readyBonusActivationError = String(error?.message || error || 'BASE_READY_BONUS_ACTIVATION_FAILED');
    }

    return {
      ok: true,
      action: ARKA_ACTION.BASE_ORDER_PAYMENT,
      duplicate: reusedExistingPayment,
      existing: reusedExistingPayment,
      payment: verifiedPayment,
      row: verifiedPayment,
      verifiedPayment,
      paymentVerified: true,
      order: updatedOrder,
      idempotencyKey,
      readyBonusResult,
      readyBonus: readyBonusResult?.bonus || null,
      readyBonusActivated: readyBonusResult?.activated === true,
      readyBonusActivationError: readyBonusActivationError || null,
      needsBonusRepair: Boolean(readyBonusActivationError),
    };
  });
}`);

  fs.writeFileSync(ENGINE_PATH, source, 'utf8');
  return true;
}

function patchPayService() {
  let source = fs.readFileSync(PAY_SERVICE_PATH, 'utf8');
  if (source.includes(`${MARKER}:PAY_SERVICE`)) return false;
  const block = functionBlock(source, 'recordOrderCashPayment');
  const anchor = `  return {
    ok: true,
    ...(result || {}),`;
  if (!block.includes(anchor)) throw new Error('PAY_SERVICE_SUCCESS_RETURN_ANCHOR_NOT_FOUND');
  const replacement = `  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('arka:refresh'));
      window.dispatchEvent(new CustomEvent('base-ready-bonus:refresh', {
        detail: {
          orderId,
          paymentId: payment?.id || null,
          activated: result?.readyBonusActivated === true,
          bonus: result?.readyBonus || result?.readyBonusResult?.bonus || null,
        },
      }));
    }
  } catch {}
  // ${MARKER}:PAY_SERVICE

  return {
    ok: true,
    ...(result || {}),`;
  const nextBlock = block.replace(anchor, replacement);
  const range = findNamedFunctionRange(source, 'recordOrderCashPayment');
  source = `${source.slice(0, range.start)}${nextBlock}${source.slice(range.end)}`;
  fs.writeFileSync(PAY_SERVICE_PATH, source, 'utf8');
  return true;
}

function patchLiveCard() {
  let source = fs.readFileSync(LIVE_CARD_PATH, 'utf8');
  if (source.includes(`${MARKER}:LIVE_CARD`)) return false;
  source = replaceRequired(
    source,
    `0.10€ / m² • GATI brenda 48 orëve`,
    `0.10€ / m² • aktivizohet në pagesën që e mbyll porosinë`,
    'LIVE_CARD_RULE_COPY'
  );
  source = replaceRequired(
    source,
    `    window.addEventListener('arka:refresh', onRefresh);`,
    `    window.addEventListener('arka:refresh', onRefresh);\n    window.addEventListener('base-ready-bonus:refresh', onRefresh);`,
    'LIVE_CARD_REFRESH_LISTENER'
  );
  source = replaceRequired(
    source,
    `      window.removeEventListener('arka:refresh', onRefresh);`,
    `      window.removeEventListener('arka:refresh', onRefresh);\n      window.removeEventListener('base-ready-bonus:refresh', onRefresh);`,
    'LIVE_CARD_REFRESH_CLEANUP'
  );
  source += `\n// ${MARKER}:LIVE_CARD\n`;
  fs.writeFileSync(LIVE_CARD_PATH, source, 'utf8');
  return true;
}

function patchBonusPage() {
  let source = fs.readFileSync(BONUS_PAGE_PATH, 'utf8');
  if (source.includes(`${MARKER}:BONUS_PAGE`)) return false;
  source = source.replace(
    `porosia BAZA • GATI brenda {BASE_READY_BONUS_WINDOW_HOURS} orëve`,
    `porosia BAZA • GATI brenda {BASE_READY_BONUS_WINDOW_HOURS} orëve • bonus në pagesën e plotë`
  );
  source = source.replace(
    `Bonusi i takon PIN-it që e bën porosinë GATI pas paketimit dhe raftit final.`,
    `Bonusi i takon PIN-it që regjistron pagesën që e mbyll porosinë. GATI brenda 48 orëve mbetet kushti i kualifikimit.`
  );
  source = source.replace(
    "{canManage ? `${String(row.worker_name || row.worker_pin || '').toUpperCase()} • PIN ${row.worker_pin || '—'} • ` : ''}{stamp(row.ready_at)}",
    "{canManage ? `${String(row.worker_name || row.worker_pin || '').toUpperCase()} • PIN ${row.worker_pin || '—'} • ` : ''}PAGESA ${stamp(row.activated_at || row.ready_at)}"
  );
  source = source.replace(
    `Një porosi paguhet vetëm një herë. PIN-i i fundit që e bën GATI merr 0.10€ për m² kur koha është brenda 48 orëve.`,
    `Një porosi paguhet vetëm një herë. PIN-i që regjistron pagesën e plotë merr 0.10€ për m² kur porosia është bërë GATI brenda 48 orëve.`
  );
  source = source.replace(
    `Shuma “MUNDESH ME MBAJT” zbritet automatikisht nga cash-i që i dërgohet Dispatch. Teprica bartet për dorëzimin tjetër.`,
    `Bonusi shfaqet pasi pagesa e mbyll porosinë. Shuma “MUNDESH ME MBAJT” zbritet automatikisht nga cash-i që i dërgohet Dispatch dhe teprica bartet për dorëzimin tjetër.`
  );
  source += `\n// ${MARKER}:BONUS_PAGE\n`;
  fs.writeFileSync(BONUS_PAGE_PATH, source, 'utf8');
  return true;
}

const changed = [
  patchClient(),
  patchPastrimi(),
  patchEngine(),
  patchPayService(),
  patchLiveCard(),
  patchBonusPage(),
].some(Boolean);

console.log(`[base-payment-bonus-v2] ${changed ? 'installed' : 'already installed'}`);
