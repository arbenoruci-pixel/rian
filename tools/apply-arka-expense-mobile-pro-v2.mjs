import fs from 'node:fs';

const PAGE_PATH = 'app/arka/page.jsx';
const COMPOSER_PATH = 'components/ArkaExpenseComposer.jsx';
const MARKER = 'ARKA_EXPENSE_MOBILE_PRO_V2';
const COMPONENT_IMPORT = "import ArkaExpenseComposer from '@/components/ArkaExpenseComposer';";
const CSS_IMPORT = "import '@/components/ArkaExpenseComposer.css';";

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
  if (source.includes(to)) return source;
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  console.log(`PATCH ${label}`);
  return source.replace(from, to);
}

function patchComposer() {
  let source = fs.readFileSync(COMPOSER_PATH, 'utf8');
  if (source.includes(`${MARKER}:COMPOSER`)) return false;

  source = replaceOnce(
    source,
    `  useEffect(() => {`,
    `  const descriptionStep = isBusiness || isPersonalOther ? 3 : 2;\n  const amountStep = descriptionStep + 1;\n  // ${MARKER}:COMPOSER\n\n  useEffect(() => {`,
    'ARKA composer step counters',
  );
  source = replaceOnce(
    source,
    `<div className="arkaExpenseStepTitle"><span>{isBusiness ? '3' : '3'}</span><b>PËRSHKRIMI</b></div>`,
    `<div className="arkaExpenseStepTitle"><span>{descriptionStep}</span><b>PËRSHKRIMI</b></div>`,
    'ARKA composer description step',
  );
  source = replaceOnce(
    source,
    `<div className="arkaExpenseStepTitle"><span>4</span><b>SHUMA</b></div>`,
    `<div className="arkaExpenseStepTitle"><span>{amountStep}</span><b>SHUMA</b></div>`,
    'ARKA composer amount step',
  );

  fs.writeFileSync(COMPOSER_PATH, source, 'utf8');
  return true;
}

function patchPage() {
  let source = fs.readFileSync(PAGE_PATH, 'utf8');
  if (source.includes(`${MARKER}:PAGE`)) return false;

  const importAnchor = "import ReadyBonusLiveCard from '@/components/ReadyBonusLiveCard';";
  if (!source.includes(importAnchor)) throw new Error('ARKA_EXPENSE_IMPORT_ANCHOR_NOT_FOUND');
  if (!source.includes(COMPONENT_IMPORT)) {
    source = source.replace(importAnchor, `${importAnchor}\n${COMPONENT_IMPORT}\n${CSS_IMPORT}`);
  }

  source = replaceOnce(
    source,
    `  const [expenseBeneficiaryName, setExpenseBeneficiaryName] = useState('');`,
    `  const [expenseBeneficiaryName, setExpenseBeneficiaryName] = useState('');\n  const [expenseFormError, setExpenseFormError] = useState('');\n  const [expenseSavedNotice, setExpenseSavedNotice] = useState('');\n  // ${MARKER}:PAGE`,
    'ARKA expense feedback state',
  );

  const submitExpense = [
    '  async function submitExpense() {',
    "    const title = String(expenseTitle || '').trim();",
    '    const amount = parseAmountInput(expenseAmount);',
    '',
    '    if (!title) {',
    "      setExpenseFormError('SHKRUAJ ÇFARË U PAGUA, P.SH. NAFTË OSE PARKING.');",
    '      return false;',
    '    }',
    '    if (amount <= 0) {',
    "      setExpenseFormError('SHKRUAJ SHUMËN E SAKTË TË SHPENZIMIT.');",
    '      return false;',
    '    }',
    '',
    '    const request = normalizeWorkerExpenseRequest({',
    '      requestKind: expenseRequestType,',
    '      actorPin: actor?.pin,',
    '      actorName: actor?.name,',
    '      beneficiaryPin: expenseBeneficiaryPin,',
    '      beneficiaryName: expenseBeneficiaryName,',
    '    });',
    '    if (request?.error) {',
    "      setExpenseFormError(String(request.error || '').replace(/^🔴\\s*/, '') || 'PLOTËSO TË DHËNAT E PERSONIT.');",
    '      return false;',
    '    }',
    '',
    '    try {',
    "      setExpenseFormError('');",
    "      setBusy('expense');",
    '      const expenseResult = await createExpenseEntry({',
    '        actor,',
    '        amount,',
    '        note: buildExpenseRequestNote(title, request),',
    '        workerPin: actor?.pin,',
    '        workerName: actor?.name,',
    '        workerRole: actor?.role,',
    '      });',
    '      const expenseQueuedOffline = Boolean(expenseResult?.offlineQueued || expenseResult?.queued || expenseResult?.localOnly || expenseResult?.offline);',
    '',
    "      setExpenseTitle('');",
    "      setExpenseAmount('');",
    "      setExpenseRequestType('BUSINESS_EXPENSE');",
    "      setExpenseBeneficiaryPin('');",
    "      setExpenseBeneficiaryName('');",
    '      setExpenseFormOpen(false);',
    '',
    '      if (!expenseQueuedOffline) await scheduleManagerMutationRefresh(actor);',
    '      else {',
    "        try { window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER')); } catch {}",
    '      }',
    '',
    '      const notice = expenseQueuedOffline',
    "        ? 'U RUAJT OFFLINE: ' + euro(amount) + ' • ' + title.toUpperCase() + '. SINKRONIZOHET AUTOMATIKISHT KUR TË VIJË RRJETI.'",
    "        : 'U REGJISTRUA: ' + euro(amount) + ' • ' + title.toUpperCase() + '. PRET MIRATIMIN E ADMIN / DISPATCH.';",
    '      setExpenseSavedNotice(notice);',
    "      if (typeof window !== 'undefined') window.setTimeout(() => setExpenseSavedNotice(''), 6500);",
    '      return true;',
    '    } catch (e) {',
    "      setExpenseFormError(e?.message || 'NUK U REGJISTRUA SHPENZIMI. PROVO PËRSËRI.');",
    '      return false;',
    '    } finally {',
    "      setBusy('');",
    '    }',
    '  }',
  ].join('\n');
  source = replaceNamedFunction(source, 'submitExpense', submitExpense);
  console.log('PATCH ARKA expense submit flow');

  const actionStartNeedle = `          <div className="arkaSectionCard" style={{ display: 'grid', gap: 10 }}>
            <button type="button" className="arkaSolidBtn big arkaMainHandoffBtn"`;
  const actionStart = source.indexOf(actionStartNeedle);
  if (actionStart < 0) throw new Error('ARKA_ACTION_HUB_START_NOT_FOUND');
  const formStart = source.indexOf(`\n          {expenseFormOpen ? (`, actionStart);
  if (formStart < 0) throw new Error('ARKA_EXPENSE_FORM_START_NOT_FOUND');

  const actionHub = [
    '          <div className="arkaSectionCard arkaWorkerActionHub">',
    "            <button type=\"button\" className=\"arkaSolidBtn big arkaMainHandoffBtn\" disabled={!!busy || workerBaseForDispatchTotal <= 0 || n(workerSnapshot?.cashDuplicateTransportCount) > 0} onClick={submitHandoff}>{busy === 'handoff' ? '...' : 'DORËZO TE DISPATCH — ' + euro(workerBaseForDispatchTotal)}</button>",
    '            {n(workerSnapshot?.cashDuplicateTransportCount) > 0 ? <div className="arkaReviewWarn">U gjet duplicate transport cash. Dorëzimi u ndalua për siguri.</div> : null}',
    '',
    '            <div className="arkaWorkerActionHubHead">',
    '              <div>',
    '                <div className="arkaSectionTitle">VEPRIME TË SHPEJTA</div>',
    '                <div className="arkaSectionSub">REGJISTRO SHPENZIM OSE USHQIM ME PAK PREKJE.</div>',
    '              </div>',
    '            </div>',
    '',
    '            <div className="arkaWorkerActionHubGrid">',
    '              <button',
    '                type="button"',
    '                className="arkaLaunchAction expense"',
    '                disabled={!!busy}',
    '                onClick={() => {',
    "                  setExpenseFormError('');",
    "                  setExpenseSavedNotice('');",
    '                  setExpenseFormOpen(true);',
    '                }}',
    '              >',
    '                <span className="arkaLaunchActionIcon">−€</span>',
    '                <span className="arkaLaunchActionCopy"><b>REGJISTRO SHPENZIM</b><small>BIZNES OSE PERSONAL / AVANS</small></span>',
    '                <span className="arkaLaunchActionArrow">›</span>',
    '              </button>',
    '',
    '              <button',
    '                type="button"',
    '                className="arkaLaunchAction meal"',
    '                disabled={!!busy || selfMealCoveredToday}',
    '                onClick={openMealForm}',
    '              >',
    '                <span className="arkaLaunchActionIcon">3€</span>',
    "                <span className=\"arkaLaunchActionCopy\"><b>{selfMealCoveredToday ? 'USHQIMI U REGJISTRUA' : 'REGJISTRO USHQIM'}</b><small>{selfMealCoveredToday ? 'ËSHTË RUAJTUR PËR SOT' : 'PËR TY OSE PËR KOLEGËT'}</small></span>",
    '                <span className="arkaLaunchActionArrow">›</span>',
    '              </button>',
    '            </div>',
    '          </div>',
    '',
    '          {expenseSavedNotice ? <div className="arkaExpenseSavedNotice" role="status">{expenseSavedNotice}</div> : null}',
  ].join('\n');

  source = source.slice(0, actionStart) + actionHub + source.slice(formStart);
  console.log('PATCH ARKA worker quick-action hub');

  const nextFormStart = source.indexOf(`          {expenseFormOpen ? (`, actionStart);
  const mealStart = source.indexOf(`\n          {mealFormOpen && !selfMealCoveredToday ? (`, nextFormStart);
  if (nextFormStart < 0 || mealStart < 0) throw new Error('ARKA_EXPENSE_FORM_RANGE_NOT_FOUND');

  const composerBlock = [
    '          <ArkaExpenseComposer',
    '            open={expenseFormOpen}',
    "            busy={busy === 'expense'}",
    '            actor={actor}',
    '            title={expenseTitle}',
    '            amount={expenseAmount}',
    '            requestType={expenseRequestType}',
    '            beneficiaryPin={expenseBeneficiaryPin}',
    '            beneficiaryName={expenseBeneficiaryName}',
    '            staffOptions={mealOptions}',
    '            error={expenseFormError}',
    '            onTitleChange={(value) => {',
    '              setExpenseTitle(value);',
    "              setExpenseFormError('');",
    '            }}',
    '            onAmountChange={(value) => {',
    '              setExpenseAmount(value);',
    "              setExpenseFormError('');",
    '            }}',
    '            onRequestTypeChange={(value) => {',
    '              setExpenseRequestType(value);',
    "              setExpenseFormError('');",
    "              if (value !== 'PERSONAL_OTHER') {",
    "                setExpenseBeneficiaryPin('');",
    "                setExpenseBeneficiaryName('');",
    '              }',
    '            }}',
    '            onBeneficiaryChange={({ pin, name }) => {',
    "              setExpenseBeneficiaryPin(String(pin || '').trim());",
    "              setExpenseBeneficiaryName(String(name || '').trim());",
    "              setExpenseFormError('');",
    '            }}',
    '            onClose={() => {',
    "              if (busy === 'expense') return;",
    '              setExpenseFormOpen(false);',
    "              setExpenseFormError('');",
    '            }}',
    '            onSubmit={submitExpense}',
    '          />',
  ].join('\n');

  source = source.slice(0, nextFormStart) + composerBlock + source.slice(mealStart);
  fs.writeFileSync(PAGE_PATH, source, 'utf8');
  return true;
}

patchComposer();
patchPage();

const pageAfter = fs.readFileSync(PAGE_PATH, 'utf8');
const composerAfter = fs.readFileSync(COMPOSER_PATH, 'utf8');
for (const token of [COMPONENT_IMPORT, CSS_IMPORT, `${MARKER}:PAGE`, '<ArkaExpenseComposer', 'arkaWorkerActionHub', 'expenseSavedNotice']) {
  if (!pageAfter.includes(token)) throw new Error(`ARKA_EXPENSE_PAGE_VERIFY_MISSING:${token}`);
}
if (pageAfter.includes('<div className="arkaActionHeader">SHTO SHPENZIM</div>')) throw new Error('ARKA_OLD_EXPENSE_FORM_STILL_PRESENT');
for (const token of [`${MARKER}:COMPOSER`, '{descriptionStep}', '{amountStep}']) {
  if (!composerAfter.includes(token)) throw new Error(`ARKA_EXPENSE_COMPOSER_VERIFY_MISSING:${token}`);
}
console.log('PASS ARKA expense entry is a professional mobile workflow; handoff logic is unchanged');
