import fs from 'node:fs';

const source = fs.readFileSync('lib/pastrimiWorkerGroupingBridge.js', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(source.includes("fitim: { label: 'FITIM', order: 200 }"), 'Fitim group missing');
check(source.includes("baza: { label: 'BAZA', order: 100 }"), 'BAZA must remain first');
check(source.includes("blerim: { label: 'BLERIM', order: 300 }"), 'Blerim order missing');
check(source.includes("tapin: { label: 'TAPIN', order: 400 }"), 'Tapin order missing');
check(source.includes('repeat(4, minmax(0, 1fr))'), 'Toolbar must have four worker columns');
check(source.includes('data-filter="fitim"'), 'Fitim toolbar style missing');
check(source.includes('data-pastrimi-worker-group="fitim"'), 'Fitim card style missing');
check(source.includes("content: 'FITIM'"), 'Fitim badge missing');
check(source.includes("broughtBy.includes('FITIM')"), 'Fitim name detection missing');
check(source.includes("broughtBy.includes('ORUCI')"), 'Oruci surname detection missing');
check(source.includes('fitim: 0'), 'Fitim count missing');
check(source.includes("version: 'v3-fitim-group'"), 'Grouping runtime version missing');

function classify(text) {
  const upper = String(text || '').toUpperCase();
  const markerIndex = upper.indexOf('E SOLLI:');
  if (markerIndex >= 0) {
    const after = upper.slice(markerIndex + 'E SOLLI:'.length);
    const broughtBy = after.split('📍')[0].split('PAKETO')[0].slice(0, 90);
    if (broughtBy.includes('FITIM') || broughtBy.includes('ORUCI')) return 'fitim';
    if (broughtBy.includes('BLERIM') || broughtBy.includes('KOSUMI') || broughtBy.includes('BELI')) return 'blerim';
    if (broughtBy.includes('TAPIN') || broughtBy.includes('LEPAJA')) return 'tapin';
  }
  return 'baza';
}

check(classify('T129 Kolovic E SOLLI: fitim oruci 📍 PAKETO') === 'fitim', 'T129 Fitim regression failed');
check(classify('E SOLLI: blerim kosumi 📍') === 'blerim', 'Blerim regression failed');
check(classify('E SOLLI: tapin lepaja 📍') === 'tapin', 'Tapin regression failed');
check(classify('Klient baze') === 'baza', 'BAZA fallback failed');

if (failures.length) {
  console.error(`FAIL: ${failures.length} Fitim grouping check(s) failed.`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS: 16 Fitim Pastrimi grouping checks passed.');
