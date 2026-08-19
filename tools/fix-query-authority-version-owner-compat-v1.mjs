import fs from 'node:fs';

const path = 'tools/verify-home-search-query-authority-transport-guard-v6.mjs';
let source = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    `check(packageJson.includes('2.0.115-query-authority-transport-guard-v4'), 'package version is not the guarded version');`,
    `check(packageJson.includes('query-authority-transport-guard-v4'), 'package version lost the query-authority guard');`,
  ],
  [
    `check(appEpoch.includes("APP_VERSION = '2.0.115-query-authority-transport-guard-v4'"), 'runtime APP_VERSION was not bumped');`,
    `check(appEpoch.includes('query-authority-transport-guard-v4'), 'runtime APP_VERSION lost the query-authority guard');`,
  ],
  [
    `check(indexHtml.includes('2.0.115-query-authority-transport-guard-v4'), 'HTML build ID was not bumped');`,
    `check(indexHtml.includes('query-authority-transport-guard-v4'), 'HTML build ID lost the query-authority guard');`,
  ],
  [
    `check(vite.includes('v44-query-authority-transport-guard'), 'PWA cache generation was not bumped');`,
    `check(vite.includes('query-authority-transport-guard'), 'PWA cache generation lost the query-authority guard');`,
  ],
];

for (const [from, to] of replacements) {
  if (source.includes(to)) continue;
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`QUERY_AUTHORITY_COMPAT_EXPECTED_ONE_FOUND:${count}:${from}`);
  source = source.replace(from, to);
}

fs.writeFileSync(path, source, 'utf8');
console.log('PASS query-authority verifier accepts combined final version owners.');
