import fs from 'node:fs';

const PATH = 'app/pastrimi/page.jsx';
const MARKER = 'PASTRIMI_PAKETIMI_TIMEOUT_RETRY_V1';
let src = fs.readFileSync(PATH, 'utf8');
if (src.includes(MARKER)) process.exit(0);

const old = `    try {
      await updateOrderData(table, paketimiOrder.id, (oldData) => {
        const safeOld = unwrapOrderData(oldData || {});
        savedData = { ...safeOld, paketimi_v1: cleanDraft };
        return savedData;
      }, { updated_at: now });
      setPaketimiDraft(cleanDraft);`;

const next = `    try {
      // ${MARKER}
      // Paketimi is a critical worker action. A transient mobile/Supabase timeout
      // must not make the worker restart a 20+ piece scan. Retry the exact same
      // idempotent JSON merge, then verify DB truth before reporting failure.
      const writePaketimi = async () => updateOrderData(table, paketimiOrder.id, (oldData) => {
        const safeOld = unwrapOrderData(oldData || {});
        savedData = { ...safeOld, paketimi_v1: cleanDraft };
        return savedData;
      }, { updated_at: now });

      let writeError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await writePaketimi();
          writeError = null;
          break;
        } catch (error) {
          writeError = error;
          const message = String(error?.message || error || '');
          const retryable = /SUPABASE_TIMEOUT|timeout|network|fetch/i.test(message);
          if (!retryable || attempt >= 3) break;
          await new Promise((resolve) => setTimeout(resolve, attempt * 650));
        }
      }

      if (writeError) {
        let verified = null;
        try {
          verified = await fetchOrderByIdSafe(table, paketimiOrder.id, 'id,data,updated_at', { timeoutMs: 9000 });
        } catch {}
        const verifiedDraft = unwrapOrderData(verified?.data || {})?.paketimi_v1;
        const wantedStatus = String(cleanDraft?.status || '');
        const verifiedStatus = String(verifiedDraft?.status || '');
        const wantedFound = Array.isArray(cleanDraft?.pieces) ? cleanDraft.pieces.filter((piece) => piece?.found).length : 0;
        const verifiedFound = Array.isArray(verifiedDraft?.pieces) ? verifiedDraft.pieces.filter((piece) => piece?.found).length : 0;
        if (verifiedDraft && verifiedStatus === wantedStatus && verifiedFound >= wantedFound) {
          savedData = unwrapOrderData(verified?.data || {});
        } else {
          throw writeError;
        }
      }
      setPaketimiDraft(cleanDraft);`;

if (!src.includes(old)) throw new Error('persistPaketimi write block not found');
src = src.replace(old, next);
fs.writeFileSync(PATH, src, 'utf8');
if (!fs.readFileSync(PATH, 'utf8').includes(MARKER)) throw new Error('marker missing');
console.log('PASS Pastrimi paketimi timeout retry installed');
