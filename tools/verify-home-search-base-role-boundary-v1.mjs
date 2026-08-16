import fs from 'node:fs';
import { classifyHomeSearchRow, normalizeHomeSearchRow } from '../lib/homeSearch.js';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const poisonedBaseRow = {
  _table: 'transport_orders',
  _homeSearchSource: 'stale-device-cache',
  _homeSearchSourceRank: 35,
  id: 'b61ae118-525f-43e5-bee2-1f70b8422d7f',
  code: 'T281',
  client_name: 'Sheqir Gashi',
  client_phone: '+38344417778',
  status: 'dorzim',
  data: {
    db_id: 2944,
    code: 281,
    saved_order_code: 281,
    local_oid: 'b61ae118-525f-43e5-bee2-1f70b8422d7f',
    created_by_pin: '6203',
    created_by_name: 'bujar oruqi',
    created_by_role: 'PUNTOR',
    ready_by_name: 'bujar oruqi',
    ready_by_role: 'PUNTOR',
    pranimi_code_lifecycle: { final_code: 281, saved_order_code: 281 },
    tepiha: [
      { m2: 5.8, qty: 1 },
      { m2: 2, qty: 1 },
      { m2: 1.2, qty: 1 },
      { m2: 1.2, qty: 1 },
    ],
    tepihaRows: [
      { m2: 5.8, qty: 1 },
      { m2: 2, qty: 1 },
      { m2: 1.2, qty: 1 },
      { m2: 1.2, qty: 1 },
    ],
  },
};

const genuineTransportRow = {
  _table: 'transport_orders',
  id: 'dccca3fa-2ecd-4bb7-8412-35abd4f23170',
  code_n: 281,
  code_str: 'T281',
  client_tcode: 'T281',
  client_name: 'Kolovic',
  client_phone: '38345459838',
  status: 'done',
  data: {
    transport_id: '59c9755d-fbfc-4477-a3c0-9f0e6e936ff0',
    transport_pin: '1968',
    transport_name: 'tapin lepaja',
    driver_pin: '1968',
    driver_name: 'tapin lepaja',
    brought_by_name: 'tapin lepaja',
    tepiha: [{ m2: 6, qty: 1 }, { m2: 3.7, qty: 1 }],
  },
};

const cleanBase = normalizeHomeSearchRow(poisonedBaseRow);
const cleanTransport = normalizeHomeSearchRow(genuineTransportRow);

check(classifyHomeSearchRow(poisonedBaseRow) === 'BASE', 'stale T281 cache alias still classifies Sheqir Gashi as Transport');
check(cleanBase.kind === 'BASE', 'normalized Sheqir Gashi row is not BASE');
check(cleanBase.code === '281', 'BASE code T281 alias was not corrected to 281');
check(String(cleanBase.orderId) === '2944', 'BASE DB order id 2944 was not recovered from cached lifecycle data');
check(cleanBase.transporter === '', 'PUNTOR Bujar is still rendered as a transporter');
check(cleanBase.broughtBy === '', 'BASE row still exposes an E KA PRU transport label');
check(JSON.stringify(cleanBase.measurements) === JSON.stringify(['5.8', '2', '1.2', '1.2']), 'measurement chips are duplicated or changed');
check(cleanBase.classificationVersion === 'HOME_SEARCH_BASE_ROLE_BOUNDARY_V1', 'classification version marker missing');

check(classifyHomeSearchRow(genuineTransportRow) === 'TRANSPORT', 'genuine UUID T281 transport row was converted to BASE');
check(cleanTransport.kind === 'TRANSPORT', 'genuine transport normalization failed');
check(cleanTransport.code === 'T281', 'genuine transport T-code changed');
check(cleanTransport.broughtBy === 'tapin lepaja', 'genuine transporter name was lost');

const source = fs.readFileSync('lib/homeSearch.js', 'utf8');
const home = fs.readFileSync('app/page.jsx', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const arkaInstaller = fs.readFileSync('tools/apply-arka-daily-close-v2.mjs', 'utf8');
const arkaVerifier = fs.readFileSync('tools/verify-arka-daily-close-v2.mjs', 'utf8');

check(source.includes('HOME_SEARCH_BASE_ROLE_BOUNDARY_V1'), 'runtime boundary marker missing');
check(source.includes("if (hasStrongBaseIdentity(row)) return 'BASE';"), 'strong BASE identity does not override stale transport cache');
check(source.includes('pickExplicitBaseTransporter(row)'), 'BASE transporter role gate missing');
check(source.includes('groupSignatures'), 'measurement de-duplication missing');
check(home.includes('REGJISTRUAR NGA:'), 'BASE creator label is not neutral');
check(home.includes('TRANSPORTI:'), 'explicit BASE transport label missing');
check(home.includes('E KA PRU:'), 'real Transport detail was removed');

const prebuild = String(pkg.scripts?.prebuild || '');
check(prebuild.includes('apply-home-search-base-role-boundary-v1.mjs'), 'final boundary installer is not in prebuild');
check(prebuild.trim().endsWith('node tools/apply-arka-daily-close-v2.mjs'), 'ARKA final installer is no longer last');
check(prebuild.indexOf('apply-home-search-base-role-boundary-v1.mjs') < prebuild.lastIndexOf('apply-arka-daily-close-v2.mjs'), 'boundary installer does not run before final version owner');
check(String(pkg.scripts?.build || '').includes('test:home-search-base-role-boundary-v1'), 'boundary verifier is not in full build');
check(String(pkg.version || '').includes('home-search-base-role-v1'), 'package build id was not bumped');
check(arkaInstaller.includes('home-search-base-role-v1'), 'final ARKA version owner does not preserve the search fix build id');
check(arkaVerifier.includes('home-search-base-role-v1'), 'ARKA verifier does not accept the combined cache generation');

if (failures.length) {
  console.error(`FAIL home search BASE/Transport role boundary V1: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS home search BASE/Transport role boundary V1: Sheqir #281 stays BASE, Bujar stays PUNTOR, genuine T281 remains Transport, and measures are not duplicated.');
