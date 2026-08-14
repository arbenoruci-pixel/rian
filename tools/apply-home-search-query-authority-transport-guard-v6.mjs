import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = 'tools/apply-home-search-query-authority-transport-guard-v4.mjs';
const tempPath = 'tools/.tmp-apply-home-search-query-authority-transport-guard-v6.mjs';
let source = fs.readFileSync(sourcePath, 'utf8');

const replacements = [
  [
    "  return `${baseStatusRoute(order?.status)}?${params.toString()}`;",
    "  return baseStatusRoute(order?.status) + '?' + params.toString();",
  ],
  [
    "\"source: 'db-live-query-authority'\"",
    "\"'db-live-query-authority'\"",
  ],
];

for (const [from, to] of replacements) {
  if (!source.includes(from)) throw new Error(`QUERY_AUTHORITY_V6_ANCHOR_MISSING:${from}`);
  source = source.replace(from, to);
}

fs.writeFileSync(tempPath, source, 'utf8');
try {
  await import(`${pathToFileURL(tempPath).href}?v=${Date.now()}`);
} finally {
  try { fs.unlinkSync(tempPath); } catch {}
}

console.log('PASS query-authority installer executed with valid nested templates and source verification');
