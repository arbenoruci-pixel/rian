import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const read = (path) => fs.readFileSync(path, 'utf8');

const control = read('components/WorkerControlCenter.jsx');
const client = read('lib/arka/workerControlClient.js');
const api = read('api/arka/worker-control.js');
const payroll = read('app/arka/payroll/page.jsx');
const staff = read('app/arka/stafi/page.jsx');
const detail = read('app/arka/puntor/[pin]/page.jsx');
const login = read('api/auth/login.js');
const server = read('server/index.mjs');
const migration = read('supabase/migrations/20260904160000_staff_payroll_pro_v3.sql');
const pkg = JSON.parse(read('package.json'));

check(control.includes('STAFF_PAYROLL_PRO_V3'), 'worker control marker missing');
check(control.includes('+ JEP AVANS'), 'advance action missing from worker card');
check(control.includes('AVANSET AKTIVE'), 'active advances tab missing');
check(control.includes('KËRKESAT NË PRITJE'), 'approvals tab missing');
check(control.includes('HISTORIA E PUNTORIT'), 'worker history tab missing');
check(control.includes('KUSHTET E PAGESËS'), 'compensation settings tab missing');
check(control.includes(".eq('type', 'ADVANCE')") && control.includes(".eq('status', 'ADVANCE')"), 'worker card active-advance filter is not exact');
check(control.includes("resolveWorkerExpense"), 'worker card approval action missing');
check(control.includes("actor?.is_master === true"), 'master-dispatch access missing from worker card');
check(control.includes('Nuk kërkohet një Master PIN i dytë'), 'clear no-second-PIN UX missing');

check(client.includes("action: 'CREATE_ADVANCE'"), 'advance client action missing');
check(client.includes("action: 'RESOLVE_EXPENSE'"), 'expense decision client action missing');
check(client.includes("credentials: 'include'"), 'worker control client does not send approved-device cookie');

check(api.includes('authenticateManager'), 'worker control API authentication missing');
check(api.includes(".select('id,pin,name,role,is_active,is_master')"), 'worker control API is_master lookup missing');
check(api.includes("supabase.rpc('create_worker_advance_pro_v1'"), 'secure advance RPC missing from API');
check(api.includes("supabase.rpc('resolve_arka_expense_v2'"), 'expense decision RPC missing from API');
check(!api.includes('p_actor_pin: body'), 'API trusts a client-supplied actor PIN');

check(payroll.includes("import { createWorkerAdvance } from '@/lib/arka/workerControlClient';"), 'payroll worker-control client import missing');
check(payroll.includes('STAFF_PAYROLL_PRO_V3: ACTIVE ADVANCES ONLY'), 'payroll active-advance source marker missing');
check(payroll.includes(".eq('type', 'ADVANCE')") && payroll.includes(".eq('status', 'ADVANCE')"), 'payroll does not use exact active-advance filters');
check(!payroll.includes('if (!advanceModal || !masterPin)'), 'payroll advance still asks for an invisible Master PIN');
check(!payroll.includes('if (!salaryModal || !masterPin)'), 'payroll salary still asks for an invisible Master PIN');
check(!payroll.includes('["REJECTED", "OWED", "WORKER_DEBT", "ADVANCE"]'), 'rejected expenses still enter payroll advance totals');
check(payroll.includes('createWorkerAdvance({'), 'payroll advance does not use canonical secure API');
check(payroll.includes("normalizedRole === 'DISPATCH' && isMasterActor"), 'payroll dispatch-master permission missing');

check(staff.includes('HAP KARTELËN'), 'staff worker-card link missing');
check(staff.includes('?action=advance'), 'staff one-click advance link missing');
check(staff.includes("normalizedRole === 'DISPATCH' && isMasterActor"), 'staff dispatch-master permission missing');
check(detail.includes("import WorkerControlCenter from '@/components/WorkerControlCenter';"), 'worker detail control-center import missing');
check(detail.includes('<WorkerControlCenter actor={actor} targetPin={pin} worker={worker} />'), 'worker detail canonical control-center render missing');

check(login.includes('is_master'), 'Vercel login actor lacks is_master');
check(server.includes('is_master'), 'local login actor lacks is_master');
check(server.includes("app.post('/api/arka/worker-control', workerControlHandler);"), 'local worker-control route missing');

check(migration.includes('create_worker_advance_pro_v1'), 'advance wrapper migration missing');
check(migration.includes('coalesce(v_actor.is_master,false)'), 'migration does not protect master-dispatch access');
check(migration.includes("'ADVANCE_RECEIVED','PAYMENT'"), 'advance worker-history event missing');
check(migration.includes('worker_history_refresh_snapshots_v1'), 'worker history snapshots are not refreshed');
check(migration.includes('grant execute') && migration.includes('service_role'), 'advance RPC is not restricted to server service role');

check(String(pkg.scripts?.prebuild || '').includes('node tools/apply-staff-payroll-pro-v3.mjs'), 'installer missing from prebuild');
check(String(pkg.scripts?.build || '').includes('npm run test:staff-payroll-pro-v3'), 'verifier missing from full build');
check(String(pkg.scripts?.['test:staff-payroll-pro-v3'] || '').includes('verify-staff-payroll-pro-v3.mjs'), 'test script missing');
check(String(pkg.version || '').includes('staff-payroll-pro-v3'), 'build version missing staff-payroll suffix');

if (failures.length) {
  console.error(`FAIL STAFF_PAYROLL_PRO_V3: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS STAFF_PAYROLL_PRO_V3: one worker card, exact advances, device-authenticated writes, approvals, payroll and history are wired.');
