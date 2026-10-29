import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { BONUS_EVIDENCE_BUCKET, BONUS_EVIDENCE_MAX_BYTES } from './baseBonusEvidence.js';

const messages = {
  BONUS_EVIDENCE_ALREADY_EARNED: 'Bonusi për këtë porosi është fituar tashmë. Nuk nevojitet zgjatje +24 orë.',
  BONUS_EVIDENCE_DEADLINE_PASSED: 'Afati 72-orësh ka kaluar. Kërkesa duhet dorëzuar para tij.',
  BONUS_EVIDENCE_READY_REQUIRED: 'Porosia duhet të jetë GATI para se të kërkosh zgjatje.',
  BONUS_EVIDENCE_SHELF_REQUIRED: 'Zgjedhe raftin ku janë tepihat.',
  BONUS_EVIDENCE_TWO_PHOTOS_REQUIRED: 'Ngarko foton e tepihave dhe screenshot-in e mesazhit.',
  BONUS_EVIDENCE_DIFFERENT_PHOTOS_REQUIRED: 'Fotoja e tepihave dhe screenshot-i duhet të jenë dy prova të ndryshme.',
  BONUS_EVIDENCE_SESSION_CHANGED: 'Sesioni ka ndryshuar. Hape përsëri faqen.',
  BONUS_EVIDENCE_REVIEW_CONFLICT: 'Kjo kërkesë është shqyrtuar tashmë. Rifresko listën.',
  BONUS_EVIDENCE_REJECT_REASON_REQUIRED: 'Shkruaje arsyen e refuzimit.',
  BONUS_EVIDENCE_REVIEW_CHECKS_REQUIRED: 'Kontrollo foton me kodin dhe mesazhin e klientit.',
  BONUS_EVIDENCE_IMAGE_INVALID: 'Fotoja nuk mund të lexohet. Zgjidh një foto tjetër.',
  BONUS_EVIDENCE_FORBIDDEN: 'Kjo mundësi është vetëm për Bujarin dhe dispeçerin.',
  BONUS_EVIDENCE_IMAGE_SIZE: 'Fotoja është tepër e madhe. Provo një foto tjetër.',
};
export async function bonusEvidenceRequest(body, { fetchImpl = globalThis.fetch, actor = getActor() } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Për dorëzimin e provave duhet internet. Fotot ende nuk janë dërguar.');
  const response = await fetchImpl('/api/base-bonus-evidence', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, expectedActorId: actor?.id || actor?.user_id || '' }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    const error = new Error(messages[result.error] || `Kërkesa nuk u krye (${result.error || response.status}). Provo përsëri.`);
    error.code = result.error;
    throw error;
  }
  return result;
}

export async function compressBonusEvidenceImage(file) {
  if (!file || file.size > 25 * 1024 * 1024) throw new Error('Zgjedh një foto më të vogël se 25 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('Kjo foto nuk lexohet. Provo JPG ose screenshot.')); img.src = url; });
    const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.78, 0.65]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= BONUS_EVIDENCE_MAX_BYTES) return blob;
    }
    throw new Error('Fotoja është tepër e madhe. Provo një pamje më të afërt.');
  } finally { URL.revokeObjectURL(url); }
}

export async function submitBonusEvidence({ orderId, shelf, carpet, message, onProgress = () => {}, onUploaded = () => {} }) {
  onProgress('Duke përgatitur kërkesën…');
  const prepared = await bonusEvidenceRequest({ action: 'PREPARE', orderId, shelf });
  if (prepared.request.status !== 'DRAFT') return prepared;
  for (const upload of prepared.uploads) {
    const file = upload.kind === 'carpet' ? carpet : message;
    if (!file) throw new Error('Mungon njëra foto. Zgjedhe dhe provo përsëri.');
    if (upload.exists) {
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== upload.hash) throw new Error('Ka një foto të ruajtur nga tentativa e kaluar. Mbylle dhe hape kërkesën për t’i parë provat e ruajtura.');
      onUploaded(upload.kind); continue;
    }
    onProgress(upload.kind === 'carpet' ? 'Duke ngarkuar foton e tepihave…' : 'Duke ngarkuar screenshot-in…');
    const { error } = await supabase.storage.from(BONUS_EVIDENCE_BUCKET).uploadToSignedUrl(upload.path, upload.token, file, { contentType: 'image/jpeg', upsert: false });
    if (error) throw new Error('Ngarkimi nuk u konfirmua. Provo Submit përsëri; fotot e ruajtura nuk ngarkohen dy herë.');
    onUploaded(upload.kind);
  }
  onProgress('Duke dorëzuar provat te dispeçeri…');
  const result = await bonusEvidenceRequest({ action: 'SUBMIT', requestId: prepared.request.id });
  window.dispatchEvent(new CustomEvent('base-ready-bonus:refresh'));
  return result;
}
