import fs from 'node:fs';

const targetPath = 'app/transport/board/modules/inbox.jsx';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) {
    console.log(`SKIP ${label}: already patched`);
    return source;
  }

  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected one match, found ${count}`);
  }

  console.log(`PATCH ${label}`);
  return source.replace(oldText, newText);
}

const original = fs.readFileSync(targetPath, 'utf8');
let next = original;

next = replaceOnce(
  next,
  "import { buildSmsLink, buildTransportConfirmUrl } from '@/lib/smartSms';",
  "import { buildSmsLink, buildTransportConfirmUrl, canonicalizePhone } from '@/lib/smartSms';",
  'transport inbox canonical phone import',
);

const oldTelBlock = [
  'function buildTelHref(phone) {',
  '  const clean = normalizePhone(phone);',
  "  return clean ? `tel:${clean}` : '';",
  '}',
].join('\n');

const newTelBlock = [
  'function buildTelHref(phone) {',
  '  const clean = canonicalizePhone(phone);',
  "  return clean ? `tel:${clean}` : '';",
  '}',
].join('\n');

next = replaceOnce(
  next,
  oldTelBlock,
  newTelBlock,
  'transport inbox call canonicalization',
);

if (next !== original) {
  fs.writeFileSync(targetPath, next, 'utf8');
}

const after = fs.readFileSync(targetPath, 'utf8');
if (!after.includes("import { buildSmsLink, buildTransportConfirmUrl, canonicalizePhone } from '@/lib/smartSms';")) {
  throw new Error('transport inbox canonical phone import is missing');
}
if (!after.includes('const clean = canonicalizePhone(phone);')) {
  throw new Error('transport inbox call still does not canonicalize the phone number');
}
if (after.includes('function buildTelHref(phone) {\n  const clean = normalizePhone(phone);')) {
  throw new Error('transport inbox call still uses the raw phone number');
}

console.log('PASS transport inbox call uses a canonical +country phone number');
