import fs from 'node:fs';

const dispatch = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
const ordersService = fs.readFileSync('lib/ordersService.js', 'utf8');
const board = fs.readFileSync('app/transport/board/page.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(dispatch.includes('LIROJA TRANSPORTUESIT'), 'dedicated Dispatch release control is missing');
check(dispatch.includes('TRANSPORTUESI QË E MERR POROSINË'), 'transporter chooser label is missing');
check(dispatch.includes('PA TRANSPORTUES — MBETET VETËM TE DISPATCH'), 'unassigned visibility warning is missing');
check(!dispatch.includes('PA SHOFER – TË GJITHË E SHOHIN INBOX'), 'false all-drivers visibility label is still present');

check(dispatch.includes('drivers.find((d) => rowMatchesDriver(row, d))'), 'legacy UUID/PIN/name driver matching is missing');
check(dispatch.includes('drivers.find((d) => driverStableId(d) === String(editDriver || ""))'), 'stable selected-driver lookup is missing');
check(dispatch.includes('transport_id: editDriver || null'), 'transport UUID ownership write is missing');
check(dispatch.includes('transport_user_id: editDriver || null'), 'transport user ownership write is missing');
check(dispatch.includes('assigned_driver_id: editDriver || null'), 'assigned driver ownership write is missing');
check(dispatch.includes('transport_pin: pickedDriverPin || null'), 'transport PIN ownership write is missing');
check(dispatch.includes('driver_pin: pickedDriverPin || null'), 'driver PIN ownership write is missing');

check(dispatch.includes("const activeOk = u?.is_active !== false"), 'inactive users are not excluded');
check(dispatch.includes("roleOk || hybridOk"), 'active transport/hybrid eligibility is missing');
check(dispatch.includes('resolveAssignPlanStatus(currentStatus, !!editDriver)'), 'assignment lifecycle resolver is not used');
check(ordersService.includes('TRANSPORT_PROTECTED_LIFECYCLE_STATUSES'), 'server-side lifecycle protection is missing');
check(ordersService.includes("'gati'") && ordersService.includes("'delivery'"), 'ready/delivery statuses are not protected');
check(board.includes('function rowOwnedBySession'), 'transport board ownership filter is missing');
check(board.includes('data?.assigned_driver_id') && board.includes('data?.transport_pin'), 'transport board cannot resolve release ownership');

if (failures.length) {
  console.error(`FAIL dispatch driver release V1: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS dispatch driver release V1: active-driver choice, legacy matching, ownership writes and lifecycle protection verified.');
