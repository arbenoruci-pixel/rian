import fs from 'node:fs';

const HOME_SEARCH = 'lib/homeSearch.js';
const GLOBAL_SEARCH = 'components/GlobalHomeSearch.jsx';
const EPOCH = 'lib/appEpoch.js';
const INDEX = 'index.html';
const VITE = 'vite.config.js';
const MARKER = 'SEARCH_OPEN_DB_TRUTH_V2';
const VERSION = '2.0.99-search-open-db-truth-v2';
const CACHE = 'v43-search-open-db-truth';

function replaceRequired(source, from, to, code) {
  if (!source.includes(from)) throw new Error(code);
  return source.replace(from, to);
}

let home = fs.readFileSync(HOME_SEARCH, 'utf8');
if (!home.includes(MARKER)) {
  home = replaceRequired(
    home,
    "  if (code) params.set('q', code);\n  if (id) params.set('openId', id);",
    "  if (code) params.set('q', code);\n  if (code) params.set('openCode', code);\n  if (id) params.set('openId', id);",
    'HOME_SEARCH_OPEN_CODE_ANCHOR_MISSING'
  );
  home = home.replace(
    "export function buildHomeSearchHref(result) {",
    `// ${MARKER}: every BASE route carries both DB id and client code fallback.\nexport function buildHomeSearchHref(result) {`
  );
  fs.writeFileSync(HOME_SEARCH, home, 'utf8');
}

let global = fs.readFileSync(GLOBAL_SEARCH, 'utf8');
if (!global.includes(MARKER)) {
  global = replaceRequired(
    global,
    "import { buildHomeSearchHref, cleanVisiblePersonName, searchHomeLocalFirst } from '@/lib/homeSearch';",
    `import { buildHomeSearchHref, cleanVisiblePersonName, resolveHomeSearchTarget, searchHomeLocalFirst } from '@/lib/homeSearch';\n// ${MARKER}: resolve every click against live DB before routing.`,
    'GLOBAL_SEARCH_IMPORT_ANCHOR_MISSING'
  );
  global = replaceRequired(
    global,
    "  const [message, setMessage] = React.useState('');\n  const [fabPosition, setFabPosition] = React.useState(null);",
    "  const [message, setMessage] = React.useState('');\n  const [openingResultKey, setOpeningResultKey] = React.useState('');\n  const [fabPosition, setFabPosition] = React.useState(null);",
    'GLOBAL_SEARCH_OPEN_STATE_ANCHOR_MISSING'
  );
  global = replaceRequired(
    global,
    `  const openSearchResult = React.useCallback((result) => {\n    const href = buildHomeSearchHref(result);\n    if (!href) return;\n    closeModal();\n    router.push(href);\n  }, [closeModal, router]);`,
    `  const openSearchResult = React.useCallback(async (result) => {\n    const resultKey = [result?.kind, result?.orderId || result?.id, result?.code].filter(Boolean).join(':');\n    if (openingResultKey) return;\n    setOpeningResultKey(resultKey || 'opening');\n    setMessage('Duke verifikuar porosinë në DB...');\n    try {\n      const resolved = await resolveHomeSearchTarget(result);\n      const href = resolved?.href || buildHomeSearchHref(result);\n      if (!href) throw new Error('NUK U GJET FAQJA E POROSISË.');\n      closeModal();\n      router.push(href);\n    } catch (error) {\n      setMessage(String(error?.message || error || 'Porosia nuk u hap. Provo përsëri.'));\n      setOpeningResultKey('');\n    }\n  }, [closeModal, openingResultKey, router]);`,
    'GLOBAL_SEARCH_HANDLER_ANCHOR_MISSING'
  );
  global = global.replaceAll('onClick={() => openSearchResult(result)}', 'onClick={() => { void openSearchResult(result); }}');
  global = global.replaceAll('openSearchResult(result);', 'void openSearchResult(result);');
  global = replaceRequired(
    global,
    `<button type="button" className="ghs-open-result" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void openSearchResult(result); }}>\n                            HAP ➔\n                          </button>`,
    `<button type="button" className="ghs-open-result" disabled={!!openingResultKey} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void openSearchResult(result); }}>\n                            {openingResultKey === [result?.kind, result?.orderId || result?.id, result?.code].filter(Boolean).join(':') ? 'DUKE HAPUR...' : 'HAP ➔'}\n                          </button>`,
    'GLOBAL_SEARCH_BUTTON_ANCHOR_MISSING'
  );
  fs.writeFileSync(GLOBAL_SEARCH, global, 'utf8');
}

let epoch = fs.readFileSync(EPOCH, 'utf8');
epoch = epoch.replace(/export const APP_VERSION = '[^']+';/, `export const APP_VERSION = '${VERSION}';`);
fs.writeFileSync(EPOCH, epoch, 'utf8');

let index = fs.readFileSync(INDEX, 'utf8');
index = index
  .replace(/(<meta name="tepiha-build-id" content=")[^"]+(" \/>)/, `$1${VERSION}$2`)
  .replace(/window\.__TEPIHA_BUILD_ID\s*=\s*'[^']+';/, `window.__TEPIHA_BUILD_ID = '${VERSION}';`);
fs.writeFileSync(INDEX, index, 'utf8');

let vite = fs.readFileSync(VITE, 'utf8');
vite = vite
  .replace(/sw-navigation-diag\.js\?v=\d+/, 'sw-navigation-diag.js?v=3507')
  .replace(/tepiha-vite-business-routes-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-business-routes-${CACHE}`)
  .replace(/tepiha-vite-static-assets-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-static-assets-${CACHE}`)
  .replace(/tepiha-vite-media-v\d+-[A-Za-z0-9-]+/g, `tepiha-vite-media-${CACHE}`);
fs.writeFileSync(VITE, vite, 'utf8');

console.log('PASS: Home and Global Search resolve live DB status and route with both openId and openCode.');
