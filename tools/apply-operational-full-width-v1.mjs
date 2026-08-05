import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const marker = 'OPERATIONAL_FULL_WIDTH_V1';

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
  fs.writeFileSync(path.join(root, rel), content, 'utf8');
}

function patchFile(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { rel, changed: false, missing: true };
  const before = read(rel);
  let after = before;

  // CSS-in-JS shells used by operational pages.
  after = after.replace(/width:min\((?:7\d\d|8\d\d|9\d\d|1\d\d\d)px,100%\);margin:0 auto/g, 'width:100%;max-width:none;margin:0');
  after = after.replace(/width:\s*'min\((?:7\d\d|8\d\d|9\d\d|1\d\d\d)px,100%\)'\s*,\s*margin:\s*'0 auto'/g, "width: '100%', maxWidth: 'none', margin: '0'");
  after = after.replace(/width:\s*"min\((?:7\d\d|8\d\d|9\d\d|1\d\d\d)px,100%\)"\s*,\s*margin:\s*"0 auto"/g, 'width: "100%", maxWidth: "none", margin: "0"');

  if (after !== before) {
    write(rel, after);
    return { rel, changed: true };
  }
  return { rel, changed: false };
}

const pages = [
  'app/arka/page.jsx',
  'app/arka/bonuset/page.jsx',
  'app/arka/ditore/page.jsx',
  'app/arka/kapaku/page.jsx',
  'app/arka/obligimet/page.jsx',
  'app/arka/payroll/page.jsx',
  'app/arka/stafi/page.jsx',
  'app/arka/puntor/[pin]/page.jsx',
  'app/gati/page.jsx',
  'app/dispatch/page.jsx',
  'app/pranimi/page.jsx',
  'app/marrje-sot/page.jsx',
  'app/transport/menu/page.jsx',
  'app/transport/pranimi/page.jsx',
  'app/transport/fletore/page.jsx',
  'app/transport/item/page.jsx',
  'app/transport/pay/page.jsx',
  'app/transport/ngarkim-sot/page.jsx',
];

const results = pages.map(patchFile);

const cssPath = 'app/arka/arka.css';
if (fs.existsSync(path.join(root, cssPath))) {
  const before = read(cssPath);
  if (!before.includes(marker)) {
    const addition = `\n\n/* ${marker} */\n.arka-container{width:100%;max-width:none;margin:0;padding-left:8px;padding-right:8px}\n@media(max-width:1100px){\n  .arka-container{width:100%!important;max-width:none!important;margin:0!important;padding-left:8px!important;padding-right:8px!important}\n  .bonusShell{width:100%!important;max-width:none!important;margin-left:0!important;margin-right:0!important}\n}\n`;
    write(cssPath, before + addition);
    results.push({ rel: cssPath, changed: true });
  }
}

console.log(marker, results);
