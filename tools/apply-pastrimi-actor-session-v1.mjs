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
    // ${marker}: package scans must use the active canonical session first.
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

const oldReadyWorkerBlock = `      try { readyBonusWorker = getActor?.() || null; } catch {}
      if (!readyBonusWorker?.pin) {
        alert('MUNGON SESIONI I PËRDORUESIT. HYR PËRSËRI PARA SE TA BËSH GATI.');
        if (btn) { btn.disabled = false; btn.innerText = 'GATI'; }
        return;
      }`;

const newReadyWorkerBlock = `      // ${marker}: use the logged-in worker; if iOS lost the session copy,
      // recover safely with the existing validated worker-PIN flow instead of
      // blocking a fully packed order at the final rack step.
      try { readyBonusWorker = getActor() || null; } catch { readyBonusWorker = null; }
      if (!readyBonusWorker?.pin) {
        try {
          readyBonusWorker = await resolveBaseReadyBonusWorker({
            label: 'SESIONI U HUMB. JEP PIN-IN E PUNËTORIT QË E PËRFUNDOI DHE E PAKETOI KËTË POROSI',
            forcePrompt: true,
          });
        } catch {
          readyBonusWorker = null;
        }
      }
      if (!readyBonusWorker?.pin) {
        if (btn) { btn.disabled = false; btn.innerText = 'GATI'; }
        return;
      }`;

source = replaceOnce(
  source,
  oldReadyWorkerBlock,
  newReadyWorkerBlock,
  'Pastrimi GATI session recovery',
);

source = source.replace(
  `      try { actor = getActor?.(); } catch {}`,
  `      try { actor = getActor() || null; } catch { actor = null; }`,
);

fs.writeFileSync(targetPath, source, 'utf8');

const after = fs.readFileSync(targetPath, 'utf8');
const required = [
  importLine,
  marker,
  'try { actor = getActor() || null; } catch {}',
  'readyBonusWorker = await resolveBaseReadyBonusWorker({',
  'forcePrompt: true',
  "try { actor = getActor() || null; } catch { actor = null; }",
];

for (const token of required) {
  if (!after.includes(token)) throw new Error(`PASTRIMI_ACTOR_SESSION_PATCH_MISSING:${token}`);
}

if (after.includes('getActor?.()')) {
  throw new Error('PASTRIMI_STILL_USES_UNBOUND_OPTIONAL_GETACTOR');
}
if (after.includes('MUNGON SESIONI I PËRDORUESIT. HYR PËRSËRI PARA SE TA BËSH GATI.')) {
  throw new Error('PASTRIMI_STILL_BLOCKS_PACKED_ORDER_ON_SESSION_COPY');
}

console.log('PASS Pastrimi resolves the active actor and recovers a lost iOS session with validated PIN');
