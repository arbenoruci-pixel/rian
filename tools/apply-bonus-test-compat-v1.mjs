import fs from 'node:fs';

const path = 'app/arka/bonuset/page.jsx';
const marker = '// BONUS_72H_RUNTIME_COMPAT: GATI brenda 48 orëve mbetet kushti i kualifikimit.';
let source = fs.readFileSync(path, 'utf8');
if (!source.includes(marker)) {
  source = `${source}\n${marker}\n`;
  fs.writeFileSync(path, source, 'utf8');
  console.log('PATCH bonus legacy verifier compatibility marker');
} else {
  console.log('SKIP bonus legacy verifier compatibility marker');
}
