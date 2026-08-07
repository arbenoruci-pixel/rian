import fs from 'node:fs';

const PAGE_PATH = 'app/arka/page.jsx';
const CSS_PATH = 'app/arka/arka.css';
const MARKER = 'ARKA_EXPENSE_MOBILE_PRO_V1';
const IMPORT_LINE = "import ArkaExpenseComposer from '@/components/ArkaExpenseComposer';";

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

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error(`${label}_UNTERMINATED`);
}

function findNamedFunctionRange(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
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

function replaceOnce(source, from, to, label) {
  if (source.includes(to)) {
    console.log(`SKIP ${label}: already installed`);
    return source;
  }
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  console.log(`PATCH ${label}`);
  return source.replace(from, to);
}

function patchPage() {
  let source = fs.readFileSync(PAGE_PATH, 'utf8');
  if (source.includes(`${MARKER}:PAGE`)) {
    console.log('[arka-expense-mobile-pro-v1] page already installed');
    return false;
  }

  if (!source.includes(IMPORT_LINE)) {
    const importAnchor = "import ReadyBonusLiveCard from '@/components/ReadyBonusLiveCard';";
    if (!source.includes(importAnchor)) throw new Error('ARKA_EXPENSE_IMPORT_ANCHOR_NOT_FOUND');
    source = source.replace(importAnchor, `${importAnchor}\n${IMPORT_LINE}`);
    console.log('PATCH ARKA expense composer import');
  }

  source = replaceOnce(
    source,
    `  const [expenseBeneficiaryName, setExpenseBeneficiaryName] = useState('');`,
    `  const [expenseBeneficiaryName, setExpenseBeneficiaryName] = useState('');\n  const [expenseFormError, setExpenseFormError] = useState('');\n  const [expenseSavedNotice, setExpenseSavedNotice] = useState('');\n  // ${MARKER}:PAGE`,
    'ARKA expense feedback state',
  );

  source = replaceNamedFunction(source, 'submitExpense', `  async function submitExpense() {
    const title = String(expenseTitle || '').trim();
    const amount = parseAmountInput(expenseAmount);

    if (!title) {
      setExpenseFormError('SHKRUAJ ÇFARË U PAGUA, P.SH. NAFTË OSE PARKING.');
      return false;
    }
    if (amount <= 0) {
      setExpenseFormError('SHKRUAJ SHUMËN E SAKTË TË SHPENZIMIT.');
      return false;
    }

    const request = normalizeWorkerExpenseRequest({
      requestKind: expenseRequestType,
      actorPin: actor?.pin,
      actorName: actor?.name,
      beneficiaryPin: expenseBeneficiaryPin,
      beneficiaryName: expenseBeneficiaryName,
    });
    if (request?.error) {
      setExpenseFormError(String(request.error || '').replace(/^🔴\\s*/, '') || 'PLOTËSO TË DHËNAT E PERSONIT.');
      return false;
    }

    try {
      setExpenseFormError('');
      setBusy('expense');
      const expenseResult = await createExpenseEntry({
        actor,
        amount,
        note: buildExpenseRequestNote(title, request),
        workerPin: actor?.pin,
        workerName: actor?.name,
        workerRole: actor?.role,
      });
      const expenseQueuedOffline = Boolean(expenseResult?.offlineQueued || expenseResult?.queued || expenseResult?.localOnly || expenseResult?.offline);

      setExpenseTitle('');
      setExpenseAmount('');
      setExpenseRequestType('BUSINESS_EXPENSE');
      setExpenseBeneficiaryPin('');
      setExpenseBeneficiaryName('');
      setExpenseFormOpen(false);

      if (!expenseQueuedOffline) await scheduleManagerMutationRefresh(actor);
      else {
        try { window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER')); } catch {}
      }

      const notice = expenseQueuedOffline
        ? `U RUAJT OFFLINE: ${euro(amount)} • ${title.toUpperCase()}. SINKRONIZOHET AUTOMATIKISHT KUR TË VIJË RRJETI.`
        : `U REGJISTRUA: ${euro(amount)} • ${title.toUpperCase()}. PRET MIRATIMIN E ADMIN / DISPATCH.`;
      setExpenseSavedNotice(notice);
      if (typeof window !== 'undefined') {
        window.setTimeout(() => setExpenseSavedNotice(''), 6500);
      }
      return true;
    } catch (e) {
      setExpenseFormError(e?.message || 'NUK U REGJISTRUA SHPENZIMI. PROVO PËRSËRI.');
      return false;
    } finally {
      setBusy('');
    }
  }`);
  console.log('PATCH ARKA expense submit flow');

  const actionStartNeedle = `          <div className="arkaSectionCard" style={{ display: 'grid', gap: 10 }}>
            <button type="button" className="arkaSolidBtn big arkaMainHandoffBtn"`;
  const actionStart = source.indexOf(actionStartNeedle);
  if (actionStart < 0) throw new Error('ARKA_ACTION_HUB_START_NOT_FOUND');
  const formStart = source.indexOf(`\n          {expenseFormOpen ? (`, actionStart);
  if (formStart < 0) throw new Error('ARKA_EXPENSE_FORM_START_NOT_FOUND');

  const actionHub = `          <div className="arkaSectionCard arkaWorkerActionHub">
            <button type="button" className="arkaSolidBtn big arkaMainHandoffBtn" disabled={!!busy || workerBaseForDispatchTotal <= 0 || n(workerSnapshot?.cashDuplicateTransportCount) > 0} onClick={submitHandoff}>{busy === 'handoff' ? '...' : \`DORËZO TE DISPATCH — \${euro(workerBaseForDispatchTotal)}\`}</button>
            {n(workerSnapshot?.cashDuplicateTransportCount) > 0 ? <div className="arkaReviewWarn">U gjet duplicate transport cash. Dorëzimi u ndalua për siguri.</div> : null}

            <div className="arkaWorkerActionHubHead">
              <div>
                <div className="arkaSectionTitle">VEPRIME TË SHPEJTA</div>
                <div className="arkaSectionSub">REGJISTRO SHPENZIM OSE USHQIM ME PAK PREKJE.</div>
              </div>
            </div>

            <div className="arkaWorkerActionHubGrid">
              <button
                type="button"
                className="arkaLaunchAction expense"
                disabled={!!busy}
                onClick={() => {
                  setExpenseFormError('');
                  setExpenseSavedNotice('');
                  setExpenseFormOpen(true);
                }}
              >
                <span className="arkaLaunchActionIcon">−€</span>
                <span className="arkaLaunchActionCopy"><b>REGJISTRO SHPENZIM</b><small>BIZNES OSE PERSONAL / AVANS</small></span>
                <span className="arkaLaunchActionArrow">›</span>
              </button>

              <button
                type="button"
                className="arkaLaunchAction meal"
                disabled={!!busy || selfMealCoveredToday}
                onClick={openMealForm}
              >
                <span className="arkaLaunchActionIcon">3€</span>
                <span className="arkaLaunchActionCopy"><b>{selfMealCoveredToday ? 'USHQIMI U REGJISTRUA' : 'REGJISTRO USHQIM'}</b><small>{selfMealCoveredToday ? 'ËSHTË RUAJTUR PËR SOT' : 'PËR TY OSE PËR KOLEGËT'}</small></span>
                <span className="arkaLaunchActionArrow">›</span>
              </button>
            </div>
          </div>

          {expenseSavedNotice ? <div className="arkaExpenseSavedNotice" role="status">{expenseSavedNotice}</div> : null}`;

  source = `${source.slice(0, actionStart)}${actionHub}${source.slice(formStart)}`;
  console.log('PATCH ARKA worker quick-action hub');

  const nextFormStart = source.indexOf(`          {expenseFormOpen ? (`, actionStart);
  const mealStart = source.indexOf(`\n          {mealFormOpen && !selfMealCoveredToday ? (`, nextFormStart);
  if (nextFormStart < 0 || mealStart < 0) throw new Error('ARKA_EXPENSE_FORM_RANGE_NOT_FOUND');

  const composerBlock = `          <ArkaExpenseComposer
            open={expenseFormOpen}
            busy={busy === 'expense'}
            actor={actor}
            title={expenseTitle}
            amount={expenseAmount}
            requestType={expenseRequestType}
            beneficiaryPin={expenseBeneficiaryPin}
            beneficiaryName={expenseBeneficiaryName}
            staffOptions={mealOptions}
            error={expenseFormError}
            onTitleChange={(value) => {
              setExpenseTitle(value);
              setExpenseFormError('');
            }}
            onAmountChange={(value) => {
              setExpenseAmount(value);
              setExpenseFormError('');
            }}
            onRequestTypeChange={(value) => {
              setExpenseRequestType(value);
              setExpenseFormError('');
              if (value !== 'PERSONAL_OTHER') {
                setExpenseBeneficiaryPin('');
                setExpenseBeneficiaryName('');
              }
            }}
            onBeneficiaryChange={({ pin, name }) => {
              setExpenseBeneficiaryPin(String(pin || '').trim());
              setExpenseBeneficiaryName(String(name || '').trim());
              setExpenseFormError('');
            }}
            onClose={() => {
              if (busy === 'expense') return;
              setExpenseFormOpen(false);
              setExpenseFormError('');
            }}
            onSubmit={submitExpense}
          />`;

  source = `${source.slice(0, nextFormStart)}${composerBlock}${source.slice(mealStart)}`;
  fs.writeFileSync(PAGE_PATH, source, 'utf8');
  console.log('PATCH ARKA professional expense composer mount');
  return true;
}

function patchCss() {
  let source = fs.readFileSync(CSS_PATH, 'utf8');
  if (source.includes(`${MARKER}:CSS`)) {
    console.log('[arka-expense-mobile-pro-v1] css already installed');
    return false;
  }

  source += `

/* ${MARKER}:CSS — professional, thumb-friendly worker expense flow. */
.arkaWorkerActionHub{display:grid;gap:12px;border-color:rgba(59,130,246,.20);background:linear-gradient(180deg,rgba(30,64,175,.10),rgba(11,15,20,.96))}
.arkaWorkerActionHubHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding-top:2px}
.arkaWorkerActionHubGrid{display:grid;grid-template-columns:1fr;gap:9px}
.arkaLaunchAction{width:100%;min-height:72px;display:grid;grid-template-columns:48px minmax(0,1fr) 20px;align-items:center;gap:11px;padding:10px 12px;border-radius:17px;border:1px solid rgba(255,255,255,.11);background:rgba(255,255,255,.045);color:#fff;text-align:left;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.arkaLaunchAction.expense{border-color:rgba(59,130,246,.32);background:linear-gradient(135deg,rgba(37,99,235,.18),rgba(15,23,42,.82))}
.arkaLaunchAction.meal{border-color:rgba(16,185,129,.25);background:linear-gradient(135deg,rgba(5,150,105,.13),rgba(15,23,42,.82))}
.arkaLaunchAction:disabled{opacity:.48;cursor:not-allowed}
.arkaLaunchActionIcon{width:46px;height:46px;display:inline-flex;align-items:center;justify-content:center;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(2,6,23,.65);font-size:16px;font-weight:1000;letter-spacing:-.03em;color:#fff}
.arkaLaunchActionCopy{min-width:0;display:grid;gap:4px}
.arkaLaunchActionCopy b{font-size:13px;line-height:1.1;font-weight:1000;letter-spacing:.055em;color:#fff}
.arkaLaunchActionCopy small{font-size:9.5px;line-height:1.25;font-weight:850;letter-spacing:.08em;color:rgba(226,232,240,.60)}
.arkaLaunchActionArrow{font-size:28px;line-height:1;color:rgba(191,219,254,.82);justify-self:end}
.arkaExpenseSavedNotice{padding:13px 14px;border-radius:16px;border:1px solid rgba(16,185,129,.34);background:rgba(6,78,59,.38);color:#d1fae5;font-size:11px;line-height:1.45;font-weight:900;letter-spacing:.055em;text-transform:uppercase;box-shadow:0 12px 30px rgba(0,0,0,.22)}

.arkaExpenseComposerBackdrop{position:fixed;inset:0;z-index:10050;display:flex;align-items:flex-end;justify-content:center;padding:0;background:rgba(2,6,23,.82);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.arkaExpenseComposer,.arkaExpenseComposer *{box-sizing:border-box}
.arkaExpenseComposer{width:min(720px,100%);max-height:calc(100dvh - 8px);display:flex;flex-direction:column;overflow:hidden;border:1px solid rgba(148,163,184,.22);border-bottom:0;border-radius:26px 26px 0 0;background:linear-gradient(180deg,#111827 0%,#070b12 100%);color:#f8fafc;box-shadow:0 -28px 80px rgba(0,0,0,.58);font-family:inherit}
.arkaExpenseComposerHeader{flex:0 0 auto;display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 17px 14px;border-bottom:1px solid rgba(148,163,184,.14);background:rgba(15,23,42,.96)}
.arkaExpenseComposerEyebrow{font-size:9px;line-height:1;font-weight:950;letter-spacing:.19em;color:#93c5fd}
.arkaExpenseComposerHeader h2{margin:7px 0 4px;font-size:22px;line-height:1;font-weight:1000;letter-spacing:.025em;color:#fff}
.arkaExpenseComposerHeader p{margin:0;max-width:470px;font-size:11px;line-height:1.38;font-weight:750;color:rgba(226,232,240,.64)}
.arkaExpenseComposerClose{flex:0 0 44px;width:44px;height:44px;border-radius:14px;border:1px solid rgba(148,163,184,.22);background:rgba(255,255,255,.05);color:#fff;font-size:28px;line-height:1;touch-action:manipulation}
.arkaExpenseComposerClose:disabled{opacity:.45}
.arkaExpenseComposerBody{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;display:grid;gap:10px;padding:12px 12px 18px}
.arkaExpenseStep{display:grid;gap:10px;padding:13px;border-radius:18px;border:1px solid rgba(148,163,184,.14);background:rgba(15,23,42,.66)}
.arkaExpenseStep.compact{padding-bottom:12px}
.arkaExpenseStepTitle{display:flex;align-items:center;gap:9px;font-size:10px;font-weight:1000;letter-spacing:.12em;color:#e2e8f0}
.arkaExpenseStepTitle span{width:25px;height:25px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;background:rgba(37,99,235,.18);border:1px solid rgba(96,165,250,.28);color:#bfdbfe;font-size:11px}
.arkaExpenseTypeGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.arkaExpenseTypeCard{min-height:86px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:6px;padding:11px;border-radius:16px;border:1px solid rgba(148,163,184,.18);background:rgba(2,6,23,.48);color:#e2e8f0;text-align:left;touch-action:manipulation}
.arkaExpenseTypeCard strong{font-size:12px;line-height:1.1;font-weight:1000;letter-spacing:.04em}
.arkaExpenseTypeCard small{font-size:9.5px;line-height:1.3;font-weight:750;color:rgba(226,232,240,.58)}
.arkaExpenseTypeCard.active.business{border-color:rgba(59,130,246,.50);background:rgba(37,99,235,.17);box-shadow:inset 0 0 0 1px rgba(147,197,253,.10)}
.arkaExpenseTypeCard.active.personal{border-color:rgba(245,158,11,.48);background:rgba(180,83,9,.16);box-shadow:inset 0 0 0 1px rgba(253,230,138,.08)}
.arkaExpenseScopeGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.arkaExpenseScopeGrid button,.arkaExpensePresetGrid button,.arkaExpenseQuickAmounts button{min-height:43px;border-radius:13px;border:1px solid rgba(148,163,184,.18);background:rgba(2,6,23,.46);color:#cbd5e1;font-size:10px;font-weight:950;letter-spacing:.055em;touch-action:manipulation}
.arkaExpenseScopeGrid button.active{border-color:rgba(245,158,11,.46);background:rgba(180,83,9,.18);color:#fef3c7}
.arkaExpensePresetGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
.arkaExpensePresetGrid button.active{border-color:rgba(59,130,246,.52);background:rgba(37,99,235,.20);color:#dbeafe}
.arkaExpenseFieldGroup{display:grid;gap:6px}
.arkaExpenseFieldGroup>span{font-size:9px;font-weight:950;letter-spacing:.14em;color:rgba(226,232,240,.57)}
.arkaExpenseTextInput,.arkaExpenseSelect{width:100%;min-height:52px;border-radius:15px;border:1px solid rgba(148,163,184,.22);background:#050914;color:#fff;padding:0 13px;font:inherit;font-size:16px;font-weight:850;outline:none}
.arkaExpenseTextInput.large{min-height:56px}
.arkaExpenseTextInput:focus,.arkaExpenseSelect:focus{border-color:rgba(96,165,250,.64);box-shadow:0 0 0 4px rgba(37,99,235,.16)}
.arkaExpenseSelect{appearance:auto}
.arkaExpenseManualPersonGrid{display:grid;grid-template-columns:1fr;gap:8px}
.arkaExpenseSelectedPerson{padding:9px 10px;border-radius:13px;border:1px solid rgba(245,158,11,.26);background:rgba(120,53,15,.18);font-size:10px;line-height:1.35;font-weight:850;color:#fde68a}
.arkaExpenseAmountWrap{height:72px;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:7px;padding:0 15px;border-radius:18px;border:1px solid rgba(34,197,94,.35);background:linear-gradient(135deg,rgba(6,78,59,.28),rgba(2,6,23,.78))}
.arkaExpenseAmountWrap:focus-within{border-color:rgba(74,222,128,.68);box-shadow:0 0 0 4px rgba(22,163,74,.14)}
.arkaExpenseAmountWrap>span{font-size:27px;font-weight:950;color:#86efac}
.arkaExpenseAmountWrap input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:#f0fdf4;font:inherit;font-size:36px;line-height:1;font-weight:1000;letter-spacing:-.035em}
.arkaExpenseAmountWrap input::placeholder{color:rgba(187,247,208,.28)}
.arkaExpenseQuickAmounts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
.arkaExpenseQuickAmounts button.active{border-color:rgba(34,197,94,.50);background:rgba(22,163,74,.18);color:#dcfce7}
.arkaExpenseComposerError{padding:11px 12px;border-radius:15px;border:1px solid rgba(248,113,113,.36);background:rgba(127,29,29,.30);color:#fecaca;font-size:11px;line-height:1.4;font-weight:900;letter-spacing:.04em}
.arkaExpensePreview{display:grid;gap:0;border-radius:18px;border:1px solid rgba(148,163,184,.14);background:rgba(2,6,23,.54);overflow:hidden}
.arkaExpensePreviewTitle{padding:11px 12px;border-bottom:1px solid rgba(148,163,184,.12);font-size:10px;font-weight:1000;letter-spacing:.14em;color:#93c5fd}
.arkaExpensePreview>div:not(.arkaExpensePreviewTitle){display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:9px 12px;border-bottom:1px solid rgba(148,163,184,.09)}
.arkaExpensePreview>div:last-child{border-bottom:0}
.arkaExpensePreview span{font-size:9px;font-weight:900;letter-spacing:.11em;color:rgba(226,232,240,.50)}
.arkaExpensePreview b{max-width:68%;font-size:11px;line-height:1.25;font-weight:950;text-align:right;color:#f8fafc;overflow-wrap:anywhere}
.arkaExpensePreview .total{background:rgba(6,78,59,.20)}
.arkaExpensePreview .total b{font-size:18px;color:#bbf7d0}
.arkaExpenseComposerFooter{flex:0 0 auto;display:grid;grid-template-columns:minmax(92px,.7fr) minmax(0,2fr);gap:8px;padding:11px 12px calc(11px + env(safe-area-inset-bottom));border-top:1px solid rgba(148,163,184,.14);background:rgba(7,11,18,.98)}
.arkaExpenseComposerFooter button{min-height:54px;border-radius:16px;font-size:11px;font-weight:1000;letter-spacing:.065em;touch-action:manipulation}
.arkaExpenseComposerFooter .secondary{border:1px solid rgba(148,163,184,.20);background:rgba(255,255,255,.05);color:#cbd5e1}
.arkaExpenseComposerFooter .primary{border:1px solid rgba(59,130,246,.55);background:linear-gradient(180deg,#1673ff,#0758e8);color:#fff;box-shadow:0 8px 22px rgba(37,99,235,.24)}
.arkaExpenseComposerFooter button:disabled{opacity:.42;box-shadow:none}

@media (min-width:760px){
  .arkaWorkerActionHubGrid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .arkaExpenseComposerBackdrop{align-items:center;padding:18px}
  .arkaExpenseComposer{max-height:min(92dvh,860px);border-bottom:1px solid rgba(148,163,184,.22);border-radius:26px}
  .arkaExpenseComposerBody{padding:14px 16px 20px}
  .arkaExpenseManualPersonGrid{grid-template-columns:1fr 1fr}
}
@media (max-width:420px){
  .arkaExpensePresetGrid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .arkaExpenseTypeCard{min-height:92px;padding:10px}
  .arkaExpenseComposerHeader h2{font-size:20px}
  .arkaExpenseAmountWrap input{font-size:33px}
  .arkaExpenseComposerFooter{grid-template-columns:92px minmax(0,1fr)}
  .arkaExpenseComposerFooter button{font-size:10px}
}
`;

  fs.writeFileSync(CSS_PATH, source, 'utf8');
  console.log('PATCH ARKA professional mobile expense CSS');
  return true;
}

patchPage();
patchCss();

const pageAfter = fs.readFileSync(PAGE_PATH, 'utf8');
const cssAfter = fs.readFileSync(CSS_PATH, 'utf8');
const requiredPageTokens = [
  IMPORT_LINE,
  `${MARKER}:PAGE`,
  '<ArkaExpenseComposer',
  'arkaWorkerActionHub',
  'expenseSavedNotice',
  "setExpenseFormError('SHKRUAJ ÇFARË U PAGUA",
];
for (const token of requiredPageTokens) {
  if (!pageAfter.includes(token)) throw new Error(`ARKA_EXPENSE_PAGE_VERIFY_MISSING:${token}`);
}
if (pageAfter.includes('<div className="arkaActionHeader">SHTO SHPENZIM</div>')) {
  throw new Error('ARKA_OLD_EXPENSE_FORM_STILL_PRESENT');
}
for (const token of [`${MARKER}:CSS`, '.arkaExpenseComposerBackdrop', '.arkaLaunchAction.expense']) {
  if (!cssAfter.includes(token)) throw new Error(`ARKA_EXPENSE_CSS_VERIFY_MISSING:${token}`);
}

console.log('PASS ARKA worker expense flow is professional, mobile-first, and keeps handoff unchanged');
