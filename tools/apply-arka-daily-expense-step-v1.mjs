import fs from 'node:fs';

const COMPONENT_PATH = 'components/ArkaDailyCloseWizard.jsx';
const PACKAGE_PATH = 'package.json';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const MARKER = 'ARKA_DAILY_EXPENSE_STEP_V1';
const INSTALLER = 'node tools/apply-arka-daily-expense-step-v1.mjs';
const TEST_COMMAND = 'npm run test:arka-daily-expense-step-v1';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

function patchComponent() {
  let source = fs.readFileSync(COMPONENT_PATH, 'utf8');

  if (!source.includes(MARKER)) {
    source = replaceOnce(
      source,
      "const CLOSE_RPC = 'close_arka_day_v2';",
      "const CLOSE_RPC = 'close_arka_day_v2';\nconst EXPENSE_RESOLVE_RPC = 'resolve_arka_expense_v2';\nconst EXPENSE_CREATE_RPC = 'create_and_resolve_arka_expense_v2';",
      'expense RPC constants',
    );

    source = replaceOnce(
      source,
      `function upper(value) {
  return String(value || '').trim().toUpperCase();
}`,
      `function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanExpenseNote(value) {
  return String(value || '')
    .replace(/\\n?ARKA_EXPENSE_REQUEST_V\\d+[^\\n]*/gi, '')
    .replace(/\\n?ARKA_EXPENSE_REQUEST_V1[^\\n]*/gi, '')
    .trim() || 'PA PËRSHKRIM';
}

function randomKey(prefix = 'ARKA') {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return prefix + ':' + crypto.randomUUID();
    }
  } catch {}
  return prefix + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
}`,
      'expense helper functions',
    );

    source = replaceOnce(
      source,
      `  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);`,
      `  const [submitting, setSubmitting] = useState(false);
  const [expenseActionBusy, setExpenseActionBusy] = useState('');
  const [expenseActionMessage, setExpenseActionMessage] = useState('');
  const [newExpenseOpen, setNewExpenseOpen] = useState(false);
  const [newExpenseAmount, setNewExpenseAmount] = useState('');
  const [newExpenseNote, setNewExpenseNote] = useState('');
  const [newExpenseBusy, setNewExpenseBusy] = useState(false);
  const [result, setResult] = useState(null);`,
      'expense UI state',
    );

    source = replaceOnce(
      source,
      `  const initializedRef = useRef(false);
  const requestRef = useRef(0);`,
      `  const initializedRef = useRef(false);
  const requestRef = useRef(0);
  const expenseMutationLockRef = useRef(false);`,
      'expense mutation lock',
    );

    const outgoingFunction = `  function goNextFromOutgoings() {
    if (pendingExpenseCount > 0) {
      setError(\`KE \${pendingExpenseCount} SHPENZIME NË PRITJE. VENDOSI PARA MBYLLJES.\`);
      return;
    }
    setError('');
    setStep(3);
  }`;

    const outgoingWithActions = `${outgoingFunction}

  async function resolvePendingExpense(expense, resolution) {
    // ${MARKER}: every pending expense is visible and resolvable inside step 2.
    const expenseId = Number(expense?.id || 0);
    if (!(expenseId > 0) || expenseMutationLockRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('VENDIMI PËR SHPENZIM KËRKON INTERNET.');
      return;
    }

    const amount = n(expense?.amount);
    const labels = {
      BUSINESS_EXPENSE: 'PRANOSH SI SHPENZIM BIZNESI',
      PERSONAL_ADVANCE: 'KTHESH NË AVANS TË PUNËTORIT',
      REJECTED_OPEN_CASH: 'REFUZOSH',
    };
    const prompt = \`A JE I SIGURT QË DO TA \${labels[resolution] || 'VENDOSËSH'}?\\n\\n\${money(amount)} • \${cleanExpenseNote(expense?.note)}\`;
    try {
      if (typeof window !== 'undefined' && !window.confirm(prompt)) return;
    } catch {}

    expenseMutationLockRef.current = true;
    setExpenseActionBusy(String(expenseId));
    setExpenseActionMessage('');
    setError('');
    setDryRun(null);
    setFinalConfirm(false);
    setCountedCash('');

    try {
      const { data, error: rpcError } = await supabase.rpc(EXPENSE_RESOLVE_RPC, {
        p_actor_pin: String(actor?.pin || '').trim(),
        p_actor_name: String(actor?.name || actor?.pin || '').trim(),
        p_expense_payment_id: expenseId,
        p_resolution: resolution,
        p_beneficiary_pin: resolution === 'PERSONAL_ADVANCE' ? String(expense?.created_by_pin || '').trim() : null,
        p_beneficiary_name: resolution === 'PERSONAL_ADVANCE' ? String(expense?.created_by_name || expense?.created_by_pin || '').trim() : null,
        p_note: 'VENDOSUR NGA DISPATCH NË MBYLLJEN DITORE',
      });
      if (rpcError) throw rpcError;
      if (data?.ok !== true) throw new Error(data?.message || 'VENDIMI NUK U RUAJT.');
      setExpenseActionMessage(
        resolution === 'BUSINESS_EXPENSE'
          ? \`U POSTUA SHPENZIMI \${money(amount)} DHE U ZBRIT NGA BUXHETI.\`
          : resolution === 'PERSONAL_ADVANCE'
            ? \`U KTHYE NË AVANS \${money(amount)} DHE U ZBRIT NGA BUXHETI.\`
            : \`U REFUZUA KËRKESA \${money(amount)}.\`,
      );
      await loadPreview({ force: true });
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
    } catch (err) {
      setError(String(err?.message || err?.details || err || 'VENDIMI PËR SHPENZIM DËSHTOI.'));
      await loadPreview({ force: true });
    } finally {
      expenseMutationLockRef.current = false;
      setExpenseActionBusy('');
    }
  }

  function openNewExpenseForm() {
    setNewExpenseOpen(true);
    setExpenseActionMessage('');
    setError('');
  }

  async function createDailyExpense() {
    if (expenseMutationLockRef.current) return;
    const amount = parseMoneyInput(newExpenseAmount);
    const description = String(newExpenseNote || '').trim();
    if (amount == null || amount <= 0) {
      setError('SHKRUAJ SHUMËN E SHPENZIMIT MBI 0€.');
      return;
    }
    if (description.length < 2) {
      setError('SHKRUAJ PËRSHKRIMIN E SHPENZIMIT.');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('REGJISTRIMI I SHPENZIMIT KËRKON INTERNET.');
      return;
    }

    expenseMutationLockRef.current = true;
    setNewExpenseBusy(true);
    setExpenseActionMessage('');
    setError('');
    setDryRun(null);
    setFinalConfirm(false);
    setCountedCash('');

    try {
      const { data, error: rpcError } = await supabase.rpc(EXPENSE_CREATE_RPC, {
        p_actor_pin: String(actor?.pin || '').trim(),
        p_actor_name: String(actor?.name || actor?.pin || '').trim(),
        p_amount: amount,
        p_note: description,
        p_resolution: 'BUSINESS_EXPENSE',
        p_beneficiary_pin: null,
        p_beneficiary_name: null,
        p_idempotency_key: randomKey(\`ARKA_DAILY_EXPENSE_V2:\${date}:\${String(actor?.pin || '').trim()}\`),
      });
      if (rpcError) throw rpcError;
      if (data?.ok !== true) throw new Error(data?.message || 'SHPENZIMI NUK U RUAJT.');
      setExpenseActionMessage(\`U SHTUA SHPENZIMI \${money(amount)} DHE U ZBRIT NGA BUXHETI.\`);
      setNewExpenseAmount('');
      setNewExpenseNote('');
      setNewExpenseOpen(false);
      await loadPreview({ force: true });
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
    } catch (err) {
      setError(String(err?.message || err?.details || err || 'REGJISTRIMI I SHPENZIMIT DËSHTOI.'));
      await loadPreview({ force: true });
    } finally {
      expenseMutationLockRef.current = false;
      setNewExpenseBusy(false);
    }
  }`;

    source = replaceOnce(source, outgoingFunction, outgoingWithActions, 'expense action functions');

    const step2Start = source.indexOf('            {step === 2 ? (');
    const step3Start = source.indexOf('            {step === 3 ? (', step2Start);
    if (step2Start < 0 || step3Start < 0 || step3Start <= step2Start) {
      throw new Error('daily-close step 2 region not found');
    }

    const step2Block = `            {step === 2 ? (
              <div style={{ display: 'grid', gap: 12 }}>
                {/* ${MARKER}: Step 2 is an operational expense console, not a dead-end warning. */}
                <Card tone={pendingExpenseCount ? 'bad' : 'info'}>
                  <div style={{ fontSize: 15, fontWeight: 1000 }}>2. KONTROLLO DALJET NGA BOXHI</div>
                  <div style={{ color: palette.muted, fontSize: 11, lineHeight: 1.45, fontWeight: 750 }}>
                    Shiko çdo kërkesë, pranoje si shpenzim biznesi, ktheje në avans ose refuzoje. Mund të shtosh edhe shpenzim të ri para numërimit.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8 }}>
                    <Metric label="SHPENZIME TË POSTUARA" value={money(preview?.today_expenses?.total)} tone="bad" sub={\`\${n(preview?.today_expenses?.count)} rreshta\`} />
                    <Metric label="AVANSE TË POSTUARA" value={money(preview?.today_advances?.total)} tone="warn" sub={\`\${n(preview?.today_advances?.count)} rreshta\`} />
                    <Metric label="SHPENZIME NË PRITJE" value={money(preview?.pending_expenses_total)} tone={pendingExpenseCount ? 'bad' : 'ok'} sub={\`\${pendingExpenseCount} kërkesa\`} />
                  </div>
                  {pendingExpenseCount ? (
                    <Alert tone="bad">Vendosi kërkesat më poshtë. Sapo të mbesin 0 në pritje, hapet automatikisht “VAZHDO TE NUMËRIMI”.</Alert>
                  ) : <Alert tone="ok">Krejt daljet janë vendosur dhe janë reflektuar në buxhet. Mund të vazhdosh te numërimi.</Alert>}
                  {expenseActionMessage ? <Alert tone="ok">{expenseActionMessage}</Alert> : null}
                </Card>

                <Card tone={newExpenseOpen ? 'warn' : 'info'}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 1000 }}>SHTO SHPENZIM TË RI</div>
                      <div style={{ marginTop: 3, color: palette.muted, fontSize: 10.5, lineHeight: 1.35, fontWeight: 750 }}>Përdore kur paratë kanë dalë realisht nga boxhi.</div>
                    </div>
                    <button type="button" disabled={newExpenseBusy || !!expenseActionBusy} onClick={() => newExpenseOpen ? setNewExpenseOpen(false) : openNewExpenseForm()} style={secondaryButtonStyle}>
                      {newExpenseOpen ? 'MBYLLE' : '+ SHTO SHPENZIM'}
                    </button>
                  </div>

                  {newExpenseOpen ? (
                    <div style={{ display: 'grid', gap: 9, border: '1px solid rgba(245,158,11,.34)', borderRadius: 14, background: 'rgba(120,53,15,.14)', padding: 11 }}>
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 1000, color: palette.warn }}>SHUMA €</span>
                        <input
                          inputMode="decimal"
                          value={newExpenseAmount}
                          onChange={(event) => setNewExpenseAmount(event.target.value)}
                          placeholder="0.00"
                          style={{ width: '100%', boxSizing: 'border-box', border: '1px solid rgba(245,158,11,.42)', borderRadius: 12, padding: 12, background: '#0f172a', color: '#fff', fontSize: 18, fontWeight: 1000, outline: 'none' }}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 1000, color: palette.warn }}>PËRSHKRIMI</span>
                        <textarea
                          rows={3}
                          value={newExpenseNote}
                          onChange={(event) => setNewExpenseNote(event.target.value)}
                          placeholder="P.sh. naftë, material, servis, kompensim klienti..."
                          style={{ width: '100%', boxSizing: 'border-box', border: '1px solid rgba(245,158,11,.32)', borderRadius: 12, padding: 12, background: '#0f172a', color: '#fff', fontSize: 12, lineHeight: 1.4, fontWeight: 750, resize: 'vertical' }}
                        />
                      </label>
                      <button type="button" disabled={newExpenseBusy || !!expenseActionBusy} onClick={() => void createDailyExpense()} style={{ ...primaryButtonStyle, opacity: newExpenseBusy || expenseActionBusy ? .55 : 1, background: 'linear-gradient(135deg,#9a3412,#ea580c)' }}>
                        {newExpenseBusy ? 'DUKE RUAJTUR...' : 'REGJISTRO DHE ZBRITE NGA BUXHETI'}
                      </button>
                    </div>
                  ) : null}
                </Card>

                <Card tone={pendingExpenseCount ? 'bad' : 'ok'}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 13, fontWeight: 1000 }}>SHPENZIMET NË PRITJE</div>
                    <button type="button" disabled={refreshing || newExpenseBusy || !!expenseActionBusy} onClick={() => void loadPreview({ force: true })} style={secondaryButtonStyle}>RIFRESKO LISTËN</button>
                  </div>
                  {pendingExpenses.length ? pendingExpenses.map((expense) => {
                    const expenseId = Number(expense?.id || 0);
                    const busy = String(expenseActionBusy) === String(expenseId);
                    return (
                      <Row
                        key={\`pending_expense_\${expenseId}\`}
                        title={cleanExpenseNote(expense?.note)}
                        meta={\`\${upper(expense?.created_by_name || expense?.created_by_pin || 'PA PUNËTOR')} • \${stamp(expense?.created_at)} • KËRKESA #\${expenseId}\`}
                        amount={money(expense?.amount)}
                        tone="bad"
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(125px,1fr))', gap: 7 }}>
                          <button type="button" disabled={busy || newExpenseBusy || (!!expenseActionBusy && !busy)} onClick={() => void resolvePendingExpense(expense, 'BUSINESS_EXPENSE')} style={{ ...secondaryButtonStyle, background: 'rgba(21,128,61,.24)', color: palette.ok, opacity: busy ? .6 : 1 }}>
                            {busy ? 'DUKE VENDOSUR...' : 'PRANO BIZNES'}
                          </button>
                          <button type="button" disabled={busy || newExpenseBusy || (!!expenseActionBusy && !busy)} onClick={() => void resolvePendingExpense(expense, 'PERSONAL_ADVANCE')} style={{ ...secondaryButtonStyle, background: 'rgba(120,53,15,.24)', color: palette.warn, opacity: busy ? .6 : 1 }}>
                            KTHE NË AVANS
                          </button>
                          <button type="button" disabled={busy || newExpenseBusy || (!!expenseActionBusy && !busy)} onClick={() => void resolvePendingExpense(expense, 'REJECTED_OPEN_CASH')} style={{ ...secondaryButtonStyle, background: 'rgba(127,29,29,.24)', color: palette.bad, opacity: busy ? .6 : 1 }}>
                            REFUZO
                          </button>
                        </div>
                      </Row>
                    );
                  }) : <Alert tone="ok">S’KA SHPENZIME NË PRITJE.</Alert>}
                </Card>

                <Card>
                  <div style={{ fontSize: 13, fontWeight: 1000 }}>SHPENZIMET E POSTUARA SOT</div>
                  {postedExpenseRows.length ? postedExpenseRows.map((row) => (
                    <Row key={\`expense_\${row?.id}\`} title={upper(row?.description || row?.category)} meta={\`\${stamp(row?.created_at)} • LEDGER #\${row?.id}\`} amount={\`-\${money(row?.amount)}\`} tone="bad" />
                  )) : <div style={{ color: palette.muted, fontSize: 11 }}>S’KA SHPENZIME TË POSTUARA SOT.</div>}
                </Card>

                <Card>
                  <div style={{ fontSize: 13, fontWeight: 1000 }}>AVANSET E POSTUARA SOT</div>
                  {postedAdvanceRows.length ? postedAdvanceRows.map((row) => (
                    <Row key={\`advance_\${row?.id}\`} title={upper(row?.description || 'AVANS')} meta={\`\${stamp(row?.created_at)} • LEDGER #\${row?.id}\`} amount={\`-\${money(row?.amount)}\`} tone="warn" />
                  )) : <div style={{ color: palette.muted, fontSize: 11 }}>S’KA AVANSE TË POSTUARA SOT.</div>}
                </Card>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button type="button" disabled={newExpenseBusy || !!expenseActionBusy} onClick={() => setStep(1)} style={secondaryButtonStyle}>← DORËZIMET</button>
                  <button type="button" disabled={pendingExpenseCount > 0 || newExpenseBusy || !!expenseActionBusy} onClick={goNextFromOutgoings} style={{ ...primaryButtonStyle, opacity: pendingExpenseCount > 0 || newExpenseBusy || expenseActionBusy ? .52 : 1 }}>
                    {pendingExpenseCount > 0 ? \`VENDOS EDHE \${pendingExpenseCount} KËRKESA\` : 'VAZHDO TE NUMËRIMI →'}
                  </button>
                </div>
              </div>
            ) : null}

`;

    source = source.slice(0, step2Start) + step2Block + source.slice(step3Start);
  }

  if (!source.includes(MARKER)) throw new Error('expense step marker missing');
  if (!source.includes("supabase.rpc(EXPENSE_RESOLVE_RPC")) throw new Error('expense resolve RPC missing');
  if (!source.includes("supabase.rpc(EXPENSE_CREATE_RPC")) throw new Error('expense create RPC missing');
  if (!source.includes('SHPENZIMET NË PRITJE')) throw new Error('pending expense list missing');
  if (!source.includes('REGJISTRO DHE ZBRITE NGA BUXHETI')) throw new Error('new expense action missing');
  fs.writeFileSync(COMPONENT_PATH, source, 'utf8');
}

function patchFinalVersionOwner() {
  let source = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  source = source
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);
  fs.writeFileSync(GATI_INSTALLER_PATH, source, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const gatiInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
  const pre = String(scripts.prebuild || '')
    .split('&&')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== INSTALLER);
  const gatiIndex = pre.lastIndexOf(gatiInstaller);
  if (gatiIndex >= 0) pre.splice(gatiIndex, 0, INSTALLER);
  else pre.push(INSTALLER);
  scripts.prebuild = pre.join(' && ');
  scripts['test:arka-daily-expense-step-v1'] = 'node tools/verify-arka-daily-expense-step-v1.mjs';

  let build = String(scripts.build || '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('vite build anchor missing');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

patchComponent();
patchFinalVersionOwner();
patchPackage();
console.log('PASS ARKA daily expense step V1: visible pending requests, inline decisions, new expense entry and safe continuation.');
