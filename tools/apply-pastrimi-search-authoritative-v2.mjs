import fs from 'node:fs';

const PATH = 'app/pastrimi/page.jsx';
const MARKER = 'PASTRIMI_SEARCH_AUTHORITATIVE_V2';
let source = fs.readFileSync(PATH, 'utf8');

if (source.includes(MARKER)) {
  console.log('[pastrimi-search-authoritative-v2] already installed');
  process.exit(0);
}
if (!source.includes('PASTRIMI_SEARCH_STICKY_V1')) {
  throw new Error('PASTRIMI_SEARCH_STICKY_V1_REQUIRED');
}

function replaceOnce(oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  source = source.replace(oldText, newText);
  console.log(`PATCH ${label}`);
}

replaceOnce(
`  const openId = String(sp?.get('openId') || '').trim();
  const fromSearch = String(sp?.get('from') || '').trim() === 'search';
  const exactSearchMode = !!openId && (exactMode || fromSearch);`,
`  const openId = String(sp?.get('openId') || '').trim();
  const openCode = String(sp?.get('openCode') || sp?.get('code') || '').trim();
  const fromSearch = String(sp?.get('from') || '').trim() === 'search';
  const exactSearchMode = !!openId && (exactMode || fromSearch);`,
'capture permanent code from Home search route'
);

replaceOnce(
`  const [search, setSearch] = useState('');`,
`  const [search, setSearch] = useState(() => openCode);`,
'seed Pastrimi search from openCode'
);

replaceOnce(
`  const [, startListTransition] = useTransition();`,
`  const [, startListTransition] = useTransition();

  useEffect(() => {
    if (!openCode) return;
    setSearch((current) => String(current || '').trim() ? current : openCode);
    setPastrimFilter('all');
  }, [openCode]);`,
'keep route code synchronized without clearing typed search'
);

replaceOnce(
`    if (exactSearchMode && exactSearchTimedOut) {
      return list;
    }`,
`    // ${MARKER}
    // Home search opens this route with openId/openCode. The previous timeout
    // fallback returned the whole 60+ row list and ignored the visible query,
    // which made the exact row flash briefly and then disappear. A live query
    // must fall through to the normal text/code/phone filter.
    if (exactSearchMode && exactSearchTimedOut && !String(search || openCode || '').trim()) {
      return list;
    }`,
'exact-search timeout respects visible query'
);

replaceOnce(
`    const rawSearch = String(search || '');`,
`    const rawSearch = String(search || openCode || '');`,
'normal search falls back to route code'
);

replaceOnce(
`  }, [orders, exactSearchMode, exactSearchTimedOut, exactRecoveredRow, openId, search]);`,
`  }, [orders, exactSearchMode, exactSearchTimedOut, exactRecoveredRow, openId, openCode, search]);`,
'visible search depends on route code'
);

replaceOnce(
`  const displayOrders = useMemo(() => {
    const list = Array.isArray(visibleOrders) ? visibleOrders : [];
    // A typed search is authoritative. Do not let a previously selected quick
    // filter hide the exact code/name/phone the worker is trying to act on.
    if (String(search || '').trim()) return list;
    if (!pastrimFilter || pastrimFilter === 'all') return list;
    return list.filter((row) => matchesPastrimFilter(row, pastrimFilter));
  }, [visibleOrders, pastrimFilter, search]);`,
`  const displayOrders = useMemo(() => {
    const list = Array.isArray(visibleOrders) ? visibleOrders : [];
    const rawSearch = String(search || openCode || '').trim();

    // Final-render safety gate. Even if an exact-open recovery timer returns
    // the full DB list, the rows painted on screen are filtered again from the
    // controlled input value. This keeps code 872 as the only visible result.
    if (rawSearch) {
      const textQuery = rawSearch.toLowerCase();
      const compactCodeQuery = rawSearch.replace(/\\s+/g, '').toUpperCase();
      const digitsQuery = rawSearch.replace(/\\D+/g, '');
      return list.filter((row) => {
        const order = unwrapOrderData(row?.fullOrder || row?.data || row || {});
        const name = String(row?.name || row?.client_name || order?.client_name || order?.client?.name || '').toLowerCase();
        if (name.includes(textQuery)) return true;

        const codeCandidates = [
          row?.code,
          row?.client_tcode,
          row?.code_str,
          row?.order_code,
          order?.code,
          order?.client_tcode,
          order?.code_str,
          order?.order_code,
          order?.client?.code,
          order?.client?.tcode,
        ].map((value) => String(value ?? '').trim().replace(/\\s+/g, '').toUpperCase()).filter(Boolean);

        if (compactCodeQuery && codeCandidates.some((code) => code === compactCodeQuery || code.includes(compactCodeQuery))) return true;
        if (digitsQuery && codeCandidates.some((code) => code.replace(/\\D+/g, '').includes(digitsQuery))) return true;

        if (digitsQuery) {
          const phoneDigits = String(
            row?.phone || row?.client_phone || order?.client_phone || order?.client?.phone || ''
          ).replace(/\\D+/g, '');
          if (phoneDigits && phoneDigits.includes(digitsQuery)) return true;
        }
        return false;
      });
    }

    if (!pastrimFilter || pastrimFilter === 'all') return list;
    return list.filter((row) => matchesPastrimFilter(row, pastrimFilter));
  }, [visibleOrders, pastrimFilter, search, openCode]);`,
'final rendered rows enforce current query'
);

replaceOnce(
`        onChange={e => {
          const nextSearch = e.target.value;
          setSearch(nextSearch);
          if (String(nextSearch || '').trim()) setPastrimFilter('all');
        }}
      />`,
`        inputMode="search"
        autoComplete="off"
        onInput={e => {
          const nextSearch = e.currentTarget.value;
          setSearch(nextSearch);
          if (String(nextSearch || '').trim()) setPastrimFilter('all');
        }}
        onChange={e => {
          const nextSearch = e.currentTarget.value;
          setSearch(nextSearch);
          if (String(nextSearch || '').trim()) setPastrimFilter('all');
        }}
      />`,
'iOS input event always updates controlled search'
);

fs.writeFileSync(PATH, source, 'utf8');
const out = fs.readFileSync(PATH, 'utf8');
for (const token of [
  MARKER,
  "const openCode = String(sp?.get('openCode')",
  'useState(() => openCode)',
  "exactSearchTimedOut && !String(search || openCode || '').trim()",
  "const rawSearch = String(search || openCode || '').trim();",
  "code.replace(/\\D+/g, '').includes(digitsQuery)",
  'Final-render safety gate',
  'onInput={e => {',
]) {
  if (!out.includes(token)) throw new Error(`VERIFY_MISSING:${token}`);
}
console.log('PASS Pastrimi exact-open timeout and final render obey the current search query');
