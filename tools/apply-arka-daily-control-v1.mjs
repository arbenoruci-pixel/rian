import fs from 'node:fs';

const ARKA_PATH = 'app/arka/page.jsx';
const ROUTES_PATH = 'src/generated/routes.generated.jsx';
const MARKER = 'ARKA_DAILY_CONTROL_V1';

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function patchArka() {
  let source = fs.readFileSync(ARKA_PATH, 'utf8');
  if (source.includes(`${MARKER}:ARKA`)) return false;

  const anchor = `      {!loading && actor?.pin && canManage ? (\n        <>\n          <div className="arkaWorkerStats adminTopGrid ownerTotalsGrid">`;
  const replacement = `      {!loading && actor?.pin && canManage ? (\n        <>\n          {/* ${MARKER}:ARKA — read-only daily facts for DISPATCH. */}\n          <div className="arkaSectionCard" style={{ marginBottom: 14, display: 'grid', gap: 9, border: '1px solid rgba(59,130,246,.34)', background: 'linear-gradient(135deg,rgba(30,64,175,.22),rgba(15,23,42,.82))' }}>\n            <div className="arkaSectionHeadCompact">\n              <div>\n                <div className="arkaSectionTitle">KONTROLLI DITOR</div>\n                <div className="arkaSectionSub">HYRJE / DALJE M² • CASH • SHPENZIME • KOMISIONE • ALARME</div>\n              </div>\n              <Link\n                to="/arka/ditore"\n                className="arkaSolidBtn big"\n                style={{ textDecoration: 'none', textAlign: 'center', minWidth: 150 }}\n              >\n                HAPE PAMJEN DITORE\n              </Link>\n            </div>\n            <div className="arkaSimpleSub">Shifrat llogariten direkt nga DB dhe ruhen si snapshot vetem per lexim offline. Qasja eshte vetem DISPATCH.</div>\n          </div>\n\n          <div className="arkaWorkerStats adminTopGrid ownerTotalsGrid">`;

  source = replaceRequired(source, anchor, replacement, 'ARKA_MANAGER_DAILY_ENTRY');
  fs.writeFileSync(ARKA_PATH, source, 'utf8');
  return true;
}

function patchRoutes() {
  let source = fs.readFileSync(ROUTES_PATH, 'utf8');
  if (source.includes(`${MARKER}:ROUTES`)) return false;

  source = replaceRequired(
    source,
    `import ArkaStafiPageEager from '@/app/arka/stafi/page.jsx';`,
    `import ArkaStafiPageEager from '@/app/arka/stafi/page.jsx';\nimport ArkaDitorePageEager from '@/app/arka/ditore/page.jsx';\n// ${MARKER}:ROUTES`,
    'ROUTES_DAILY_IMPORT'
  );

  source = replaceRequired(
    source,
    `  { path: '/arka/obligimet', element: eagerElement(ArkaObligimetPageEager, '/arka/obligimet') },`,
    `  { path: '/arka/ditore', element: eagerElement(ArkaDitorePageEager, '/arka/ditore') },\n  { path: '/arka/obligimet', element: eagerElement(ArkaObligimetPageEager, '/arka/obligimet') },`,
    'ROUTES_DAILY_ROUTE'
  );

  fs.writeFileSync(ROUTES_PATH, source, 'utf8');
  return true;
}

const changed = [patchArka(), patchRoutes()].some(Boolean);
console.log(`[arka-daily-control-v1] ${changed ? 'installed' : 'already installed'}`);
