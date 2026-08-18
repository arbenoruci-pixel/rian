import fs from 'node:fs';

const path = 'tools/apply-transport-repeat-visit-v2.mjs';
let source = fs.readFileSync(path, 'utf8');

const boardOld = `function patchBoard() {\n  let source = fs.readFileSync(BOARD_PATH, 'utf8');`;
const boardNew = `function patchBoard() {\n  let source = fs.readFileSync(BOARD_PATH, 'utf8');\n  if (source.includes(\`\${MARKER}:BOARD\`)) return;`;
if (!source.includes(boardNew)) {
  if (!source.includes(boardOld)) throw new Error('patchBoard anchor missing');
  source = source.replace(boardOld, boardNew);
}

const inboxOld = `function patchInbox() {\n  let source = fs.readFileSync(INBOX_PATH, 'utf8');`;
const inboxNew = `function patchInbox() {\n  let source = fs.readFileSync(INBOX_PATH, 'utf8');\n  if (source.includes(\`\${MARKER}:INBOX\`)) return;`;
if (!source.includes(inboxNew)) {
  if (!source.includes(inboxOld)) throw new Error('patchInbox anchor missing');
  source = source.replace(inboxOld, inboxNew);
}

fs.writeFileSync(path, source, 'utf8');
console.log('PASS repeat-visit V2 installer idempotence fix');
