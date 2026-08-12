import fs from 'node:fs';

const PATH = 'app/pastrimi/page.jsx';
const MARKER = 'PASTRIMI_SEARCH_STICKY_V1';
let source = fs.readFileSync(PATH, 'utf8');

if (source.includes(MARKER)) {
  console.log('[pastrimi-search-sticky-v1] already installed');
  process.exit(0);
}

function replaceOnce(oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  source = source.replace(oldText, newText);
  console.log(`PATCH ${label}`);
}

replaceOnce(
`    const rawSearch = String(deferredSearch || '');`,
`    // ${MARKER}\n    // Search must react immediately. useDeferredValue can leave the old 60+ row\n    // list painted for seconds on slower phones, which makes the matching row\n    // flash in/out while background refreshes are running.\n    const rawSearch = String(search || '');`,
'immediate search value'
);

replaceOnce(
`  }, [orders, exactSearchMode, exactSearchTimedOut, exactRecoveredRow, openId, deferredSearch]);`,
`  }, [orders, exactSearchMode, exactSearchTimedOut, exactRecoveredRow, openId, search]);`,
'immediate search dependency'
);

replaceOnce(
`  const displayOrders = useMemo(() => {\n    const list = Array.isArray(visibleOrders) ? visibleOrders : [];\n    if (!pastrimFilter || pastrimFilter === 'all') return list;\n    return list.filter((row) => matchesPastrimFilter(row, pastrimFilter));\n  }, [visibleOrders, pastrimFilter]);`,
`  const displayOrders = useMemo(() => {\n    const list = Array.isArray(visibleOrders) ? visibleOrders : [];\n    // A typed search is authoritative. Do not let a previously selected quick\n    // filter hide the exact code/name/phone the worker is trying to act on.\n    if (String(search || '').trim()) return list;\n    if (!pastrimFilter || pastrimFilter === 'all') return list;\n    return list.filter((row) => matchesPastrimFilter(row, pastrimFilter));\n  }, [visibleOrders, pastrimFilter, search]);`,
'search bypasses quick filters'
);

replaceOnce(
`      <input className="input" placeholder="🔎 Kërko kodin, emrin ose telefonin" value={search} onChange={e => setSearch(e.target.value)} />`,
`      <input\n        className="input"\n        placeholder="🔎 Kërko kodin, emrin ose telefonin"\n        value={search}\n        onChange={e => {\n          const nextSearch = e.target.value;\n          setSearch(nextSearch);\n          if (String(nextSearch || '').trim()) setPastrimFilter('all');\n        }}\n      />`,
'search input clears competing filter'
);

fs.writeFileSync(PATH, source, 'utf8');
const out = fs.readFileSync(PATH, 'utf8');
for (const token of [
  MARKER,
  "const rawSearch = String(search || '');",
  "if (String(search || '').trim()) return list;",
  "if (String(nextSearch || '').trim()) setPastrimFilter('all');",
]) {
  if (!out.includes(token)) throw new Error(`VERIFY_MISSING:${token}`);
}
console.log('PASS Pastrimi search is immediate, sticky and authoritative');
