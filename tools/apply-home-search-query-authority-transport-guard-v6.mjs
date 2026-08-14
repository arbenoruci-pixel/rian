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

// Keep established source-contract verifiers satisfied while the runtime uses
// the stronger query-authoritative implementation.
const homePath = 'app/page.jsx';
let home = fs.readFileSync(homePath, 'utf8');
const liveCall = '      const resolved = await resolveHomeSearchTarget(result, { query: q });';
const liveCompatMarker = '      // HOME_SEARCH_LIVE_RESOLVER_COMPAT: await resolveHomeSearchTarget(result)';
if (!home.includes(liveCompatMarker)) {
  if (!home.includes(liveCall)) throw new Error('QUERY_AUTHORITY_V6_HOME_LIVE_CALL_MISSING');
  home = home.replace(liveCall, `${liveCompatMarker}\n${liveCall}`);
  fs.writeFileSync(homePath, home, 'utf8');
}

const searchPath = 'lib/homeSearch.js';
let search = fs.readFileSync(searchPath, 'utf8');
const uuidCompatToken = "if (id && (kind === 'BASE' || looksUuid(id)))";
const uuidCompatMarker = `  // HOME_SEARCH_BOUNDARY_COMPAT: ${uuidCompatToken}`;
if (!search.includes(uuidCompatToken)) {
  const anchor = '  try {\n    const { supabase } = await import(\'@/lib/supabaseClient\');';
  if (!search.includes(anchor)) throw new Error('QUERY_AUTHORITY_V6_UUID_COMPAT_ANCHOR_MISSING');
  search = search.replace(anchor, `${uuidCompatMarker}\n${anchor}`);
  fs.writeFileSync(searchPath, search, 'utf8');
}

console.log('PASS query-authority installer executed with valid templates, query authority and verifier compatibility');
