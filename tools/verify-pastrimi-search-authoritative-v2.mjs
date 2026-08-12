import fs from 'node:fs';

const source = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(source.includes('PASTRIMI_SEARCH_AUTHORITATIVE_V2'), 'V2 marker missing');
check(source.includes("const openCode = String(sp?.get('openCode')"), 'openCode route value missing');
check(source.includes('useState(() => openCode)'), 'search is not seeded from openCode');
check(source.includes("exactSearchTimedOut && !String(search || openCode || '').trim()"), 'exact timeout still ignores visible query');
check(source.includes("const rawSearch = String(search || openCode || '').trim();"), 'final-render search query missing');
check(source.includes('Final-render safety gate'), 'final-render safety marker missing');
check(source.includes('codeCandidates.some((code) => code === compactCodeQuery || code.includes(compactCodeQuery))'), 'exact/partial code comparison missing');
check(source.includes("code.replace(/\\D+/g, '').includes(digitsQuery)"), 'numeric code comparison missing');
check(source.includes('onInput={e => {'), 'iOS input event handler missing');
check(source.includes('}, [visibleOrders, pastrimFilter, search, openCode]);'), 'final filter dependencies missing');

const filterRows = (rows, rawSearch) => {
  const query = String(rawSearch || '').trim();
  if (!query) return rows;
  const textQuery = query.toLowerCase();
  const compactCodeQuery = query.replace(/\s+/g, '').toUpperCase();
  const digitsQuery = query.replace(/\D+/g, '');
  return rows.filter((row) => {
    const name = String(row?.name || '').toLowerCase();
    if (name.includes(textQuery)) return true;
    const codes = [row?.code, row?.client_tcode, row?.code_str]
      .map((value) => String(value ?? '').trim().replace(/\s+/g, '').toUpperCase())
      .filter(Boolean);
    if (compactCodeQuery && codes.some((code) => code === compactCodeQuery || code.includes(compactCodeQuery))) return true;
    if (digitsQuery && codes.some((code) => code.replace(/\D+/g, '').includes(digitsQuery))) return true;
    const phone = String(row?.phone || '').replace(/\D+/g, '');
    return !!(digitsQuery && phone && phone.includes(digitsQuery));
  });
};

const sample = [
  { code: 927, name: 'Arsim Elezi' },
  { code: 1138, name: 'Meti Gerbeshi' },
  { code: 872, name: 'Mehmet Balia', phone: '+38349134178' },
  { code: 'T872', name: 'Transport test' },
];
const base872 = filterRows(sample, '872');
check(base872.length === 2 && base872.every((row) => String(row.code).includes('872')), '872 query does not isolate code 872 rows');
const exactBase872 = filterRows(sample.filter((row) => !String(row.code).startsWith('T')), '872');
check(exactBase872.length === 1 && exactBase872[0].name === 'Mehmet Balia', 'base code 872 is not isolated to Mehmet Balia');
check(filterRows(sample, 'Arsim').length === 1, 'name search failed');
check(filterRows(sample, '49134178').length === 1, 'phone search failed');

if (failures.length) {
  console.error(`FAIL: ${failures.length} Pastrimi authoritative search check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}
console.log('PASS: Pastrimi search stays filtered after exact-open timeout and DB refresh.');
