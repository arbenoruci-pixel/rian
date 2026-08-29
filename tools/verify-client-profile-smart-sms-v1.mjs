import fs from 'node:fs';
import {
  buildClientProfileSmartSms,
  findExactClientProfileMessageVisit,
  resolveClientProfileSmartSmsAction,
} from '../lib/clientProfileSmartSms.js';

const failures = [];
function check(condition, label) {
  if (condition) console.log(`PASS ${label}`);
  else failures.push(label);
}

const baseProfile = {
  client: { name: 'Arta Berisha', phone: '044 111 222' },
  visits: [
    {
      id: '999', source: 'BASE', code: '999', status: 'gati', current: false, active: true,
      pieces: 1, m2: 4, total: 8, debt: 8,
    },
    {
      id: '382', source: 'BASE', code: '1202', status: 'pastrim', current: true, active: true,
      pieces: 3, m2: 12.5, total: 22.5, debt: 22.5,
    },
  ],
};

const baseAnchor = { source: 'BASE', orderId: '382' };
const baseVisit = findExactClientProfileMessageVisit(baseProfile, baseAnchor);
check(baseVisit?.id === '382', 'message selects the exact anchored visit, not another active/newer visit');
check(resolveClientProfileSmartSmsAction(baseVisit) === 'pranimi_baze', 'BASE Pastrim resolves to the existing acceptance/cleaning Smart SMS');

const basePastrim = buildClientProfileSmartSms(baseProfile, baseAnchor);
check(basePastrim.ready && basePastrim.action === 'pranimi_baze', 'BASE Pastrim Smart SMS is ready only for the exact live visit');
check(basePastrim.messageText.includes('procesi i pastrimit profesional ka filluar'), 'Pastrimi message tells the client cleaning is in progress');
check(basePastrim.messageText.includes('/k/382?src=base'), 'Pastrimi message keeps the exact BASE order tracking link');
check(!basePastrim.messageText.includes('/k/999'), 'another active visit never leaks into the message');

const baseReadyProfile = {
  ...baseProfile,
  visits: [{ ...baseProfile.visits[1], status: 'gati' }],
};
const baseReady = buildClientProfileSmartSms(baseReadyProfile, baseAnchor);
check(baseReady.action === 'gati_baze' && baseReady.messageText.includes('janë GATI'), 'Gati uses the existing BASE ready Smart SMS');
check(baseReady.messageText.includes('/k/382?src=base'), 'Gati keeps the exact BASE order tracking link');

const transportId = '7e826204-6aca-4c84-9804-a6e3c525d3b3';
const transportAnchor = { source: 'TRANSPORT', orderId: transportId };
const transportProfile = {
  client: { name: 'Dren Gashi', phone: '+38344123456' },
  visits: [{
    id: transportId, source: 'TRANSPORT', code: 'T1225', status: 'pastrimi', current: true, active: true,
    pieces: 4, m2: 15.2, total: 27.36, debt: 27.36,
  }],
};
const transportPastrim = buildClientProfileSmartSms(transportProfile, transportAnchor);
check(transportPastrim.action === 'transport_pranimi', 'Transport Pastrim uses the existing transport acceptance Smart SMS');
check(transportPastrim.messageText.includes('u pranuan me sukses për larje'), 'Transport Pastrim tells the client the rugs are being cleaned');
check(transportPastrim.messageText.includes(`/k/${transportId}?src=transport`), 'Transport message keeps the exact visit UUID tracking link');

const transportReady = buildClientProfileSmartSms({
  ...transportProfile,
  visits: [{ ...transportProfile.visits[0], status: 'gati' }],
}, transportAnchor);
check(transportReady.action === 'status_neutral' && transportReady.messageText.includes('GATI'), 'Transport Gati uses a status-safe message from the shared Smart SMS engine');
check(!transportReady.messageText.includes('brenda 1 ore'), 'profile message does not promise an unplanned one-hour Transport departure');
check(transportReady.messageText.includes(`/k/${transportId}?src=transport`), 'neutral Transport status still keeps the exact tracking link');

const wrongAnchor = buildClientProfileSmartSms(baseProfile, { source: 'BASE', orderId: '777' });
check(!wrongAnchor.ready && !wrongAnchor.messageText, 'messaging fails closed when the exact anchored visit is absent');

const terminalProfile = {
  ...baseProfile,
  visits: [{ ...baseProfile.visits[1], status: 'done', active: false }],
};
check(!buildClientProfileSmartSms(terminalProfile, baseAnchor).ready, 'inactive/history-only visits cannot drive the primary message button');

const component = fs.readFileSync('components/ClientProfileSheet.jsx', 'utf8');
check(component.includes('buildClientProfileSmartSms(profile, anchor)'), 'client card delegates copy to the shared Smart SMS adapter');
check(component.includes('smartSms.ready && !loading && !fromCache'), 'message button waits for fresh live profile data');
check(component.includes('messageText={smartSms.messageText}'), 'SmartSmsModal receives the generated status message');
check(!component.includes('function buildMessage(profile)'), 'old generic profile message is removed');

if (failures.length) {
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS: client profile Smart SMS stays status-aware, exact-visit, and live-data safe.');
