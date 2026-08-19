import fs from 'node:fs';
import path from 'node:path';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const ROOT = process.cwd();

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(?:jsx?|tsx?)$/i.test(entry.name)) out.push(abs);
  }
  return out;
}

const homeCandidates = walk(path.join(ROOT, 'app'))
  .concat(fs.existsSync(path.join(ROOT, 'src')) ? walk(path.join(ROOT, 'src')) : [])
  .filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return /K[ËE]RKO\s+POROSIN[ËE]/i.test(source) && /KRIJO\s+POROSI/i.test(source) && /TEPIHA\s*PRO/i.test(source);
  });
check(homeCandidates.length === 1, `home search file count=${homeCandidates.length}`);
const home = homeCandidates.length === 1 ? fs.readFileSync(homeCandidates[0], 'utf8') : '';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const installer = fs.readFileSync('tools/apply-client-integrity-search-dedupe-v1.mjs', 'utf8');
const vite = fs.readFileSync('vite.config.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(home.includes('CLIENT_INTEGRITY_SEARCH_DEDUPE_V1'), 'home dedupe marker missing');
check(home.includes('function dedupeHomeSearchRowsV1'), 'home dedupe helper missing');
check(home.includes("aliases.push(`BASE:CODE:${Number(code)}`)"), 'BASE code identity guard missing');
check(home.includes('TRANSPORT:VISIT:'), 'repeat Transport visit identity guard missing');
check(home.includes('dedupeHomeSearchRowsV1(') && /dedupeHomeSearchRowsV1\([^)]*\)\.map\(/.test(home), 'search rendering is not deduped');
check(home.includes('rowScore'), 'DB-preferred duplicate selection missing');

const prebuild = String(pkg.scripts?.prebuild || '');
const command = 'node tools/apply-client-integrity-search-dedupe-v1.mjs';
const gati = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(command), 'client-integrity installer missing from prebuild');
check(prebuild.includes(gati), 'GATI final owner missing');
check(prebuild.lastIndexOf(command) < prebuild.lastIndexOf(gati), 'client-integrity installer must run before final version owner');
check(prebuild.trim().endsWith(gati), 'GATI compatible final version owner must remain last');
check(String(pkg.scripts?.build || '').includes('npm run test:client-integrity-search-dedupe-v1'), 'client-integrity verifier missing from full build');
check(String(pkg.scripts?.['test:client-integrity-search-dedupe-v1'] || '').includes('verify-client-integrity-search-dedupe-v1.mjs'), 'client-integrity test script missing');
check(String(pkg.version || '').includes('client-integrity-search-dedupe-v1'), 'package version missing client-integrity suffix');
check(gatiInstaller.includes('client-integrity-search-dedupe-v1'), 'final version owner can overwrite client-integrity build identity');
check(vite.includes('client-integrity-search-dedupe-v1'), 'PWA cache generation missing client-integrity suffix');
check(index.includes('client-integrity-search-dedupe-v1'), 'HTML build identity missing client-integrity suffix');
check(installer.includes('CLIENT_INTEGRITY_SEARCH_DEDUPE_V1'), 'installer marker missing');

if (failures.length) {
  console.error(`FAIL client integrity/search dedupe V1: ${failures.length} check(s)`);
  failures.forEach((failure, i) => console.error(`${i + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS client integrity/search dedupe V1: BASE duplicates collapse by order code/DB identity, Transport repeat visits stay separate, and final build identity is preserved.');
