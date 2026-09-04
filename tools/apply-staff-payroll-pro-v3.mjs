import fs from 'node:fs';

const MARKER = 'STAFF_PAYROLL_PRO_V3';
const INSTALLER_CMD = 'node tools/apply-staff-payroll-pro-v3.mjs';
const TEST_CMD = 'npm run test:staff-payroll-pro-v3';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, source) { fs.writeFileSync(path, source, 'utf8'); }
function fail(label) { throw new Error(`${MARKER}: ${label}`); }
function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) fail(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}
function replaceAllRequired(source, oldText, newText, label, min = 1) {
  if (source.includes(newText) && !source.includes(oldText)) return source;
  const count = source.split(oldText).length - 1;
  if (count < min) fail(`${label}: expected >=${min}, found ${count}`);
  return source.split(oldText).join(newText);
}
function patchFunction(source, startMarker, endMarker, patcher, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) fail(`${label}: start missing`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) fail(`${label}: end missing`);
  const block = source.slice(start, end);
  const next = patcher(block);
  if (!next || next === block) {
    if (!block.includes(MARKER)) fail(`${label}: patch produced no change`);
    return source;
  }
  return `${source.slice(0, start)}${next}${source.slice(end)}`;
}
function addImport(source, anchor, line, label) {
  if (source.includes(line)) return source;
  return replaceOnce(source, anchor, `${anchor}\n${line}`, label);
}

function patchPayroll() {
  const path = 'app/arka/payroll/page.jsx';
  let source = read(path);
  source = addImport(
    source,
    "import WorkerCompensationEditor from '@/components/WorkerCompensationEditor';",
    "import { createWorkerAdvance } from '@/lib/arka/workerControlClient';",
    'payroll worker-control import',
  );

  source = source.replace(
    "  const normalizedRole = String(actor?.role || '').toUpperCase();\n  const isAdminUser = ['ADMIN', 'ADMIN_MASTER', 'DISPATCH', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(normalizedRole);\n  const canManageStaffIdentity = isStaffAdmin(normalizedRole);",
    "  const normalizedRole = String(actor?.role || '').toUpperCase();\n  const isMasterActor = actor?.is_master === true || String(actor?.is_master || '').toLowerCase() === 'true';\n  const isAdminUser = ['ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(normalizedRole) || (normalizedRole === 'DISPATCH' && isMasterActor);\n  const canManageStaffIdentity = isStaffAdmin(normalizedRole) || (normalizedRole === 'DISPATCH' && isMasterActor); // STAFF_PAYROLL_PRO_V3",
  );
  if (!source.includes('const isMasterActor =')) fail('payroll manager role patch missing');

  if (!source.includes('setMasterPin(String(a?.pin || ""));')) {
    source = replaceOnce(
      source,
      '      setActor(a);',
      '      setActor(a);\n      setMasterPin(String(a?.pin || "")); // STAFF_PAYROLL_PRO_V3: approved session actor replaces hidden second PIN.',
      'payroll actor pin hydration',
    );
  }

  source = source.replace(
    "      const role = String(a?.role || '').toUpperCase();\n      if (![\"ADMIN\", \"ADMIN_MASTER\", \"DISPATCH\", \"OWNER\", \"PRONAR\", \"SUPERADMIN\"].includes(role)) {",
    "      const role = String(a?.role || '').toUpperCase();\n      const masterActor = a?.is_master === true || String(a?.is_master || '').toLowerCase() === 'true';\n      const payrollAllowed = [\"ADMIN\", \"ADMIN_MASTER\", \"OWNER\", \"PRONAR\", \"SUPERADMIN\"].includes(role) || (role === 'DISPATCH' && masterActor);\n      if (!payrollAllowed) {",
  );
  if (!source.includes('const payrollAllowed =')) fail('payroll boot access patch missing');

  source = patchFunction(
    source,
    '  async function reloadAll(isSilent = false) {',
    '\n  async function reloadMonthlyPayrollPreview',
    (block) => {
      if (block.includes('STAFF_PAYROLL_PRO_V3: ACTIVE ADVANCES ONLY')) return block;
      const start = block.indexOf('      const rawDebts = await withTimeout(');
      const endMarker = '      setDebtsMap(dMap);';
      const endAt = block.indexOf(endMarker, start);
      if (start < 0 || endAt < 0) fail('payroll reload advances block missing');
      const end = endAt + endMarker.length;
      const replacement = `      // STAFF_PAYROLL_PRO_V3: ACTIVE ADVANCES ONLY. Rejected expenses, business\n      // expenses and worker debts are separate concepts and never enter payroll advances.\n      const activeAdvanceQuery = supabase\n        .from('arka_pending_payments')\n        .select('amount,created_by_pin,created_by_name,type,status')\n        .eq('type', 'ADVANCE')\n        .eq('status', 'ADVANCE')\n        .limit(5000);\n      const activeAdvanceRes = await withTimeout(activeAdvanceQuery, DB_TIMEOUT_MS, 'arka_payroll_advances_timeout');\n      if (activeAdvanceRes?.error) throw activeAdvanceRes.error;\n\n      const dMap = {};\n      (Array.isArray(activeAdvanceRes?.data) ? activeAdvanceRes.data : []).forEach((row) => {\n        const amount = Number(row?.amount || 0);\n        const pin = String(row?.created_by_pin || '').trim();\n        const name = String(row?.created_by_name || '').trim().toUpperCase();\n        if (!(amount > 0)) return;\n        if (pin) dMap[\`PIN:\${pin}\`] = (dMap[\`PIN:\${pin}\`] || 0) + amount;\n        if (name) dMap[\`NAME:\${name}\`] = (dMap[\`NAME:\${name}\`] || 0) + amount;\n      });\n      setDebtsMap(dMap);`;
      return `${block.slice(0, start)}${replacement}${block.slice(end)}`;
    },
    'payroll reloadAll',
  );

  source = replaceAllRequired(
    source,
    'const autoDebt = Number(debtsMap[workerName] || 0);',
    "const autoDebt = Number(debtsMap[`PIN:${String(u?.pin || '').trim()}`] || debtsMap[`NAME:${workerName}`] || 0);",
    'payroll active advance lookup',
    2,
  );

  source = patchFunction(
    source,
    '  async function handleAddAdvance() {',
    '\n  const payableAmount',
    (block) => {
      let next = block;
      next = next.replace(
        '    if (!advanceModal || !masterPin) {\n      alert("Kërkohet Master PIN për këtë veprim.");',
        '    if (!advanceModal || !actor?.pin) {\n      alert("Kërkohet sesion i aprovuar i Boss/Admin për këtë veprim.");',
      );
      const callStart = next.indexOf('      await arkaTransaction({');
      const callEndMarker = '      });';
      const callEndAt = next.indexOf(callEndMarker, callStart);
      if (callStart < 0 || callEndAt < 0) fail('handleAddAdvance transaction call missing');
      const callEnd = callEndAt + callEndMarker.length;
      const replacement = `      // ${MARKER}: secure, atomic advance; no invisible Master PIN.\n      const result = await createWorkerAdvance({\n        workerPin: advanceModal?.pin || '',\n        amount: amt,\n        note: String(advanceNote || 'AVANS').trim() || 'AVANS',\n      });\n      if (result?.ok === false) throw new Error(result?.error || 'WORKER_ADVANCE_FAILED');`;
      next = `${next.slice(0, callStart)}${replacement}${next.slice(callEnd)}`;
      next = next.replace(
        '      await reloadAll(false);',
        '      await reloadAll(false);\n      await reloadMonthlyPayrollPreview(payrollMonth);',
      );
      return next;
    },
    'handleAddAdvance',
  );

  source = replaceAllRequired(
    source,
    'if (!salaryModal || !masterPin) {',
    'if (!salaryModal || !actor?.pin) {',
    'salary hidden master pin gates',
    2,
  );
  source = replaceAllRequired(
    source,
    "actorPin: String(masterPin || '').trim(),",
    "actorPin: String(actor?.pin || '').trim(),",
    'salary actor pin',
    1,
  );
  source = source.split("String(masterPin || workerPin || 'MASTER')").join("String(actor?.pin || workerPin || 'MASTER')");

  if (source.includes('if (!advanceModal || !masterPin)')) fail('advance still depends on hidden masterPin');
  if (source.includes('select: "amount, created_by_name"') && source.includes('["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"]')) {
    fail('rejected expenses still mixed into advance map');
  }
  write(path, source);
}

function patchStaff() {
  const path = 'app/arka/stafi/page.jsx';
  let source = read(path);
  source = source.replace(
    "  const normalizedRole = String(actor?.role || '').toUpperCase();\n  const canManageStaff = isStaffAdmin(normalizedRole);",
    "  const normalizedRole = String(actor?.role || '').toUpperCase();\n  const isMasterActor = actor?.is_master === true || String(actor?.is_master || '').toLowerCase() === 'true';\n  const canManageStaff = isStaffAdmin(normalizedRole) || (normalizedRole === 'DISPATCH' && isMasterActor); // STAFF_PAYROLL_PRO_V3",
  );
  if (!source.includes('const isMasterActor =')) fail('staff manager role patch missing');

  source = source.replace(
    "      const role = String(a?.role || '').toUpperCase();\n      if (!isStaffAdmin(role)) {",
    "      const role = String(a?.role || '').toUpperCase();\n      const masterActor = a?.is_master === true || String(a?.is_master || '').toLowerCase() === 'true';\n      if (!(isStaffAdmin(role) || (role === 'DISPATCH' && masterActor))) {",
  );

  if (!source.includes('HAP KARTELËN')) {
    source = replaceOnce(
      source,
      '                    <div className="staffActions">\n                      <button className="editBtn" onClick={() => startEdit(u)}>',
      `                    <div className="staffActions">\n                      <Link prefetch={false} href={\`/arka/puntor/\${u.pin}\`} style={{ textDecoration:'none', border:'1px solid #2563eb', borderRadius:12, background:'#eff6ff', color:'#1d4ed8', padding:'10px 12px', fontWeight:900, textAlign:'center' }}>HAP KARTELËN</Link>\n                      <Link prefetch={false} href={\`/arka/puntor/\${u.pin}?action=advance\`} style={{ textDecoration:'none', border:'1px solid #059669', borderRadius:12, background:'#ecfdf5', color:'#047857', padding:'10px 12px', fontWeight:900, textAlign:'center' }}>+ AVANS</Link>\n                      <button className="editBtn" onClick={() => startEdit(u)}>`,
      'staff card actions',
    );
  }
  write(path, source);
}

function patchWorkerDetail() {
  const path = 'app/arka/puntor/[pin]/page.jsx';
  let source = read(path);
  source = addImport(
    source,
    "import ArkaUnifiedWorkerAccount from '@/components/ArkaUnifiedWorkerAccount';",
    "import WorkerControlCenter from '@/components/WorkerControlCenter';",
    'worker detail control-center import',
  );

  const exact = '<ArkaUnifiedWorkerAccount actor={actor} targetPin={pin} title={worker?.name || pin} showManagerLinks={canManage} />';
  if (source.includes(exact)) {
    source = source.replace(exact, '<WorkerControlCenter actor={actor} targetPin={pin} worker={worker} />');
  } else if (!source.includes('<WorkerControlCenter actor={actor} targetPin={pin}')) {
    const re = /<ArkaUnifiedWorkerAccount\s+actor=\{actor\}\s+targetPin=\{pin\}[\s\S]*?\/>/;
    if (!re.test(source)) fail('worker detail canonical render missing');
    source = source.replace(re, '<WorkerControlCenter actor={actor} targetPin={pin} worker={worker} />');
  }
  write(path, source);
}

function patchAuth() {
  const loginPath = 'api/auth/login.js';
  let login = read(loginPath);
  login = login.split(".select('id, pin, role, name, is_active, is_hybrid_transport')").join(".select('id, pin, role, name, is_active, is_hybrid_transport, is_master')");
  if (!login.includes('is_master: user.is_master === true')) {
    login = replaceOnce(
      login,
      '        is_hybrid_transport: user.is_hybrid_transport === true,',
      '        is_hybrid_transport: user.is_hybrid_transport === true,\n        is_master: user.is_master === true, // STAFF_PAYROLL_PRO_V3',
      'login is_master actor',
    );
  }
  write(loginPath, login);

  const serverPath = 'server/index.mjs';
  let server = read(serverPath);
  server = server.split(".select('id, pin, role, name, is_active, is_hybrid_transport')").join(".select('id, pin, role, name, is_active, is_hybrid_transport, is_master')");
  if (!server.includes('is_master: user.is_master === true')) {
    server = replaceOnce(
      server,
      '        is_hybrid_transport: user.is_hybrid_transport === true,',
      '        is_hybrid_transport: user.is_hybrid_transport === true,\n        is_master: user.is_master === true, // STAFF_PAYROLL_PRO_V3',
      'server login is_master actor',
    );
  }
  if (!server.includes("import workerControlHandler from '../api/arka/worker-control.js';")) {
    server = replaceOnce(
      server,
      "import arkaTransactionHandler from '../api/arka/transaction.js';",
      "import arkaTransactionHandler from '../api/arka/transaction.js';\nimport workerControlHandler from '../api/arka/worker-control.js';",
      'server worker-control import',
    );
  }
  if (!server.includes("app.post('/api/arka/worker-control', workerControlHandler);")) {
    server = replaceOnce(
      server,
      "app.post('/api/arka/transaction', arkaTransactionHandler);",
      "app.post('/api/arka/transaction', arkaTransactionHandler);\napp.post('/api/arka/worker-control', workerControlHandler);",
      'server worker-control route',
    );
  }
  write(serverPath, server);
}

function patchBuildIdentity() {
  const pkgPath = 'package.json';
  const pkg = JSON.parse(read(pkgPath));
  const prebuild = String(pkg.scripts?.prebuild || '');
  if (!prebuild.includes(INSTALLER_CMD)) pkg.scripts.prebuild = `${prebuild} && ${INSTALLER_CMD}`.trim();
  pkg.scripts['test:staff-payroll-pro-v3'] = 'node tools/verify-staff-payroll-pro-v3.mjs';
  const build = String(pkg.scripts?.build || '');
  if (!build.includes(TEST_CMD)) {
    if (!build.includes('vite build')) fail('package build vite anchor missing');
    pkg.scripts.build = build.replace('vite build', `${TEST_CMD} && vite build`);
  }
  if (!String(pkg.version || '').includes('staff-payroll-pro-v3')) {
    pkg.version = `${String(pkg.version || '2.0.0')}-staff-payroll-pro-v3`;
  }
  write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  for (const path of ['lib/appEpoch.js', 'vite.config.js', 'index.html']) {
    let source = read(path);
    if (!source.includes('staff-payroll-pro-v3')) {
      source = source.split('gati-payment-fast-receipt-v1').join('gati-payment-fast-receipt-v1-staff-payroll-pro-v3');
    }
    write(path, source);
  }
}

patchPayroll();
patchStaff();
patchWorkerDetail();
patchAuth();
patchBuildIdentity();
console.log(`PASS ${MARKER}: payroll, staff, worker card, auth and build wiring patched.`);
