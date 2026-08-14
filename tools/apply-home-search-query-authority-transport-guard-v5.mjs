import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = 'tools/apply-home-search-query-authority-transport-guard-v4.mjs';
const tempPath = 'tools/.tmp-apply-home-search-query-authority-transport-guard-v5.mjs';
const broken = "  return `${baseStatusRoute(order?.status)}?${params.toString()}`;";
const fixed = "  return baseStatusRoute(order?.status) + '?' + params.toString();";

let source = fs.readFileSync(sourcePath, 'utf8');
if (!source.includes(broken)) {
  throw new Error('QUERY_AUTHORITY_V5_TEMPLATE_ANCHOR_MISSING');
}
source = source.replace(broken, fixed);
fs.writeFileSync(tempPath, source, 'utf8');

try {
  await import(`${pathToFileURL(tempPath).href}?v=${Date.now()}`);
} finally {
  try { fs.unlinkSync(tempPath); } catch {}
}

console.log('PASS query-authority installer template parsed and executed');
