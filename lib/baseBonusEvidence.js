export const BUJAR_USER_ID = '19d3ab97-2067-493a-aeb1-8a23572dc5f8';
export const BONUS_EVIDENCE_BUCKET = 'base-bonus-evidence';
export const BONUS_EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
export const BONUS_REVIEW_ROLES = ['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'];
export const BONUS_SHELVES = [
  ...Array.from({ length: 50 }, (_, i) => `A${i + 1}`),
  ...Array.from({ length: 20 }, (_, i) => `B${i + 1}`),
  ...['FURRA_POSHT', 'FURRA_NALT'].flatMap(room => Array.from({ length: 40 }, (_, i) => `${room}_A${i + 1}`)),
];
export const isBujar = actor => String(actor?.id || actor?.user_id || '') === BUJAR_USER_ID && actor?.is_active !== false;
export const canReviewBonusEvidence = actor => actor?.is_active !== false && BONUS_REVIEW_ROLES.includes(String(actor?.role || '').trim().toUpperCase());
export function evidenceStatusLabel(status) {
  return ({ DRAFT: 'Vazhdo kërkesën', PENDING: 'Në pritje të dispeçerit', APPROVED: '+24 orë të aprovuara', REJECTED: 'Kërkesa u refuzua', EXPIRED: 'Kërkesa ka skaduar', CANCELLED: 'Kërkesa u anulua' })[status] || status;
}
