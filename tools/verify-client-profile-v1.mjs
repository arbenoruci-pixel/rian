import fs from 'node:fs';
import {
  CLIENT_PROFILE_SOURCE,
  buildClientProfileAnchor,
  orderBelongsToClientProfile,
  selectUniqueClientByPhone,
} from '../lib/clientProfileIdentity.js';

const failures = [];
const check = (ok, label) => {
  if (ok) console.log(`PASS ${label}`);
  else failures.push(label);
};
const baseClientId = '11111111-1111-4111-8111-111111111111';
const otherClientId = '22222222-2222-4222-8222-222222222222';
const transportOrderId = '33333333-3333-4333-8333-333333333333';

const baseAnchor = buildClientProfileAnchor({
  source: 'orders', id: 382, code: '382', client_id: baseClientId, name: 'I njëjti emër', phone: '+383 44 111 222',
});
check(baseAnchor.source === CLIENT_PROFILE_SOURCE.BASE && baseAnchor.orderId === '382', 'numeric order ID stays in BASE');
check(baseAnchor.clientId === baseClientId, 'BASE anchor preserves canonical client_id');

const transportAnchor = buildClientProfileAnchor({
  source: 'transport_orders', id: transportOrderId, code: 'T1225', client_id: otherClientId,
});
check(transportAnchor.source === CLIENT_PROFILE_SOURCE.TRANSPORT && transportAnchor.orderId === transportOrderId, 'Transport opens by exact visit UUID');

const unique = selectUniqueClientByPhone([
  { id: baseClientId, phone: '+383 44 111 222' },
  { id: otherClientId, phone: '+383 44 999 000' },
], '044 111 222');
check(unique.status === 'unique' && unique.client.id === baseClientId, 'formatted phone resolves only one canonical client');

const conflict = selectUniqueClientByPhone([
  { id: baseClientId, phone: '+383 44 111 222' },
  { id: otherClientId, phone: '044111222' },
], '+38344111222');
check(conflict.status === 'conflict' && !conflict.client, 'duplicate phone identity blocks automatic merge');
check(!orderBelongsToClientProfile({ client_id: otherClientId, client_phone: '+38344111222' }, { clientId: baseClientId, phone: '+38344111222' }), 'different linked client_id wins over matching phone');
check(orderBelongsToClientProfile({ client_id: null, client_phone: '044111222' }, { clientId: baseClientId, phone: '+38344111222' }), 'unlinked legacy visit may match exact normalized phone');
check(!orderBelongsToClientProfile({ client_id: null, client_name: 'I njëjti emër', client_phone: '044999000' }, { clientId: baseClientId, phone: '+38344111222' }), 'same name never merges a different phone');

const server = fs.readFileSync('lib/clientProfileServer.js', 'utf8');
const api = fs.readFileSync('api/client-profile.js', 'utf8');
const component = fs.readFileSync('components/ClientProfileSheet.jsx', 'utf8');
const pastrimi = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const gati = fs.readFileSync('app/gati/page.jsx', 'utf8');
const expressServer = fs.readFileSync('server/index.mjs', 'utf8');

check(server.includes(".eq('client_id', client.id)") && server.includes(".is('client_id', null)"), 'history queries separate canonical and legacy-unlinked visits');
check(!/\.ilike\([^\n]*(name|client_name)/i.test(server), 'server never joins client history by name');
check(server.includes('CLIENT_PROFILE_PHONE_IDENTITY_CONFLICT'), 'ambiguous phone linking fails closed');
check(api.includes("readCookie(req, 'tepiha_device_id')") && api.includes('authenticateClientProfileViewer'), 'profile API requires an approved device user');
check(api.includes('requestOriginAllowed') && api.includes('private, no-store'), 'profile API is same-origin and never publicly cached');
check(component.includes('HAP VIZITËN E SAKTË') && component.includes('buildHomeSearchHref'), 'history opens exact order routes');
check(component.includes('THIRR') && component.includes('MESAZH') && component.includes('HARTA'), 'client card includes operational contact tools');
for (const [file, source] of [['Pastrimi', pastrimi], ['Gati', gati]]) {
  check(source.includes("import('@/components/ClientProfileSheet')") && source.includes('setClientProfileAnchor(o)'), `${file} opens the shared client card from the client name`);
  check(source.includes('client_id'), `${file} carries canonical client_id into the card`);
}
check(expressServer.includes("app.post('/api/client-profile', clientProfileHandler)"), 'local/production-compatible server exposes one profile endpoint');

if (failures.length) {
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}
console.log('PASS: client profile identity and routing stay canonical across Pastrimi and Gati.');
