import fs from 'node:fs';

const targetPath = 'app/pastrimi/page.jsx';
const marker = 'PASTRIMI_ACTOR_SESSION_V1';
const importLine = "import { getActor } from '@/lib/actorSession';";

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

let source = fs.readFileSync(targetPath, 'utf8');

if (!source.includes(importLine)) {
  const importAnchor = "import { listUsers } from '@/lib/usersDb';";
  if (!source.includes(importAnchor)) throw new Error('PASTRIMI_ACTOR_IMPORT_ANCHOR_NOT_FOUND');
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
  console.log('PATCH Pastrimi canonical actor import');
} else {
  console.log('SKIP Pastrimi canonical actor import: already patched');
}

const oldPackagingActor = `  function readPaketimiActorLabel(order = null) {
    const actor = readPastrimiResolveActor(order || paketimiOrder || {});
    return String(actor?.name || actor?.pin || 'PUNËTOR').trim() || 'PUNËTOR';
  }`;

const newPackagingActor = `  function readPaketimiActorLabel(order = null) {
    // ${marker}: package scans use the same canonical actor/session as GATI.
    let actor = null;
    try { actor = getActor() || null; } catch {}
    if (!actor?.pin && !actor?.name) {
      actor = readPastrimiResolveActor(order || paketimiOrder || {});
    }
    return String(actor?.name || actor?.pin || 'PUNËTOR').trim() || 'PUNËTOR';
  }`;

source = replaceOnce(
  source,
  oldPackagingActor,
  newPackagingActor,
  'Pastrimi package actor resolution',
);

const oldStageActorLine = `      try { readyBonusWorker = getActor?.() || null; } catch {}`;
const newStageActorLine = `      // ${marker}: getActor is imported from actorSession; this preserves the
      // payment-owner bonus contract and removes the false missing-session error.
      try { readyBonusWorker = getActor?.() || null; } catch {}`;

source = replaceOnce(
  source,
  oldStageActorLine,
  newStageActorLine,
  'Pastrimi GATI bound actor session',
);

fs.writeFileSync(targetPath, source, 'utf8');

const after = fs.readFileSync(targetPath, 'utf8');
const required = [
  importLine,
  marker,
  'try { actor = getActor() || null; } catch {}',
  'readyBonusWorker = getActor?.() || null',
  'MUNGON SESIONI I PËRDORUESIT. HYR PËRSËRI PARA SE TA BËSH GATI.',
];

for (const token of required) {
  if (!after.includes(token)) throw new Error(`PASTRIMI_ACTOR_SESSION_PATCH_MISSING:${token}`);
}

const importCount = after.split(importLine).length - 1;
if (importCount !== 1) throw new Error(`PASTRIMI_ACTOR_IMPORT_COUNT_${importCount}`);

console.log('PASS Pastrimi GATI uses the bound canonical actor session without changing bonus ownership');
